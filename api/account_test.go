package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
)

const testPublicBaseURL = "https://cms.test.invalid"

// recordingMailer keeps sent messages instead of delivering them.
type recordingMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
	err  error
}

func (m *recordingMailer) Send(_ context.Context, msg mailer.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return m.err
	}
	m.sent = append(m.sent, msg)
	return nil
}

func (m *recordingMailer) messages() []mailer.Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]mailer.Message(nil), m.sent...)
}

// newAccountTestServer is newTestServer with a recording mailer and the
// forgot-password background work run inline.
func newAccountTestServer(t *testing.T, store db.Store) (*Server, *recordingMailer) {
	server := newTestServer(t, store)
	rec := &recordingMailer{}
	server.mailer = rec
	server.runInBackground = func(f func()) { f() }
	return server, rec
}

// tokenFromMail returns the token in msg's link to path, checking that the
// text and HTML versions carry the same link.
func tokenFromMail(t *testing.T, msg mailer.Message, path string) string {
	t.Helper()
	re := regexp.MustCompile(regexp.QuoteMeta(testPublicBaseURL+path) + `#token=([A-Za-z0-9_-]+)`)
	m := re.FindStringSubmatch(msg.Text)
	require.Len(t, m, 2, "no %s link in the email text", path)
	require.Contains(t, msg.HTML, m[0])
	return m[1]
}

func doJSON(t *testing.T, server *Server, method, path string, body any, configure func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		data, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, path, reader)
	request.Header.Set("Content-Type", "application/json")
	if configure != nil {
		configure(request)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func requireErrorCode(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, recorder.Code, recorder.Body.String())
	var body map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, code, body["code"])
}

func accountTestUser(role string) db.User {
	user := randomUserNew()
	user.Role = role
	return user
}

func asUser(t *testing.T, server *Server, user db.User) func(*http.Request) {
	return func(r *http.Request) {
		addAuthorization(t, r, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	}
}

func TestForgotPasswordAPI(t *testing.T) {
	user := accountTestUser(RoleEditor)
	user.Email = "editor@example.com"

	t.Run("unknown email: 200, nothing stored or sent", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUserByEmail(gomock.Any(), "nobody@example.com").Return(db.User{}, sql.ErrNoRows)
		server, rec := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": "nobody@example.com"}, nil)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"message":"`+forgotPasswordMessage+`"}`, recorder.Body.String())
		require.Empty(t, rec.messages())
	})

	t.Run("known email: same answer, emails a link whose token is stored hashed", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUserByEmail(gomock.Any(), user.Email).Return(user, nil)
		store.EXPECT().CountPasswordResetTokensSince(gomock.Any(), gomock.Any()).Return(int64(0), nil)
		var stored db.CreatePasswordResetTokenParams
		store.EXPECT().CreatePasswordResetToken(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.CreatePasswordResetTokenParams) (db.PasswordResetToken, error) {
				stored = arg
				return db.PasswordResetToken{ID: 1, UserID: arg.UserID, TokenHash: arg.TokenHash, ExpiresAt: arg.ExpiresAt}, nil
			})
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteTitle: sql.NullString{String: "Acme News", Valid: true}}, nil)
		server, rec := newAccountTestServer(t, store)

		before := time.Now()
		// Normalized like every other email lookup.
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": "Editor@Example.COM"}, nil)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"message":"`+forgotPasswordMessage+`"}`, recorder.Body.String())

		msgs := rec.messages()
		require.Len(t, msgs, 1)
		msg := msgs[0]
		require.Equal(t, user.Email, msg.To)
		require.Equal(t, mailer.TemplatePasswordReset, msg.Template)
		require.Contains(t, msg.Subject, "Acme News")
		require.Contains(t, msg.Text, user.Username)

		raw := tokenFromMail(t, msg, resetPasswordPath)
		require.Len(t, raw, accountTokenLen)
		require.Equal(t, user.ID, stored.UserID)
		require.Equal(t, hashAccountToken(raw), stored.TokenHash)
		require.NotContains(t, string(stored.TokenHash), raw, "the raw token must not be stored")
		require.WithinDuration(t, before.Add(util.DefaultPasswordResetTTL), stored.ExpiresAt, 5*time.Second)
	})

	t.Run("a second request within a minute sends nothing", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUserByEmail(gomock.Any(), user.Email).Return(user, nil)
		store.EXPECT().CountPasswordResetTokensSince(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.CountPasswordResetTokensSinceParams) (int64, error) {
				require.WithinDuration(t, time.Now().Add(-passwordResetCooldown), arg.CreatedAt, 5*time.Second)
				return 1, nil
			})
		server, rec := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": user.Email}, nil)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Empty(t, rec.messages())
	})

	t.Run("a failed email is not reported to the requester", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUserByEmail(gomock.Any(), user.Email).Return(user, nil)
		store.EXPECT().CountPasswordResetTokensSince(gomock.Any(), gomock.Any()).Return(int64(0), nil)
		store.EXPECT().CreatePasswordResetToken(gomock.Any(), gomock.Any()).Return(db.PasswordResetToken{}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, errors.New("db down"))
		server, rec := newAccountTestServer(t, store)
		rec.err = errors.New("smtp: connection refused")

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": user.Email}, nil)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"message":"`+forgotPasswordMessage+`"}`, recorder.Body.String())
	})

	t.Run("malformed email: 400 without a lookup", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		server, _ := newAccountTestServer(t, mockdb.NewMockStore(ctrl))
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": "not-an-email"}, nil)
		require.Equal(t, http.StatusBadRequest, recorder.Code)
	})
}

// eqResetPasswordTx matches ResetPasswordTx params for a raw token and a
// plaintext password (bcrypt hashes differ every time).
type eqResetPasswordTx struct {
	token, password string
}

func (e eqResetPasswordTx) Matches(x any) bool {
	arg, ok := x.(db.ResetPasswordTxParams)
	if !ok || !bytes.Equal(arg.TokenHash, hashAccountToken(e.token)) {
		return false
	}
	return util.CheckPassword(e.password, arg.HashedPassword) == nil
}

func (e eqResetPasswordTx) String() string { return "reset params for the token and password" }

func TestResetPasswordAPI(t *testing.T) {
	user := accountTestUser(RoleContributor)
	token, _, err := newAccountToken()
	require.NoError(t, err)

	t.Run("success: new password set, refresh cookie cleared", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ResetPasswordTx(gomock.Any(), eqResetPasswordTx{token, "new-secret-1"}).Return(user, nil)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/reset", gin.H{"token": token, "password": "new-secret-1"}, nil)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
		cookies := recorder.Result().Cookies()
		require.NotEmpty(t, cookies)
		require.Equal(t, server.refreshCookieName(), cookies[0].Name)
		require.Negative(t, cookies[0].MaxAge)
	})

	t.Run("expired, used or unknown token", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ResetPasswordTx(gomock.Any(), gomock.Any()).Return(db.User{}, db.ErrTokenInvalid)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/reset", gin.H{"token": token, "password": "new-secret-1"}, nil)
		requireErrorCode(t, recorder, http.StatusBadRequest, "invalid_token")
	})

	for name, body := range map[string]gin.H{
		"malformed token":    {"token": "short", "password": "new-secret-1"},
		"non-base64 token":   {"token": strings.Repeat("!", accountTokenLen), "password": "new-secret-1"},
		"short password":     {"token": token, "password": "12345"},
		"too long password":  {"token": token, "password": strings.Repeat("a", 73)},
		"missing everything": {},
	} {
		t.Run(name+" never reaches the store", func(t *testing.T) {
			ctrl := gomock.NewController(t)
			server, _ := newAccountTestServer(t, mockdb.NewMockStore(ctrl))
			recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/reset", body, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
	}

	t.Run("store failure", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ResetPasswordTx(gomock.Any(), gomock.Any()).Return(db.User{}, errors.New("boom"))
		server, _ := newAccountTestServer(t, store)
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/password/reset", gin.H{"token": token, "password": "new-secret-1"}, nil)
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
	})
}

// A reset revokes access tokens issued before it: ResetPasswordTx stamps
// password_changed_at, and authMiddleware compares the token's iat to it.
func TestPasswordResetRevokesEarlierAccessTokens(t *testing.T) {
	user := accountTestUser(RoleEditor)
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server, _ := newAccountTestServer(t, store)

	oldToken := accessTokenIssuedAt(t, server, user, time.Now().Add(-time.Hour))
	user.PasswordChangedAt = time.Now() // as ResetPasswordTx leaves it
	store.EXPECT().GetUser(gomock.Any(), user.ID).Return(user, nil)

	recorder := doJSON(t, server, http.MethodGet, "/api/v1/users/me", nil, func(r *http.Request) {
		r.Header.Set(authorizationHeaderKey, "Bearer "+oldToken)
	})
	require.Equal(t, http.StatusUnauthorized, recorder.Code)
}

func TestInvitationRoutesRequireAdmin(t *testing.T) {
	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/invitations"},
		{http.MethodPost, "/api/v1/invitations"},
		{http.MethodPost, "/api/v1/invitations/1/resend"},
		{http.MethodDelete, "/api/v1/invitations/1"},
	}
	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			server, rec := newAccountTestServer(t, store)

			recorder := doJSON(t, server, route.method, route.path, gin.H{"email": "a@example.com", "role": "admin"}, nil)
			require.Equal(t, http.StatusUnauthorized, recorder.Code)

			for _, role := range []string{RoleEditor, RoleContributor} {
				user := accountTestUser(role)
				stubRoleLookup(store, user)
				recorder = doJSON(t, server, route.method, route.path, gin.H{"email": "a@example.com", "role": "admin"}, asUser(t, server, user))
				require.Equal(t, http.StatusForbidden, recorder.Code, role)
			}
			require.Empty(t, rec.messages())
		})
	}
}

func TestCreateInvitationAPI(t *testing.T) {
	admin := accountTestUser(RoleAdmin)

	expectCreate := func(store *mockdb.MockStore, captured *db.CreateUserInvitationParams) {
		store.EXPECT().CreateUserInvitationTx(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.CreateUserInvitationParams) (db.UserInvitation, error) {
				*captured = arg
				return db.UserInvitation{
					ID: 7, Email: arg.Email, Role: arg.Role, TokenHash: arg.TokenHash,
					InvitedBy: arg.InvitedBy, ExpiresAt: arg.ExpiresAt, CreatedAt: time.Now(),
				}, nil
			})
	}

	t.Run("success: emails a link, stores only the hash", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().GetUserByEmail(gomock.Any(), "new.person@example.com").Return(db.User{}, sql.ErrNoRows)
		var captured db.CreateUserInvitationParams
		expectCreate(store, &captured)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
		server, rec := newAccountTestServer(t, store)

		before := time.Now()
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/invitations",
			gin.H{"email": "New.Person@Example.com", "role": "editor"}, asUser(t, server, admin))
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())

		var rsp struct {
			Invitation InvitationResponse `json:"invitation"`
			EmailSent  bool               `json:"email_sent"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		require.True(t, rsp.EmailSent)
		require.Equal(t, "new.person@example.com", rsp.Invitation.Email)
		require.Equal(t, "editor", rsp.Invitation.Role)
		require.Equal(t, "pending", rsp.Invitation.Status)
		require.Equal(t, admin.ID, *rsp.Invitation.InvitedBy)
		require.NotContains(t, recorder.Body.String(), "token")

		require.Equal(t, "editor", captured.Role)
		require.Equal(t, sql.NullInt64{Int64: admin.ID, Valid: true}, captured.InvitedBy)
		require.WithinDuration(t, before.Add(util.DefaultInvitationTTL), captured.ExpiresAt, 5*time.Second)

		msgs := rec.messages()
		require.Len(t, msgs, 1)
		require.Equal(t, "new.person@example.com", msgs[0].To)
		require.Equal(t, mailer.TemplateInvitation, msgs[0].Template)
		require.Contains(t, msgs[0].Text, "an editor")
		require.Contains(t, msgs[0].Text, "3 days")
		raw := tokenFromMail(t, msgs[0], acceptInvitePath)
		require.Equal(t, hashAccountToken(raw), captured.TokenHash)
		require.NotContains(t, recorder.Body.String(), raw)
	})

	t.Run("email failure still creates the invitation", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().GetUserByEmail(gomock.Any(), gomock.Any()).Return(db.User{}, sql.ErrNoRows)
		var captured db.CreateUserInvitationParams
		expectCreate(store, &captured)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
		server, rec := newAccountTestServer(t, store)
		rec.err = errors.New("smtp down")

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/invitations",
			gin.H{"email": "x@example.com", "role": "contributor"}, asUser(t, server, admin))
		require.Equal(t, http.StatusCreated, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"email_sent":false`)
	})

	t.Run("an existing user's email: 409", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().GetUserByEmail(gomock.Any(), "taken@example.com").Return(accountTestUser(RoleEditor), nil)
		server, rec := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/invitations",
			gin.H{"email": "taken@example.com", "role": "editor"}, asUser(t, server, admin))
		requireErrorCode(t, recorder, http.StatusConflict, "email_registered")
		require.Empty(t, rec.messages())
	})

	for name, body := range map[string]gin.H{
		"unknown role":  {"email": "x@example.com", "role": "superuser"},
		"missing role":  {"email": "x@example.com"},
		"invalid email": {"email": "nope", "role": "editor"},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, admin)
			server, _ := newAccountTestServer(t, store)
			recorder := doJSON(t, server, http.MethodPost, "/api/v1/invitations", body, asUser(t, server, admin))
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
	}
}

func TestListInvitationsAPI(t *testing.T) {
	admin := accountTestUser(RoleAdmin)
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, admin)
	now := time.Now()
	store.EXPECT().ListOpenUserInvitations(gomock.Any()).Return([]db.UserInvitation{
		{ID: 2, Email: "b@example.com", Role: "editor", TokenHash: []byte("secret-hash"), ExpiresAt: now.Add(time.Hour)},
		{ID: 1, Email: "a@example.com", Role: "admin", ExpiresAt: now.Add(-time.Hour)},
	}, nil)
	server, _ := newAccountTestServer(t, store)

	recorder := doJSON(t, server, http.MethodGet, "/api/v1/invitations", nil, asUser(t, server, admin))
	require.Equal(t, http.StatusOK, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "token")
	var rsp struct {
		Invitations []InvitationResponse `json:"invitations"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Len(t, rsp.Invitations, 2)
	require.Equal(t, "pending", rsp.Invitations[0].Status)
	require.Equal(t, "expired", rsp.Invitations[1].Status)
	require.Nil(t, rsp.Invitations[1].InvitedBy)
}

func TestResendInvitationAPI(t *testing.T) {
	admin := accountTestUser(RoleAdmin)

	t.Run("new link, old one replaced", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		var captured db.RenewUserInvitationParams
		store.EXPECT().RenewUserInvitation(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.RenewUserInvitationParams) (db.UserInvitation, error) {
				captured = arg
				return db.UserInvitation{ID: arg.ID, Email: "c@example.com", Role: "contributor", TokenHash: arg.TokenHash,
					ExpiresAt: arg.ExpiresAt, CreatedAt: time.Now().Add(-100 * time.Hour)}, nil
			})
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
		server, rec := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/invitations/42/resend", nil, asUser(t, server, admin))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.EqualValues(t, 42, captured.ID)

		msgs := rec.messages()
		require.Len(t, msgs, 1)
		require.Equal(t, hashAccountToken(tokenFromMail(t, msgs[0], acceptInvitePath)), captured.TokenHash)
		require.Contains(t, msgs[0].Text, "3 days", "the lifetime counts from the resend")
	})

	t.Run("accepted or revoked: 404", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().RenewUserInvitation(gomock.Any(), gomock.Any()).Return(db.UserInvitation{}, sql.ErrNoRows)
		server, rec := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/invitations/42/resend", nil, asUser(t, server, admin))
		require.Equal(t, http.StatusNotFound, recorder.Code)
		require.Empty(t, rec.messages())
	})

	t.Run("bad id", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		server, _ := newAccountTestServer(t, store)
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/invitations/abc/resend", nil, asUser(t, server, admin))
		require.Equal(t, http.StatusBadRequest, recorder.Code)
	})
}

func TestRevokeInvitationAPI(t *testing.T) {
	admin := accountTestUser(RoleAdmin)
	for _, tc := range []struct {
		rows   int64
		status int
	}{{1, http.StatusOK}, {0, http.StatusNotFound}} {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().RevokeUserInvitation(gomock.Any(), int64(9)).Return(tc.rows, nil)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodDelete, "/api/v1/invitations/9", nil, asUser(t, server, admin))
		require.Equal(t, tc.status, recorder.Code)
	}
}

func TestPreviewInvitationAPI(t *testing.T) {
	token, hash, err := newAccountToken()
	require.NoError(t, err)

	t.Run("valid", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetValidUserInvitationByTokenHash(gomock.Any(), hash).
			Return(db.UserInvitation{ID: 3, Email: "d@example.com", Role: "editor", ExpiresAt: time.Now().Add(time.Hour)}, nil)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/preview", gin.H{"token": token}, nil)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"email":"d@example.com"`)
		require.Contains(t, recorder.Body.String(), `"role":"editor"`)
	})

	t.Run("expired, used, revoked or unknown", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetValidUserInvitationByTokenHash(gomock.Any(), hash).Return(db.UserInvitation{}, sql.ErrNoRows)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/preview", gin.H{"token": token}, nil)
		requireErrorCode(t, recorder, http.StatusBadRequest, "invalid_token")
	})

	t.Run("malformed", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		server, _ := newAccountTestServer(t, mockdb.NewMockStore(ctrl))
		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/preview", gin.H{"token": "abc"}, nil)
		requireErrorCode(t, recorder, http.StatusBadRequest, "invalid_token")
	})
}

type eqAcceptInvitationTx struct {
	token, username, fullName, password string
}

func (e eqAcceptInvitationTx) Matches(x any) bool {
	arg, ok := x.(db.AcceptInvitationTxParams)
	return ok && bytes.Equal(arg.TokenHash, hashAccountToken(e.token)) &&
		arg.Username == e.username && arg.FullName == e.fullName &&
		util.CheckPassword(e.password, arg.HashedPassword) == nil
}

func (e eqAcceptInvitationTx) String() string { return "accept params" }

func TestAcceptInvitationAPI(t *testing.T) {
	token, _, err := newAccountToken()
	require.NoError(t, err)
	valid := gin.H{"token": token, "username": " newbie ", "full_name": "New Person", "password": "secret-123",
		// Ignored: the invitation decides these.
		"role": "admin", "email": "attacker@example.com"}

	t.Run("creates the user with the invited role", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		created := db.User{ID: 77, Username: "newbie", FullName: "New Person", Email: "invited@example.com", Role: "editor"}
		store.EXPECT().AcceptInvitationTx(gomock.Any(), eqAcceptInvitationTx{token, "newbie", "New Person", "secret-123"}).
			Return(db.AcceptInvitationTxResult{User: created, Invitation: db.UserInvitation{ID: 5}}, nil)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/accept", valid, nil)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		var rsp struct {
			User PrivateUserResponse `json:"user"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		require.Equal(t, "editor", rsp.User.Role)
		require.Equal(t, "invited@example.com", rsp.User.Email)
		require.NotContains(t, recorder.Body.String(), "hashed_password")
	})

	t.Run("used, expired or revoked link", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().AcceptInvitationTx(gomock.Any(), gomock.Any()).Return(db.AcceptInvitationTxResult{}, db.ErrTokenInvalid)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/accept", valid, nil)
		requireErrorCode(t, recorder, http.StatusBadRequest, "invalid_token")
	})

	for name, tc := range map[string]struct {
		err  error
		code string
	}{
		"username taken": {errors.New(`pq: duplicate key value violates unique constraint "users_username_key"`), "username_taken"},
		"email taken":    {errors.New(`pq: duplicate key value violates unique constraint "users_email_key"`), "email_registered"},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().AcceptInvitationTx(gomock.Any(), gomock.Any()).Return(db.AcceptInvitationTxResult{}, tc.err)
			server, _ := newAccountTestServer(t, store)

			recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/accept", valid, nil)
			requireErrorCode(t, recorder, http.StatusConflict, tc.code)
		})
	}

	// Same rules as admin user creation (CreateUserRequest).
	for name, body := range map[string]gin.H{
		"short password":    {"token": token, "username": "newbie", "full_name": "New Person", "password": "12345"},
		"long password":     {"token": token, "username": "newbie", "full_name": "New Person", "password": strings.Repeat("x", 73)},
		"short username":    {"token": token, "username": "ab", "full_name": "New Person", "password": "secret-123"},
		"blank username":    {"token": token, "username": "    ", "full_name": "New Person", "password": "secret-123"},
		"missing full name": {"token": token, "username": "newbie", "password": "secret-123"},
		"malformed token":   {"token": "nope", "username": "newbie", "full_name": "New Person", "password": "secret-123"},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			server, _ := newAccountTestServer(t, mockdb.NewMockStore(ctrl))
			recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/accept", body, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
	}
}

func TestAccountEndpointRateLimits(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetUserByEmail(gomock.Any(), gomock.Any()).Return(db.User{}, sql.ErrNoRows).AnyTimes()
	server := newRateLimitedTestServer(t, store, func(c *util.Config) {
		c.RateLimitPasswordForgotPerMinute = 2
		c.RateLimitAccountTokenPerMinute = 2
	})
	server.runInBackground = func(f func()) { f() }

	from := func(ip string) func(*http.Request) {
		return func(r *http.Request) { r.RemoteAddr = ip + ":1234" }
	}
	for i := 0; i < 2; i++ {
		require.Equal(t, http.StatusOK, doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": "a@example.com"}, from("203.0.113.1")).Code)
	}
	requireRateLimited(t, doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": "a@example.com"}, from("203.0.113.1")))
	// Another client is unaffected.
	require.Equal(t, http.StatusOK, doJSON(t, server, http.MethodPost, "/api/v1/auth/password/forgot", gin.H{"email": "a@example.com"}, from("203.0.113.2")).Code)

	// The token endpoints share one per-client allowance.
	bad := gin.H{"token": "x", "password": "secret-123", "username": "abc", "full_name": "Ab"}
	require.Equal(t, http.StatusBadRequest, doJSON(t, server, http.MethodPost, "/api/v1/auth/password/reset", bad, from("203.0.113.3")).Code)
	require.Equal(t, http.StatusBadRequest, doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/accept", bad, from("203.0.113.3")).Code)
	requireRateLimited(t, doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/preview", bad, from("203.0.113.3")))
}

func TestNewServerMailConfig(t *testing.T) {
	release := func(t *testing.T) util.Config {
		config := newTestConfig(t)
		config.IsTestMode = false
		config.GinMode = util.GinModeRelease
		return config
	}
	for name, tc := range map[string]struct {
		configure func(*util.Config)
		wantErr   string
	}{
		"no SMTP host":          {func(c *util.Config) { c.SMTPHost = "" }, "SMTP_HOST"},
		"no sender":             {func(c *util.Config) { c.MailFrom = "" }, "MAIL_FROM"},
		"half the credentials":  {func(c *util.Config) { c.SMTPUser = "mailer" }, "SMTP_USER and SMTP_PASS"},
		"file driver":           {func(c *util.Config) { c.MailDriver = "file" }, "development only"},
		"log driver":            {func(c *util.Config) { c.MailDriver = "log" }, "development only"},
		"unknown driver":        {func(c *util.Config) { c.MailDriver = "carrier-pigeon" }, "invalid MAIL_DRIVER"},
		"no public URL":         {func(c *util.Config) { c.PublicBaseURL = "" }, "PUBLIC_BASE_URL"},
		"relative public URL":   {func(c *util.Config) { c.PublicBaseURL = "cms.example.com" }, "PUBLIC_BASE_URL"},
		"public URL with query": {func(c *util.Config) { c.PublicBaseURL = "https://cms.example.com/?a=b" }, "PUBLIC_BASE_URL"},
	} {
		t.Run(name, func(t *testing.T) {
			config := release(t)
			tc.configure(&config)
			_, err := NewServer(config, mockdb.NewMockStore(gomock.NewController(t)))
			require.ErrorContains(t, err, tc.wantErr)
		})
	}

	t.Run("debug mode needs no mail setup", func(t *testing.T) {
		config := newTestConfig(t)
		config.SMTPHost, config.MailFrom, config.PublicBaseURL = "", "", ""
		config.GinMode = util.GinModeDebug
		server, err := NewServer(config, mockdb.NewMockStore(gomock.NewController(t)))
		require.NoError(t, err)
		require.Equal(t, "http://localhost:4321", server.publicURL)
	})
}
