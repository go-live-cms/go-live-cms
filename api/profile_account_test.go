package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
)

// Profile (#334): changing your email with a confirmation link, and signing out
// other devices, through the real router against the test database (skipped
// without one), like auth_flow_test.go.

// profileFlowServer is authFlowServer with a recording mailer and the background
// work (lookups, tokens, emails) run inline.
func profileFlowServer(t *testing.T, store db.Store) (*Server, *recordingMailer) {
	t.Helper()
	server := authFlowServer(t, store, nil)
	rec := &recordingMailer{}
	server.mailer = rec
	server.runInBackground = func(_, _ string, f func()) { f() }
	return server, rec
}

func bearer(access string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+access) }
}

func uniqueEmail(prefix string) string {
	return prefix + strings.ReplaceAll(uuid.NewString(), "-", "")[:12] + "@example.test"
}

func requestEmailChange(t *testing.T, server *Server, access, password, newEmail string) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/api/v1/users/me/email",
		gin.H{"current_password": password, "new_email": newEmail}, bearer(access))
}

func confirmEmail(t *testing.T, server *Server, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/api/v1/auth/email-change/confirm", gin.H{"token": token}, nil)
}

func emailOf(t *testing.T, store db.Store, userID int64) string {
	t.Helper()
	user, err := store.GetUser(context.Background(), userID)
	require.NoError(t, err)
	return user.Email
}

func TestEmailChangeFlow(t *testing.T) {
	store := authFlowStore(t)
	ctx := context.Background()

	t.Run("wrong or missing password: 403, nothing stored or sent", func(t *testing.T) {
		server, rec := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		access, _ := flowLogin(t, server, user)

		requireErrorCode(t, requestEmailChange(t, server, access, "not-the-password", uniqueEmail("new")), http.StatusForbidden, "current_password_incorrect")
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/users/me/email", gin.H{"new_email": uniqueEmail("new")}, bearer(access))
		require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())

		require.Empty(t, rec.messages())
		n, err := store.CountEmailChangeTokensSince(ctx, db.CountEmailChangeTokensSinceParams{UserID: user.ID, CreatedAt: time.Now().Add(-time.Hour)})
		require.NoError(t, err)
		require.Zero(t, n)
	})

	t.Run("a taken address gets the same answer and no email", func(t *testing.T) {
		server, rec := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		other := authFlowUser(t, store)
		access, _ := flowLogin(t, server, user)

		taken := requestEmailChange(t, server, access, authFlowPassword, other.Email)
		free := requestEmailChange(t, server, access, authFlowPassword, uniqueEmail("free"))
		require.Equal(t, http.StatusAccepted, taken.Code, taken.Body.String())
		require.Equal(t, http.StatusAccepted, free.Code, free.Body.String())
		require.JSONEq(t, free.Body.String(), taken.Body.String(), "a taken address must be indistinguishable")
		require.Equal(t, free.Header().Get("Content-Type"), taken.Header().Get("Content-Type"))

		// Only the free address got a link; the other account's owner got nothing.
		msgs := rec.messages()
		require.Len(t, msgs, 1)
		require.NotEqual(t, other.Email, msgs[0].To)
		require.Equal(t, other.Email, emailOf(t, store, other.ID))
	})

	t.Run("confirm, then the link is used up; the old address is told", func(t *testing.T) {
		server, rec := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		access, _ := flowLogin(t, server, user)
		newEmail := uniqueEmail("Moved.")

		recorder := requestEmailChange(t, server, access, authFlowPassword, newEmail)
		require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
		msgs := rec.messages()
		require.Len(t, msgs, 1)
		require.Equal(t, normEmail(newEmail), msgs[0].To, "the link goes to the new address, normalized")
		require.Equal(t, mailer.TemplateEmailChange, msgs[0].Template)
		require.Contains(t, msgs[0].Text, user.Username)
		token := tokenFromMail(t, msgs[0], confirmEmailPath)

		// Nothing changes until the link is used.
		require.Equal(t, user.Email, emailOf(t, store, user.ID))

		recorder = confirmEmail(t, server, token)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var body struct {
			Email string `json:"email"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, normEmail(newEmail), body.Email)
		require.Equal(t, normEmail(newEmail), emailOf(t, store, user.ID))

		msgs = rec.messages()
		require.Len(t, msgs, 2)
		require.Equal(t, user.Email, msgs[1].To, "the notice goes to the old address")
		require.Equal(t, mailer.TemplateEmailChanged, msgs[1].Template)
		require.Contains(t, msgs[1].Text, mailer.MaskEmail(normEmail(newEmail)))
		require.NotContains(t, msgs[1].Text, normEmail(newEmail), "the new address is masked")

		// Single use.
		requireErrorCode(t, confirmEmail(t, server, token), http.StatusBadRequest, "invalid_token")

		// The account still works: sessions weren't revoked, and the new email is
		// what GET /users/me shows.
		require.Equal(t, http.StatusOK, flowGetMe(server, access))
	})

	t.Run("an expired link does nothing", func(t *testing.T) {
		server, _ := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		token, hash, err := newAccountToken()
		require.NoError(t, err)
		_, err = store.CreateEmailChangeToken(ctx, db.CreateEmailChangeTokenParams{
			UserID:    user.ID,
			NewEmail:  uniqueEmail("late"),
			TokenHash: hash,
			ExpiresAt: time.Now().Add(-time.Minute),
		})
		require.NoError(t, err)

		requireErrorCode(t, confirmEmail(t, server, token), http.StatusBadRequest, "invalid_token")
		require.Equal(t, user.Email, emailOf(t, store, user.ID))
	})

	t.Run("malformed and unknown tokens look the same", func(t *testing.T) {
		server, _ := profileFlowServer(t, store)
		unknown, _, err := newAccountToken()
		require.NoError(t, err)
		requireErrorCode(t, confirmEmail(t, server, unknown), http.StatusBadRequest, "invalid_token")
		requireErrorCode(t, confirmEmail(t, server, "short"), http.StatusBadRequest, "invalid_token")
	})

	t.Run("a newer request ends the older link", func(t *testing.T) {
		server, rec := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		access, _ := flowLogin(t, server, user)

		require.Equal(t, http.StatusAccepted, requestEmailChange(t, server, access, authFlowPassword, uniqueEmail("first")).Code)
		require.Equal(t, http.StatusAccepted, requestEmailChange(t, server, access, authFlowPassword, uniqueEmail("second")).Code)
		msgs := rec.messages()
		require.Len(t, msgs, 2)
		first, second := tokenFromMail(t, msgs[0], confirmEmailPath), tokenFromMail(t, msgs[1], confirmEmailPath)

		requireErrorCode(t, confirmEmail(t, server, first), http.StatusBadRequest, "invalid_token")
		require.Equal(t, http.StatusOK, confirmEmail(t, server, second).Code)
		require.Equal(t, msgs[1].To, emailOf(t, store, user.ID))
	})

	t.Run("an address taken before the confirmation: 409, nothing changes", func(t *testing.T) {
		server, rec := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		access, _ := flowLogin(t, server, user)
		wanted := uniqueEmail("race")

		require.Equal(t, http.StatusAccepted, requestEmailChange(t, server, access, authFlowPassword, wanted).Code)
		token := tokenFromMail(t, rec.messages()[0], confirmEmailPath)

		hashed, err := util.HashPassword(authFlowPassword)
		require.NoError(t, err)
		_, err = store.CreateUser(ctx, db.CreateUserParams{
			Username: "race" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12], FullName: "Race Winner",
			Email: normEmail(wanted), HashedPassword: hashed, Role: RoleContributor,
		})
		require.NoError(t, err)

		requireErrorCode(t, confirmEmail(t, server, token), http.StatusConflict, "email_taken")
		require.Equal(t, user.Email, emailOf(t, store, user.ID))
	})

	t.Run("a password change ends a pending link", func(t *testing.T) {
		server, rec := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		access, _ := flowLogin(t, server, user)

		require.Equal(t, http.StatusAccepted, requestEmailChange(t, server, access, authFlowPassword, uniqueEmail("pending")).Code)
		token := tokenFromMail(t, rec.messages()[0], confirmEmailPath)

		recorder := doJSON(t, server, http.MethodPut, "/api/v1/users/"+strconv.FormatInt(user.ID, 10),
			gin.H{"current_password": authFlowPassword, "password": "a-brand-new-password-42"}, bearer(access))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

		requireErrorCode(t, confirmEmail(t, server, token), http.StatusBadRequest, "invalid_token")
		require.Equal(t, user.Email, emailOf(t, store, user.ID))
	})

	t.Run("your own address again: 400 same_email", func(t *testing.T) {
		server, rec := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		access, _ := flowLogin(t, server, user)
		requireErrorCode(t, requestEmailChange(t, server, access, authFlowPassword, strings.ToUpper(user.Email)), http.StatusBadRequest, "same_email")
		require.Empty(t, rec.messages())
	})

	t.Run("signed-in only", func(t *testing.T) {
		server, _ := profileFlowServer(t, store)
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/users/me/email", gin.H{"current_password": "x", "new_email": uniqueEmail("anon")}, nil)
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})
}

// withSession gives a request the access token and the refresh cookie of one
// browser.
func withSession(access string, cookie *http.Cookie) func(*http.Request) {
	return func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+access)
		if cookie != nil {
			r.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value})
		}
	}
}

func TestSignOutOtherDevices(t *testing.T) {
	store := authFlowStore(t)

	t.Run("keeps this browser and ends every other session", func(t *testing.T) {
		server, _ := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		accessA, cookieA := flowLogin(t, server, user)
		_, cookieB := flowLogin(t, server, user)
		_, cookieC := flowLogin(t, server, user)
		// B refreshes once, so its active session is a rotated successor.
		refreshed := flowRefresh(server, cookieB)
		require.Equal(t, http.StatusOK, refreshed.Code)
		cookieB = findRefreshCookie(t, refreshed, server.refreshCookieName())

		// The device list: three active sessions, this one marked.
		recorder := doJSON(t, server, http.MethodGet, "/api/v1/auth/sessions", nil, withSession(accessA, cookieA))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var list struct {
			Sessions   []DeviceSessionResponse `json:"sessions"`
			OtherCount int                     `json:"other_count"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &list))
		require.Len(t, list.Sessions, 3)
		require.Equal(t, 2, list.OtherCount)
		current := 0
		for _, s := range list.Sessions {
			if s.Current {
				current++
				require.Equal(t, sessionByToken(t, store, cookieA.Value).ID, s.ID)
			}
		}
		require.Equal(t, 1, current)
		require.NotContains(t, recorder.Body.String(), "client_ip", "no IPs outside debug")
		require.NotContains(t, recorder.Body.String(), "refresh_token")

		recorder = doJSON(t, server, http.MethodPost, "/api/v1/auth/sessions/sign-out-others", nil, withSession(accessA, cookieA))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.JSONEq(t, `{"signed_out": 2}`, recorder.Body.String())

		// The others can't refresh any more (blocked, not reuse: 401, not 409)...
		require.Equal(t, http.StatusUnauthorized, flowRefresh(server, cookieB).Code)
		require.Equal(t, http.StatusUnauthorized, flowRefresh(server, cookieC).Code)
		// ...and this browser carries on.
		require.Equal(t, http.StatusOK, flowRefresh(server, cookieA).Code)
		require.Equal(t, 1, activeSessions(userSessions(t, store, user.ID)))

		// Nothing left to sign out.
		recorder = doJSON(t, server, http.MethodGet, "/api/v1/auth/sessions", nil, withSession(accessA, nil))
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &list))
		require.Len(t, list.Sessions, 1)
	})

	t.Run("no cookie, a dead one, or someone else's: 409, nothing blocked", func(t *testing.T) {
		server, _ := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		stranger := authFlowUser(t, store)
		access, cookie := flowLogin(t, server, user)
		_, _ = flowLogin(t, server, user)
		_, strangerCookie := flowLogin(t, server, stranger)

		requireErrorCode(t, doJSON(t, server, http.MethodPost, "/api/v1/auth/sessions/sign-out-others", nil, withSession(access, nil)), http.StatusConflict, "session_not_active")
		requireErrorCode(t, doJSON(t, server, http.MethodPost, "/api/v1/auth/sessions/sign-out-others", nil, withSession(access, strangerCookie)), http.StatusConflict, "session_not_active")
		require.Equal(t, 2, activeSessions(userSessions(t, store, user.ID)))
		require.Equal(t, 1, activeSessions(userSessions(t, store, stranger.ID)))

		require.Equal(t, http.StatusOK, flowLogout(server, access, cookie).Code)
		requireErrorCode(t, doJSON(t, server, http.MethodPost, "/api/v1/auth/sessions/sign-out-others", nil, withSession(access, cookie)), http.StatusConflict, "session_not_active")
		require.Equal(t, 1, activeSessions(userSessions(t, store, user.ID)))
	})

	t.Run("signed-in only, and not cross-site", func(t *testing.T) {
		server, _ := profileFlowServer(t, store)
		user := authFlowUser(t, store)
		access, cookie := flowLogin(t, server, user)

		require.Equal(t, http.StatusUnauthorized, doJSON(t, server, http.MethodPost, "/api/v1/auth/sessions/sign-out-others", nil, withSession("", cookie)).Code)
		require.Equal(t, http.StatusUnauthorized, doJSON(t, server, http.MethodGet, "/api/v1/auth/sessions", nil, nil).Code)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/sessions/sign-out-others", nil, func(r *http.Request) {
			withSession(access, cookie)(r)
			r.Header.Set("Sec-Fetch-Site", "cross-site")
		})
		require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
	})
}
