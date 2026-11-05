package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

// Open signup (#191) through the real router against the test database (skipped
// without one), like profile_account_test.go.

// setAllowSignup sets the singleton setting and restores it when the test ends.
func setAllowSignup(t *testing.T, store db.Store, on bool) {
	t.Helper()
	ctx := context.Background()
	before, err := store.GetSettings(ctx)
	require.NoError(t, err)
	_, err = store.UpdateSettings(ctx, db.UpdateSettingsParams{AllowSignup: sql.NullBool{Bool: on, Valid: true}})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := store.UpdateSettings(context.Background(), db.UpdateSettingsParams{AllowSignup: sql.NullBool{Bool: before.AllowSignup, Valid: true}})
		require.NoError(t, err)
	})
}

func uniqueUsername(prefix string) string {
	return prefix + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
}

func signupLogin(t *testing.T, server *Server, username, password string) int {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/api/v1/auth/login", gin.H{"username": username, "password": password}, nil).Code
}

// registerAndTakeLink signs up and returns the confirmation link's token.
func registerAndTakeLink(t *testing.T, server *Server, rec *recordingMailer, username, email string) string {
	t.Helper()
	sent := len(rec.messages())
	recorder := postRegister(t, server, gin.H{"username": username, "full_name": "Flow Signup", "email": email, "password": signupPassword}, nil)
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	msgs := rec.messages()
	require.Len(t, msgs, sent+1)
	require.Equal(t, mailer.TemplateSignupVerify, msgs[sent].Template)
	return tokenFromMail(t, msgs[sent], verifyEmailPath)
}

func TestSignupIsOffByDefault(t *testing.T) {
	conn, _ := scheduleTestDB(t)
	var columnDefault string
	require.NoError(t, conn.QueryRow(
		`SELECT column_default FROM information_schema.columns WHERE table_name = 'settings' AND column_name = 'allow_signup'`,
	).Scan(&columnDefault))
	require.Equal(t, "false", columnDefault)
}

func TestSignupFlow(t *testing.T) {
	store := authFlowStore(t)
	ctx := context.Background()

	t.Run("off: refused, nothing stored", func(t *testing.T) {
		setAllowSignup(t, store, false)
		server, rec := profileFlowServer(t, store)
		email := uniqueEmail("off")
		requireErrorCode(t, postRegister(t, server, signupBody(uniqueUsername("off"), email), nil), http.StatusForbidden, "signup_disabled")
		require.Empty(t, rec.messages())
		_, err := store.GetUserByEmail(ctx, email)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})

	t.Run("no sign-in until confirmed; then a contributor; the link works once", func(t *testing.T) {
		setAllowSignup(t, store, true)
		server, rec := profileFlowServer(t, store)
		username, email := uniqueUsername("new"), uniqueEmail("New.")

		token := registerAndTakeLink(t, server, rec, username, email)
		require.Equal(t, normEmail(email), rec.messages()[0].To)

		// No account yet: the details don't sign in, and the name and address are free.
		require.Equal(t, http.StatusUnauthorized, signupLogin(t, server, username, signupPassword))
		_, err := store.GetUserByUsername(ctx, username)
		require.ErrorIs(t, err, sql.ErrNoRows)

		recorder := postVerifySignup(t, server, token)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		var body struct {
			User PrivateUserResponse `json:"user"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, username, body.User.Username)
		require.Equal(t, normEmail(email), body.User.Email)

		user, err := store.GetUserByUsername(ctx, username)
		require.NoError(t, err)
		require.Equal(t, RoleContributor, user.Role)
		require.Equal(t, "Flow Signup", user.FullName)
		require.Equal(t, http.StatusOK, signupLogin(t, server, username, signupPassword))

		// Single use.
		requireErrorCode(t, postVerifySignup(t, server, token), http.StatusBadRequest, "invalid_token")
	})

	t.Run("an expired link fails", func(t *testing.T) {
		setAllowSignup(t, store, true)
		server, _ := profileFlowServer(t, store)
		token, hash, err := newAccountToken()
		require.NoError(t, err)
		username := uniqueUsername("late")
		_, err = store.CreateSignupRequest(ctx, db.CreateSignupRequestParams{
			Email: uniqueEmail("late"), Username: username, FullName: "Late Signup",
			HashedPassword: "x", TokenHash: hash, ExpiresAt: time.Now().Add(-time.Minute),
		})
		require.NoError(t, err)

		requireErrorCode(t, postVerifySignup(t, server, token), http.StatusBadRequest, "invalid_token")
		_, err = store.GetUserByUsername(ctx, username)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})

	t.Run("a newer signup for the address ends the older link", func(t *testing.T) {
		setAllowSignup(t, store, true)
		server, rec := profileFlowServer(t, store)
		email := uniqueEmail("twice")
		first := registerAndTakeLink(t, server, rec, uniqueUsername("first"), email)
		secondName := uniqueUsername("second")
		second := registerAndTakeLink(t, server, rec, secondName, email)

		requireErrorCode(t, postVerifySignup(t, server, first), http.StatusBadRequest, "invalid_token")
		require.Equal(t, http.StatusCreated, postVerifySignup(t, server, second).Code)
		user, err := store.GetUserByEmail(ctx, normEmail(email))
		require.NoError(t, err)
		require.Equal(t, secondName, user.Username)
	})

	t.Run("a taken address: same answer, the owner gets a note, nothing stored", func(t *testing.T) {
		setAllowSignup(t, store, true)
		server, rec := profileFlowServer(t, store)
		owner := authFlowUser(t, store)

		taken := postRegister(t, server, signupBody(uniqueUsername("dup"), owner.Email), nil)
		free := postRegister(t, server, signupBody(uniqueUsername("free"), uniqueEmail("free")), nil)
		require.Equal(t, http.StatusAccepted, taken.Code, taken.Body.String())
		require.JSONEq(t, free.Body.String(), taken.Body.String())

		msgs := rec.messages()
		require.Len(t, msgs, 2)
		require.Equal(t, owner.Email, msgs[0].To)
		require.Equal(t, mailer.TemplateSignupExisting, msgs[0].Template)
		require.Equal(t, mailer.TemplateSignupVerify, msgs[1].Template)
		require.Equal(t, http.StatusOK, signupLogin(t, server, owner.Username, authFlowPassword), "the owner's account is untouched")
	})

	t.Run("a taken username: generic 409", func(t *testing.T) {
		setAllowSignup(t, store, true)
		server, rec := profileFlowServer(t, store)
		owner := authFlowUser(t, store)
		requireErrorCode(t, postRegister(t, server, signupBody(owner.Username, uniqueEmail("x")), nil), http.StatusConflict, "username_unavailable")
		require.Empty(t, rec.messages())
	})

	t.Run("taken between the request and the confirmation", func(t *testing.T) {
		setAllowSignup(t, store, true)
		server, rec := profileFlowServer(t, store)

		username := uniqueUsername("race")
		token := registerAndTakeLink(t, server, rec, username, uniqueEmail("race"))
		_, err := store.CreateUser(ctx, db.CreateUserParams{Username: username, FullName: "Quick", Email: uniqueEmail("quick"), HashedPassword: "x", Role: RoleContributor})
		require.NoError(t, err)
		requireErrorCode(t, postVerifySignup(t, server, token), http.StatusConflict, "username_unavailable")

		email := uniqueEmail("race")
		token = registerAndTakeLink(t, server, rec, uniqueUsername("race"), email)
		_, err = store.CreateUser(ctx, db.CreateUserParams{Username: uniqueUsername("invited"), FullName: "Invited", Email: normEmail(email), HashedPassword: "x", Role: RoleEditor})
		require.NoError(t, err)
		requireErrorCode(t, postVerifySignup(t, server, token), http.StatusConflict, "email_registered")
	})

	t.Run("turning signup off ends pending links", func(t *testing.T) {
		setAllowSignup(t, store, true)
		server, rec := profileFlowServer(t, store)
		username := uniqueUsername("closed")
		token := registerAndTakeLink(t, server, rec, username, uniqueEmail("closed"))

		_, err := store.UpdateSettings(ctx, db.UpdateSettingsParams{AllowSignup: sql.NullBool{Bool: false, Valid: true}})
		require.NoError(t, err)
		requireErrorCode(t, postVerifySignup(t, server, token), http.StatusForbidden, "signup_disabled")
		_, err = store.GetUserByUsername(ctx, username)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})
}

func TestConfirmSignupTxCleansUp(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	email := normEmail(uniqueEmail("clean"))

	_, staleHash, err := newAccountToken()
	require.NoError(t, err)
	_, err = store.CreateSignupRequest(ctx, db.CreateSignupRequestParams{
		Email: uniqueEmail("stale"), Username: uniqueUsername("stale"), FullName: "Stale",
		HashedPassword: "x", TokenHash: staleHash, ExpiresAt: time.Now().Add(-time.Hour),
	})
	require.NoError(t, err)

	_, hash, err := newAccountToken()
	require.NoError(t, err)
	_, err = store.RequestSignupTx(ctx, db.CreateSignupRequestParams{
		Email: email, Username: uniqueUsername("clean"), FullName: "Clean", HashedPassword: "x", TokenHash: hash, ExpiresAt: time.Now().Add(time.Hour),
	})
	require.NoError(t, err)

	count := func(where string, arg []byte) int {
		var n int
		require.NoError(t, conn.QueryRow(`SELECT count(*) FROM signup_requests WHERE `+where, arg).Scan(&n))
		return n
	}
	require.Zero(t, count("token_hash = $1", staleHash), "storing a signup deletes expired ones")

	user, err := store.ConfirmSignupTx(ctx, hash)
	require.NoError(t, err)
	require.Equal(t, db.SignupRole, user.Role)
	require.Zero(t, count("token_hash = $1", hash), "the confirmed signup's row (and its password hash) is gone")

	_, err = store.ConfirmSignupTx(ctx, hash)
	require.ErrorIs(t, err, db.ErrTokenInvalid)
}
