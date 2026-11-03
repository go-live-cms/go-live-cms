package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

func TestPasswordMatchesDetails(t *testing.T) {
	details := []string{"marisol@example.com", "marisolduarte", "Marisol Duarte", ""}
	for _, password := range []string{"marisol@example.com", "MARISOL@EXAMPLE.COM", "MarisolDuarte", "marisol duarte", "  Marisol Duarte  "} {
		require.True(t, passwordMatchesDetails(password, details...), password)
	}
	for _, password := range []string{"marisol", "marisolduarte1", "Marisol  Duarte", "", "   "} {
		require.False(t, passwordMatchesDetails(password, details...), password)
	}
}

func TestIsLongEnoughPassword(t *testing.T) {
	require.Equal(t, 12, MinPasswordLength, "the web's PASSWORD_MIN and the design say 12")
	require.False(t, isLongEnoughPassword(strings.Repeat("a", MinPasswordLength-1)))
	require.True(t, isLongEnoughPassword(strings.Repeat("a", MinPasswordLength)))
	// Characters, not bytes: 11 two-byte runes are 22 bytes and still too short.
	require.False(t, isLongEnoughPassword(strings.Repeat("é", MinPasswordLength-1)))
	require.True(t, isLongEnoughPassword(strings.Repeat("é", MinPasswordLength)))
}

// passwordEndpoint is one way a password gets set (#329).
type passwordEndpoint struct {
	name string
	// status on success.
	status int
	// expectReads stubs what the endpoint reads before writing, any number
	// of times, so a rejected request needs nothing else.
	expectReads func(store *mockdb.MockStore)
	// expectWrite expects the write to happen once, with password.
	expectWrite func(t *testing.T, store *mockdb.MockStore, password string)
	send        func(t *testing.T, server *Server, password string) *httptest.ResponseRecorder
}

// Every endpoint that sets a password applies the same rules: at least
// MinPasswordLength characters, at most 72 bytes, and not the account's
// email, username or name (case-insensitively).
func TestNewPasswordRulesOnEveryEndpoint(t *testing.T) {
	// The account whose password is set. Its username is long enough to be a
	// valid password, so matching it is what refuses it.
	user := db.User{
		ID: 4300, Username: "marisolduarte", FullName: "Marisol Duarte", Email: "marisol@example.com",
		Role: RoleEditor, PasswordChangedAt: time.Now().Add(-time.Hour),
	}
	// Set before #329: shorter than the new minimum, still the current one.
	const currentPassword = "old-pass"
	hashed, err := util.HashPassword(currentPassword)
	require.NoError(t, err)
	user.HashedPassword = hashed

	admin := db.User{ID: 4301, Username: "siteadmin", FullName: "Site Admin", Email: "admin@example.com", Role: RoleAdmin}
	token, tokenHash, err := newAccountToken()
	require.NoError(t, err)

	expectUpdate := func(t *testing.T, store *mockdb.MockStore, password string) {
		store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(1).
			DoAndReturn(func(_ any, arg db.UpdateUserTxParams) (db.UpdateUserTxResult, error) {
				require.True(t, arg.PasswordChanged)
				require.NoError(t, util.CheckPassword(password, arg.HashedPassword))
				updated := user
				updated.HashedPassword = arg.HashedPassword
				updated.PasswordChangedAt = time.Now()
				return db.UpdateUserTxResult{User: updated}, nil
			})
	}
	userURL := "/api/v1/users/" + strconv.FormatInt(user.ID, 10)

	endpoints := []passwordEndpoint{
		{
			name:   "accept invite",
			status: http.StatusCreated,
			expectReads: func(store *mockdb.MockStore) {
				store.EXPECT().GetValidUserInvitationByTokenHash(gomock.Any(), tokenHash).
					Return(db.UserInvitation{ID: 5, Email: user.Email, Role: user.Role}, nil).AnyTimes()
			},
			expectWrite: func(t *testing.T, store *mockdb.MockStore, password string) {
				store.EXPECT().AcceptInvitationTx(gomock.Any(), eqAcceptInvitationTx{token, user.Username, user.FullName, password}).
					Return(db.AcceptInvitationTxResult{User: user, Invitation: db.UserInvitation{ID: 5}}, nil)
			},
			send: func(t *testing.T, server *Server, password string) *httptest.ResponseRecorder {
				return doJSON(t, server, http.MethodPost, "/api/v1/auth/invitations/accept",
					gin.H{"token": token, "username": user.Username, "full_name": user.FullName, "password": password}, nil)
			},
		},
		{
			name:   "reset password",
			status: http.StatusOK,
			expectReads: func(store *mockdb.MockStore) {
				store.EXPECT().GetValidPasswordResetTokenByHash(gomock.Any(), tokenHash).
					Return(db.PasswordResetToken{ID: 1, UserID: user.ID}, nil).AnyTimes()
				stubRoleLookup(store, user)
			},
			expectWrite: func(t *testing.T, store *mockdb.MockStore, password string) {
				store.EXPECT().ResetPasswordTx(gomock.Any(), eqResetPasswordTx{token, password}).Return(user, nil)
			},
			send: func(t *testing.T, server *Server, password string) *httptest.ResponseRecorder {
				return doJSON(t, server, http.MethodPost, "/api/v1/auth/password/reset", gin.H{"token": token, "password": password}, nil)
			},
		},
		{
			name:   "self password change",
			status: http.StatusOK,
			expectReads: func(store *mockdb.MockStore) {
				stubRoleLookup(store, user)
			},
			expectWrite: func(t *testing.T, store *mockdb.MockStore, password string) {
				expectUpdate(t, store, password)
				store.EXPECT().CreateSession(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ any, arg db.CreateSessionParams) (db.Session, error) {
						return db.Session{ID: arg.ID, UserID: arg.UserID}, nil
					})
			},
			send: func(t *testing.T, server *Server, password string) *httptest.ResponseRecorder {
				return doJSON(t, server, http.MethodPut, userURL,
					gin.H{"password": password, "current_password": currentPassword}, asUser(t, server, user))
			},
		},
		{
			name:   "admin sets a user's password",
			status: http.StatusOK,
			expectReads: func(store *mockdb.MockStore) {
				stubRoleLookup(store, admin)
				stubRoleLookup(store, user)
			},
			expectWrite: expectUpdate,
			send: func(t *testing.T, server *Server, password string) *httptest.ResponseRecorder {
				return doJSON(t, server, http.MethodPut, userURL, gin.H{"password": password}, asUser(t, server, admin))
			},
		},
		{
			name:   "admin creates a user",
			status: http.StatusCreated,
			expectReads: func(store *mockdb.MockStore) {
				stubRoleLookup(store, admin)
			},
			expectWrite: func(t *testing.T, store *mockdb.MockStore, password string) {
				store.EXPECT().CreateUser(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ any, arg db.CreateUserParams) (db.User, error) {
						require.NoError(t, util.CheckPassword(password, arg.HashedPassword))
						return user, nil
					})
			},
			send: func(t *testing.T, server *Server, password string) *httptest.ResponseRecorder {
				return doJSON(t, server, http.MethodPost, "/api/v1/users", gin.H{
					"username": user.Username, "email": user.Email, "full_name": user.FullName,
					"password": password, "role": user.Role,
				}, asUser(t, server, admin))
			},
		},
	}

	accepted := map[string]string{
		"12 characters":            "abcdefghijkl",
		"12 two-byte characters":   strings.Repeat("é", 12),
		"72 bytes":                 strings.Repeat("a", 72),
		"contains the email":       "my " + user.Email,
		"the name without a space": "MarisolDuarte1",
	}
	rejected := map[string]struct{ password, message string }{
		"11 characters":                {"abcdefghijk", "must be at least 12 characters"},
		"11 two-byte characters":       {strings.Repeat("é", 11), "must be at least 12 characters"},
		"73 bytes":                     {strings.Repeat("a", 73), "must be at most 72 bytes"},
		"the email, any case":          {"MARISOL@Example.com", errPasswordMatchesDetails},
		"the username":                 {"MarisolDuarte", errPasswordMatchesDetails},
		"the full name, any case":      {"marisol duarte", errPasswordMatchesDetails},
		"the full name, padded":        {"  Marisol Duarte ", errPasswordMatchesDetails},
		"the old short password (min)": {currentPassword, "must be at least 12 characters"},
	}

	for _, endpoint := range endpoints {
		t.Run(endpoint.name, func(t *testing.T) {
			for name, password := range accepted {
				t.Run(name+" is accepted", func(t *testing.T) {
					ctrl := gomock.NewController(t)
					store := mockdb.NewMockStore(ctrl)
					endpoint.expectReads(store)
					endpoint.expectWrite(t, store, password)
					server, _ := newAccountTestServer(t, store)

					recorder := endpoint.send(t, server, password)
					require.Equal(t, endpoint.status, recorder.Code, recorder.Body.String())
				})
			}
			for name, tc := range rejected {
				t.Run(name+" is a 400 field error", func(t *testing.T) {
					ctrl := gomock.NewController(t)
					store := mockdb.NewMockStore(ctrl)
					endpoint.expectReads(store) // and no write
					server, _ := newAccountTestServer(t, store)

					recorder := endpoint.send(t, server, tc.password)
					require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
					body := decodeErrorBody(t, recorder)
					require.Equal(t, map[string]string{"password": tc.message}, body.Fields)
					require.Equal(t, "password "+tc.message, body.Error)
				})
			}
		})
	}

	t.Run("update: not the details the same request sets either", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		stubRoleLookup(store, user)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPut, userURL,
			gin.H{"email": "new-address@example.com", "password": "New-Address@example.com"}, asUser(t, server, admin))
		require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
		require.Equal(t, map[string]string{"password": errPasswordMatchesDetails}, decodeErrorBody(t, recorder).Fields)
	})

	// The details check runs before the self-change limit: a refused
	// password doesn't use up the allowance a real change needs.
	t.Run("self change: a refused password doesn't count against the limit", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, user)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.RateLimitPasswordChangePerMinute = 1 })
		server.runInBackground = func(_, _ string, f func()) { f() }

		for range 3 {
			recorder := doJSON(t, server, http.MethodPut, userURL,
				gin.H{"password": user.Email, "current_password": currentPassword}, asUser(t, server, user))
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
		}
		expectUpdate(t, store, "a-new-password")
		store.EXPECT().CreateSession(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ any, arg db.CreateSessionParams) (db.Session, error) {
				return db.Session{ID: arg.ID, UserID: arg.UserID}, nil
			})
		recorder := doJSON(t, server, http.MethodPut, userURL,
			gin.H{"password": "a-new-password", "current_password": currentPassword}, asUser(t, server, user))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	})

	// The minimum applies when a password is set, so one set before it went
	// up still signs in.
	t.Run("an existing short password still logs in", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUserByUsername(gomock.Any(), user.Username).Return(user, nil)
		store.EXPECT().CreateSession(gomock.Any(), gomock.Any()).Return(randomSession(user), nil)
		server, _ := newAccountTestServer(t, store)

		recorder := doJSON(t, server, http.MethodPost, "/api/v1/auth/login", gin.H{"username": user.Username, "password": currentPassword}, nil)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	})
}
