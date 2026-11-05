package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// Open signup (#191) on a mock store: the setting, validation, no enumeration,
// rate limits. signup_flow_test.go runs the whole flow against the database.

const signupPassword = "a-long-signup-password"

func signupBody(username, email string) gin.H {
	return gin.H{"username": username, "full_name": "Sam Signup", "email": email, "password": signupPassword}
}

func signupOpen(store *mockdb.MockStore) *gomock.Call {
	return store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{AllowSignup: true}, nil)
}

func postRegister(t *testing.T, server *Server, body any, configure func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/api/v1/auth/register", body, configure)
}

func postVerifySignup(t *testing.T, server *Server, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/api/v1/auth/register/verify", gin.H{"token": token}, nil)
}

func TestSignupRoleIsContributor(t *testing.T) {
	require.Equal(t, RoleContributor, db.SignupRole)
	require.False(t, isSiteAdmin(db.User{Role: db.SignupRole}))
}

func TestRegisterWhenSignupIsOff(t *testing.T) {
	for name, setting := range map[string]db.Setting{
		"a settings row with the default": {},
		"turned off":                      {AllowSignup: false, SiteTitle: sql.NullString{String: "x", Valid: true}},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			// Settings only: no lookup, no token, no email.
			store.EXPECT().GetSettings(gomock.Any()).Times(2).Return(setting, nil)
			server, rec := newAccountTestServer(t, store)

			requireErrorCode(t, postRegister(t, server, signupBody("samsignup", "sam@example.com"), nil), http.StatusForbidden, "signup_disabled")
			token, _, err := newAccountToken()
			require.NoError(t, err)
			requireErrorCode(t, postVerifySignup(t, server, token), http.StatusForbidden, "signup_disabled")
			require.Empty(t, rec.messages())
		})
	}

	t.Run("no settings row counts as off", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, sql.ErrNoRows)
		server, _ := newAccountTestServer(t, store)
		requireErrorCode(t, postRegister(t, server, signupBody("samsignup", "sam@example.com"), nil), http.StatusForbidden, "signup_disabled")
	})

	t.Run("an unreadable setting is a 500, never open", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, errors.New("db down"))
		server, _ := newAccountTestServer(t, store)
		recorder := postRegister(t, server, signupBody("samsignup", "sam@example.com"), nil)
		require.Equal(t, http.StatusInternalServerError, recorder.Code, recorder.Body.String())
	})
}

func TestRegisterValidation(t *testing.T) {
	cases := []struct {
		name  string
		body  any
		field string
	}{
		{"password one short of the minimum", gin.H{"username": "samsignup", "full_name": "Sam Signup", "email": "sam@example.com", "password": strings.Repeat("x", MinPasswordLength-1)}, "password"},
		{"password is the email", gin.H{"username": "samsignup", "full_name": "Sam Signup", "email": "sam.signup@example.com", "password": "Sam.Signup@Example.com"}, "password"},
		{"password is the username", gin.H{"username": "samsignup2026", "full_name": "Sam Signup", "email": "sam@example.com", "password": "SAMSIGNUP2026"}, "password"},
		{"password is the full name", gin.H{"username": "samsignup", "full_name": "Samantha Signup", "email": "sam@example.com", "password": " samantha signup "}, "password"},
		{"password over 72 bytes", gin.H{"username": "samsignup", "full_name": "Sam Signup", "email": "sam@example.com", "password": strings.Repeat("é", 37)}, "password"},
		{"malformed email", gin.H{"username": "samsignup", "full_name": "Sam Signup", "email": "not-an-email", "password": signupPassword}, "email"},
		{"username with symbols", gin.H{"username": "sam-signup", "full_name": "Sam Signup", "email": "sam@example.com", "password": signupPassword}, "username"},
		{"username too short", gin.H{"username": "sa", "full_name": "Sam Signup", "email": "sam@example.com", "password": signupPassword}, "username"},
		{"missing full name", gin.H{"username": "samsignup", "email": "sam@example.com", "password": signupPassword}, "full_name"},
		{"no role may be chosen", gin.H{"username": "samsignup", "full_name": "Sam Signup", "email": "sam@example.com", "password": signupPassword, "role": "admin"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			signupOpen(store)
			server, rec := newAccountTestServer(t, store)

			recorder := postRegister(t, server, tc.body, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
			if tc.field != "" {
				require.Contains(t, recorder.Body.String(), `"`+tc.field+`"`)
			}
			require.Empty(t, rec.messages())
		})
	}

	t.Run("whitespace-only names are refused after trimming", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store)
		server, _ := newAccountTestServer(t, store)
		recorder := postRegister(t, server, gin.H{"username": "samsignup", "full_name": "  a  ", "email": "sam@example.com", "password": signupPassword}, nil)
		require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
	})
}

func TestRegisterUsernameUnavailable(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	signupOpen(store)
	store.EXPECT().GetUserByUsername(gomock.Any(), "samsignup").Return(randomUserNew(), nil)
	server, rec := newAccountTestServer(t, store)

	recorder := postRegister(t, server, signupBody(" samsignup ", "sam@example.com"), nil)
	requireErrorCode(t, recorder, http.StatusConflict, "username_unavailable")
	// Generic: nothing about the account that has it.
	require.NotContains(t, recorder.Body.String(), "@")
	require.Empty(t, rec.messages())
}

// expectFreeSignup stubs the background work for an address with no account and
// returns what RequestSignupTx stored.
func expectFreeSignup(store *mockdb.MockStore, email string) *db.CreateSignupRequestParams {
	stored := &db.CreateSignupRequestParams{}
	store.EXPECT().GetUserByEmailFold(gomock.Any(), email).Return(db.User{}, sql.ErrNoRows)
	store.EXPECT().RequestSignupTx(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, arg db.CreateSignupRequestParams) (db.SignupRequest, error) {
			*stored = arg
			return db.SignupRequest{ID: 7, Email: arg.Email, TokenHash: arg.TokenHash, ExpiresAt: arg.ExpiresAt}, nil
		})
	return stored
}

func TestRegisterSendsALinkAndStoresOnlyHashes(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	signupOpen(store)
	store.EXPECT().GetUserByUsername(gomock.Any(), "samsignup").Return(db.User{}, sql.ErrNoRows)
	stored := expectFreeSignup(store, "sam@example.com")
	store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteTitle: sql.NullString{String: "Field Notes", Valid: true}}, nil)
	server, rec := newAccountTestServer(t, store)

	before := time.Now()
	recorder := postRegister(t, server, signupBody("samsignup", "Sam@Example.COM"), nil)
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	require.JSONEq(t, `{"message":"`+signupMessage+`","expires_in_seconds":86400}`, recorder.Body.String())

	msgs := rec.messages()
	require.Len(t, msgs, 1)
	require.Equal(t, "sam@example.com", msgs[0].To, "normalized")
	require.Equal(t, mailer.TemplateSignupVerify, msgs[0].Template)
	require.Contains(t, msgs[0].Subject, "Field Notes")
	raw := tokenFromMail(t, msgs[0], verifyEmailPath)
	require.Len(t, raw, accountTokenLen)

	require.Equal(t, hashAccountToken(raw), stored.TokenHash)
	require.Equal(t, "samsignup", stored.Username)
	require.Equal(t, "Sam Signup", stored.FullName)
	require.NotEqual(t, signupPassword, stored.HashedPassword)
	require.NoError(t, util.CheckPassword(signupPassword, stored.HashedPassword), "the bcrypt hash the account will get")
	require.WithinDuration(t, before.Add(signupLinkTTL), stored.ExpiresAt, 5*time.Second)
	// No account (and so no activity) until the link is used.
	require.Empty(t, activityOf(t, server).verbs())
}

func TestRegisterTakenEmailIsIndistinguishable(t *testing.T) {
	owner := accountTestUser(RoleEditor)
	owner.Email = "owner@example.com"

	// The work before the response must be the same calls for both, so the
	// answer and its timing can't depend on the address. The background part is
	// captured, not run, until the responses have been compared.
	run := func(t *testing.T, email string, background func(store *mockdb.MockStore)) (*httptest.ResponseRecorder, *recordingMailer) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store)
		store.EXPECT().GetUserByUsername(gomock.Any(), "samsignup").Return(db.User{}, sql.ErrNoRows)
		server, rec := newAccountTestServer(t, store)
		var deferred func()
		server.runInBackground = func(_, _ string, f func()) { deferred = f }

		recorder := postRegister(t, server, signupBody("samsignup", email), nil)
		require.NotNil(t, deferred, "the address lookup must run after the response")

		background(store)
		deferred()
		return recorder, rec
	}

	taken, takenMail := run(t, owner.Email, func(store *mockdb.MockStore) {
		store.EXPECT().GetUserByEmailFold(gomock.Any(), owner.Email).Return(owner, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
	})
	free, freeMail := run(t, "free@example.com", func(store *mockdb.MockStore) {
		expectFreeSignup(store, "free@example.com")
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
	})

	require.Equal(t, http.StatusAccepted, taken.Code, taken.Body.String())
	require.Equal(t, free.Code, taken.Code)
	require.JSONEq(t, free.Body.String(), taken.Body.String())
	require.Equal(t, free.Header().Get("Content-Type"), taken.Header().Get("Content-Type"))

	// The owner hears about it, with no link that creates anything.
	msgs := takenMail.messages()
	require.Len(t, msgs, 1)
	require.Equal(t, owner.Email, msgs[0].To)
	require.Equal(t, mailer.TemplateSignupExisting, msgs[0].Template)
	require.Contains(t, msgs[0].Text, owner.Username)
	require.Contains(t, msgs[0].Text, testPublicBaseURL+forgotPasswordPath)
	require.NotContains(t, msgs[0].Text, "#token=")
	require.Equal(t, mailer.TemplateSignupVerify, freeMail.messages()[0].Template)
}

func TestRegisterFailuresAfterTheResponseAreNotReported(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	signupOpen(store)
	store.EXPECT().GetUserByUsername(gomock.Any(), "samsignup").Return(db.User{}, sql.ErrNoRows)
	store.EXPECT().GetUserByEmailFold(gomock.Any(), "sam@example.com").Return(db.User{}, sql.ErrNoRows)
	store.EXPECT().RequestSignupTx(gomock.Any(), gomock.Any()).Return(db.SignupRequest{}, errors.New("db down"))
	server, rec := newAccountTestServer(t, store)

	recorder := postRegister(t, server, signupBody("samsignup", "sam@example.com"), nil)
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	require.Empty(t, rec.messages())
}

func TestRegisterRateLimits(t *testing.T) {
	from := func(ip string) func(*http.Request) {
		return func(r *http.Request) { r.RemoteAddr = ip + ":1234" }
	}

	t.Run("per IP", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store).Times(3)
		store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(3).Return(randomUserNew(), nil)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitLoginPerMinute = 2 })

		for i, email := range []string{"a@example.com", "b@example.com"} {
			require.Equal(t, http.StatusConflict, postRegister(t, server, signupBody("taken", email), from("203.0.113.1")).Code, i)
		}
		requireRateLimited(t, postRegister(t, server, signupBody("taken", "c@example.com"), from("203.0.113.1")))
		// Another client is unaffected.
		require.Equal(t, http.StatusConflict, postRegister(t, server, signupBody("taken", "c@example.com"), from("203.0.113.2")).Code)
	})

	t.Run("per IP and email, never the email alone", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store).Times(5)
		store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(4).Return(randomUserNew(), nil)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitPasswordForgotPerMinute = 2 })

		require.Equal(t, http.StatusConflict, postRegister(t, server, signupBody("taken", "flood@example.com"), from("203.0.113.1")).Code)
		require.Equal(t, http.StatusConflict, postRegister(t, server, signupBody("taken", "Flood@Example.com"), from("203.0.113.1")).Code)
		requireRateLimited(t, postRegister(t, server, signupBody("taken", "flood@example.com"), from("203.0.113.1")))
		// Another address from that client, and the address from another client
		// (its owner, say), are unaffected.
		require.Equal(t, http.StatusConflict, postRegister(t, server, signupBody("taken", "other@example.com"), from("203.0.113.1")).Code)
		require.Equal(t, http.StatusConflict, postRegister(t, server, signupBody("taken", "flood@example.com"), from("203.0.113.2")).Code)
	})

	t.Run("at most one email a minute per address, silently", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store).Times(3) // the third: the email's site title
		store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(2).Return(db.User{}, sql.ErrNoRows)
		expectFreeSignup(store, "sam@example.com")
		server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitPasswordForgotPerMinute = 5 })
		server.runInBackground = func(_, _ string, f func()) { f() }
		rec := &recordingMailer{}
		server.mailer = rec

		first := postRegister(t, server, signupBody("samsignup", "sam@example.com"), from("203.0.113.1"))
		second := postRegister(t, server, signupBody("samsignup2", "sam@example.com"), from("203.0.113.2"))
		require.Equal(t, http.StatusAccepted, first.Code, first.Body.String())
		require.JSONEq(t, first.Body.String(), second.Body.String())
		require.Len(t, rec.messages(), 1, "the second request stored and sent nothing")
	})

	t.Run("verify is an emailed-token endpoint", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store).Times(2)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitAccountTokenPerMinute = 2 })
		for range 2 {
			requireErrorCode(t, postVerifySignup(t, server, "short"), http.StatusBadRequest, "invalid_token")
		}
		requireRateLimited(t, postVerifySignup(t, server, "short"))
	})
}

func TestConfirmSignupAPI(t *testing.T) {
	token, hash, err := newAccountToken()
	require.NoError(t, err)

	t.Run("creates a contributor and records the signup", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store)
		created := db.User{ID: 42, Username: "samsignup", FullName: "Sam Signup", Email: "sam@example.com", Role: db.SignupRole}
		store.EXPECT().ConfirmSignupTx(gomock.Any(), hash).Return(created, nil)
		server, _ := newAccountTestServer(t, store)

		recorder := postVerifySignup(t, server, token)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"role":"contributor"`)
		require.NotContains(t, recorder.Body.String(), "hashed_password")
		require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
		require.Equal(t, []string{"signed_up user:42"}, activityOf(t, server).verbs())
		events := activityOf(t, server).events
		require.Equal(t, int64(42), events[0].ActorID.Int64, "the new member is the actor")
		require.JSONEq(t, `{"role":"contributor"}`, string(events[0].Payload))
	})

	for name, tc := range map[string]struct {
		err    error
		status int
		code   string
	}{
		"invalid, expired or used":     {db.ErrTokenInvalid, http.StatusBadRequest, "invalid_token"},
		"address registered meanwhile": {db.ErrEmailTaken, http.StatusConflict, "email_registered"},
		"username taken meanwhile":     {db.ErrUsernameTaken, http.StatusConflict, "username_unavailable"},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			signupOpen(store)
			store.EXPECT().ConfirmSignupTx(gomock.Any(), hash).Return(db.User{}, tc.err)
			server, _ := newAccountTestServer(t, store)
			requireErrorCode(t, postVerifySignup(t, server, token), tc.status, tc.code)
			require.Empty(t, activityOf(t, server).verbs())
		})
	}

	t.Run("a malformed token is refused without a lookup", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store)
		server, _ := newAccountTestServer(t, store)
		requireErrorCode(t, postVerifySignup(t, server, strings.Repeat("!", accountTokenLen)), http.StatusBadRequest, "invalid_token")
	})

	t.Run("a database failure is a 500", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		signupOpen(store)
		store.EXPECT().ConfirmSignupTx(gomock.Any(), hash).Return(db.User{}, errors.New("db down"))
		server, _ := newAccountTestServer(t, store)
		require.Equal(t, http.StatusInternalServerError, postVerifySignup(t, server, token).Code)
	})
}

func TestUpdateSettingsAllowSignup(t *testing.T) {
	admin := accountTestUser(RoleAdmin)
	editor := accountTestUser(RoleEditor)

	t.Run("admins turn it on; the field is in the public settings", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.UpdateSettingsParams) (db.Setting, error) {
				require.Equal(t, sql.NullBool{Bool: true, Valid: true}, arg.AllowSignup)
				return db.Setting{ID: 1, AllowSignup: true}, nil
			})
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{ID: 1, AllowSignup: true}, nil)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPut, "/api/v1/settings", gin.H{"allow_signup": true}, asUser(t, server, admin))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"allow_signup":true`)
		require.Equal(t, []string{"settings_updated settings:1"}, activityOf(t, server).verbs())
		require.JSONEq(t, `{"fields":["allow_signup"]}`, string(activityOf(t, server).events[0].Payload))

		public := doJSON(t, server, http.MethodGet, "/api/v1/settings", nil, nil)
		require.Equal(t, http.StatusOK, public.Code)
		require.Contains(t, public.Body.String(), `"allow_signup":true`)
	})

	t.Run("absent keeps the stored value", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.UpdateSettingsParams) (db.Setting, error) {
				require.False(t, arg.AllowSignup.Valid)
				return db.Setting{ID: 1}, nil
			})
		server, _ := newAccountTestServer(t, store)
		recorder := doJSON(t, server, http.MethodPut, "/api/v1/settings", gin.H{"site_title": "Field Notes"}, asUser(t, server, admin))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	})

	t.Run("anyone else can't change it", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, editor)
		server, _ := newAccountTestServer(t, store)
		recorder := doJSON(t, server, http.MethodPut, "/api/v1/settings", gin.H{"allow_signup": true}, asUser(t, server, editor))
		require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
		recorder = doJSON(t, server, http.MethodPut, "/api/v1/settings", gin.H{"allow_signup": true}, nil)
		require.Equal(t, http.StatusUnauthorized, recorder.Code, recorder.Body.String())
	})
}

func TestPruneSignupRequestsSurvivesAFailure(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().DeleteStaleSignupRequests(gomock.Any()).Return(int64(0), errors.New("db down"))
	store.EXPECT().DeleteStaleSignupRequests(gomock.Any()).Return(int64(3), nil)
	server, _ := newAccountTestServer(t, store)
	server.pruneSignupRequests(context.Background()) // logged, not fatal
	server.pruneSignupRequests(context.Background())

	// A cancelled loop prunes once and returns; 0 picks the hourly default.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store.EXPECT().DeleteStaleSignupRequests(gomock.Any()).Return(int64(0), context.Canceled)
	server.RunSignupRequestPrune(ctx, 0)
}
