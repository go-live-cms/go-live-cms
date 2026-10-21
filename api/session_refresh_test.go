package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

// responseCookie returns the Set-Cookie named name from the response, or nil.
func responseCookie(recorder *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range recorder.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// TestRenewAccessTokenRejections covers the refresh paths TestRenewAccessTokenAPI
// doesn't: what the cookie may hold, and every check between the session
// lookup and the rotation. None of them may rotate the session or set a new
// refresh cookie.
func TestRenewAccessTokenRejections(t *testing.T) {
	user := randomUserForSessions()

	// activeSession is a session that matches the refresh token's claims.
	activeSession := func(refreshToken string) db.Session {
		s := randomSession(user)
		s.RefreshTokenHash = token.HashRefresh(refreshToken)
		return s
	}
	validRefresh := func(t *testing.T, server *Server) string {
		tok, err := server.tokenMaker.CreateRefreshToken(user.ID, user.Username, time.Hour)
		require.NoError(t, err)
		return tok
	}
	noRotation := func(store *mockdb.MockStore) {
		store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(0)
	}

	testCases := []struct {
		name          string
		cookie        func(t *testing.T, server *Server) string
		buildStubs    func(store *mockdb.MockStore, refreshToken string)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "MissingCookie",
			cookie: func(t *testing.T, server *Server) string { return "" },
			buildStubs: func(store *mockdb.MockStore, _ string) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			// An access token is v4.public; ParseRefresh only takes v4.local.
			name: "AccessTokenInCookie",
			cookie: func(t *testing.T, server *Server) string {
				tok, err := server.tokenMaker.CreateToken(user.ID, user.Username, time.Minute)
				require.NoError(t, err)
				return tok
			},
			buildStubs: func(store *mockdb.MockStore, _ string) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "ExpiredRefreshToken",
			cookie: func(t *testing.T, server *Server) string {
				tok, err := server.tokenMaker.CreateRefreshToken(user.ID, user.Username, -time.Minute)
				require.NoError(t, err)
				return tok
			},
			buildStubs: func(store *mockdb.MockStore, _ string) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "RefreshTokenFromAnotherServer",
			cookie: func(t *testing.T, server *Server) string {
				return validRefresh(t, newTestServer(t, server.store))
			},
			buildStubs: func(store *mockdb.MockStore, _ string) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "SessionLookupFails",
			cookie: validRefresh,
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Eq(token.HashRefresh(refreshToken))).
					Times(1).
					Return(db.Session{}, sql.ErrConnDone)
				// A DB error is not evidence of reuse.
				store.EXPECT().GetAnySessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().BlockAllSessionsForUser(gomock.Any(), gomock.Any()).Times(0)
				noRotation(store)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			// Active-looking but already replaced: the token was spent once.
			name:   "ReplacedSessionIsReuse",
			cookie: validRefresh,
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				s := activeSession(refreshToken)
				s.ReplacedBy = uuid.NullUUID{UUID: uuid.New(), Valid: true}
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).
					Times(1).
					Return(s, nil)
				store.EXPECT().
					BlockAllSessionsForUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(nil)
				noRotation(store)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			// Failing to block the user's sessions must not turn reuse into a
			// successful refresh.
			name:   "ReplacedSessionBlockAllFails",
			cookie: validRefresh,
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				s := activeSession(refreshToken)
				s.ReplacedBy = uuid.NullUUID{UUID: uuid.New(), Valid: true}
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(1).Return(s, nil)
				store.EXPECT().
					BlockAllSessionsForUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(errors.New("db down"))
				noRotation(store)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name:   "SessionExpired",
			cookie: validRefresh,
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				s := activeSession(refreshToken)
				s.ExpiresAt = time.Now().Add(-time.Minute)
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(1).Return(s, nil)
				noRotation(store)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
				require.Contains(t, recorder.Body.String(), "session expired")
			},
		},
		{
			// The session row belongs to someone else than the token claims.
			name:   "SessionUserMismatch",
			cookie: validRefresh,
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				s := activeSession(refreshToken)
				s.UserID = user.ID + 1
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(1).Return(s, nil)
				noRotation(store)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
				require.Contains(t, recorder.Body.String(), "token/session mismatch")
			},
		},
		{
			name:   "SessionUsernameMismatch",
			cookie: validRefresh,
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				s := activeSession(refreshToken)
				s.Username = user.Username + "-other"
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(1).Return(s, nil)
				noRotation(store)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "RotationFails",
			cookie: validRefresh,
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).
					Times(1).
					Return(activeSession(refreshToken), nil)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(1).Return(errors.New("serialization failure"))
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
				require.NotContains(t, recorder.Body.String(), "access_token")
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			server := newTestServer(t, store)
			refreshToken := tc.cookie(t, server)
			tc.buildStubs(store, refreshToken)

			request, err := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
			require.NoError(t, err)
			if refreshToken != "" {
				request.AddCookie(&http.Cookie{Name: HostRefreshCookieName, Value: refreshToken})
			}

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
			require.Nil(t, responseCookie(recorder, HostRefreshCookieName), "no refresh cookie on a failed refresh")
		})
	}
}

// TestRenewAccessTokenIssuesUsableTokens checks what a successful refresh
// hands back: a new refresh cookie (not the one presented), an uncacheable
// response, and an access token that verifies for the same user.
func TestRenewAccessTokenIssuesUsableTokens(t *testing.T) {
	user := randomUserForSessions()

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	refreshToken, err := server.tokenMaker.CreateRefreshToken(user.ID, user.Username, time.Hour)
	require.NoError(t, err)
	session := randomSession(user)
	session.RefreshTokenHash = token.HashRefresh(refreshToken)

	store.EXPECT().
		GetSessionByRefreshTokenHash(gomock.Any(), gomock.Eq(session.RefreshTokenHash)).
		Times(1).
		Return(session, nil)
	store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(1).Return(nil)

	request, err := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	require.NoError(t, err)
	request.AddCookie(&http.Cookie{Name: HostRefreshCookieName, Value: refreshToken})

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))

	cookie := responseCookie(recorder, HostRefreshCookieName)
	require.NotNil(t, cookie)
	require.NotEmpty(t, cookie.Value)
	require.NotEqual(t, refreshToken, cookie.Value, "refresh must rotate the token")
	require.True(t, cookie.HttpOnly)
	require.True(t, cookie.Secure)

	var rsp RenewAccessTokenResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	payload, err := server.tokenMaker.VerifyToken(rsp.AccessToken)
	require.NoError(t, err)
	require.Equal(t, user.ID, payload.UserID)
	require.Equal(t, user.Username, payload.Username)
}

// TestLogoutUserEdgeCases covers logout beyond the happy paths: an unknown
// session still logs out, while DB failures surface as 500 instead of
// pretending the session was revoked.
func TestLogoutUserEdgeCases(t *testing.T) {
	user := randomUserForSessions()

	testCases := []struct {
		name          string
		buildStubs    func(store *mockdb.MockStore, session db.Session)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK_ClearsCookie",
			buildStubs: func(store *mockdb.MockStore, session db.Session) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Eq(session.RefreshTokenHash)).Times(1).Return(session, nil)
				store.EXPECT().BlockSession(gomock.Any(), gomock.Eq(session.ID)).Times(1).Return(nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				cookie := responseCookie(recorder, HostRefreshCookieName)
				require.NotNil(t, cookie)
				require.Empty(t, cookie.Value)
				require.Less(t, cookie.MaxAge, 0)
			},
		},
		{
			name: "UnknownSessionStillLogsOut",
			buildStubs: func(store *mockdb.MockStore, session db.Session) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(1).Return(db.Session{}, sql.ErrNoRows)
				store.EXPECT().BlockSession(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				cookie := responseCookie(recorder, HostRefreshCookieName)
				require.NotNil(t, cookie)
				require.Less(t, cookie.MaxAge, 0)
			},
		},
		{
			name: "SessionLookupFails",
			buildStubs: func(store *mockdb.MockStore, session db.Session) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(1).Return(db.Session{}, sql.ErrConnDone)
				store.EXPECT().BlockSession(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name: "BlockSessionFails",
			buildStubs: func(store *mockdb.MockStore, session db.Session) {
				store.EXPECT().GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).Times(1).Return(session, nil)
				store.EXPECT().BlockSession(gomock.Any(), gomock.Eq(session.ID)).Times(1).Return(errors.New("db down"))
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
				require.Contains(t, recorder.Body.String(), "failed to block session")
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			server := newTestServer(t, store)

			refreshToken, err := server.tokenMaker.CreateRefreshToken(user.ID, user.Username, time.Hour)
			require.NoError(t, err)
			session := randomSession(user)
			session.RefreshTokenHash = token.HashRefresh(refreshToken)

			tc.buildStubs(store, session)
			stubRoleLookup(store, user)

			request, err := http.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
			require.NoError(t, err)
			request.AddCookie(&http.Cookie{Name: HostRefreshCookieName, Value: refreshToken})
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)

			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
		})
	}
}
