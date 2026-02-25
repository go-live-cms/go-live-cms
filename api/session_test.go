package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
)

func randomUserForSessions() db.User {
	gofakeit.Seed(0)
	password := gofakeit.Password(true, true, true, true, false, 12)
	hashedPassword, _ := util.HashPassword(password)

	return db.User{
		ID:                gofakeit.Int64(),
		Username:          gofakeit.Username(),
		FullName:          gofakeit.Name(),
		Email:             gofakeit.Email(),
		HashedPassword:    hashedPassword,
		PasswordChangedAt: gofakeit.Date(),
		CreatedAt:         gofakeit.Date(),
		Role:              "user",
	}
}

func randomSession(user db.User) db.Session {
	gofakeit.Seed(0)
	return db.Session{
		ID:               uuid.New(),
		UserID:           user.ID,
		Username:         user.Username,
		RefreshTokenHash: []byte(gofakeit.UUID()),
		UserAgent:        gofakeit.UserAgent(),
		ClientIp:         gofakeit.IPv4Address(),
		IsBlocked:        false,
		ExpiresAt:        time.Now().Add(24 * time.Hour),
		CreatedAt:        time.Now(),
	}
}

func TestLoginUserAPI(t *testing.T) {
	user := randomUserForSessions()
	password := "testPassword123"
	hashedPassword, _ := util.HashPassword(password)
	user.HashedPassword = hashedPassword

	testCases := []struct {
		name          string
		body          gin.H
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: gin.H{
				"username": user.Username,
				"password": password,
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUserByUsername(gomock.Any(), gomock.Eq(user.Username)).
					Times(1).
					Return(user, nil)

				store.EXPECT().
					CreateSession(gomock.Any(), gomock.Any()).
					Times(1).
					Return(randomSession(user), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchLoginResponse(t, recorder.Body.String(), user)
			},
		},
		{
			name: "UserNotFound",
			body: gin.H{
				"username": "nonexistent",
				"password": password,
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUserByUsername(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "IncorrectPassword",
			body: gin.H{
				"username": user.Username,
				"password": "wrongpassword",
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUserByUsername(gomock.Any(), gomock.Eq(user.Username)).
					Times(1).
					Return(user, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InvalidRequest",
			body: gin.H{
				"username": "",
				"password": password,
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUserByUsername(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "CreateSessionError",
			body: gin.H{
				"username": user.Username,
				"password": password,
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUserByUsername(gomock.Any(), gomock.Eq(user.Username)).
					Times(1).
					Return(user, nil)

				store.EXPECT().
					CreateSession(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.Session{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := "/api/v1/auth/login"
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("User-Agent", "test-client/1.0")

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestRenewAccessTokenAPI(t *testing.T) {
	user := randomUserForSessions()
	session := randomSession(user)

	testCases := []struct {
		name          string
		buildStubs    func(store *mockdb.MockStore, refreshToken string)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				session.RefreshTokenHash = token.HashRefresh(refreshToken)
				session.Username = user.Username
				session.UserID = user.ID
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Eq(token.HashRefresh(refreshToken))).
					Times(1).
					Return(session, nil)
				store.EXPECT().
					ExecTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchRenewResponse(t, recorder.Body.String())
			},
		},
		{
			name: "InvalidRefreshToken",
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "SessionNotFound",
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Eq(token.HashRefresh(refreshToken))).
					Times(1).
					Return(db.Session{}, sql.ErrNoRows)
				store.EXPECT().
					GetAnySessionByRefreshTokenHash(gomock.Any(), gomock.Eq(token.HashRefresh(refreshToken))).
					Times(1).
					Return(db.Session{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "BlockedSession",
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				blockedSession := session
				blockedSession.IsBlocked = true
				blockedSession.RefreshTokenHash = token.HashRefresh(refreshToken)
				blockedSession.Username = user.Username
				blockedSession.UserID = user.ID
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Eq(token.HashRefresh(refreshToken))).
					Times(1).
					Return(blockedSession, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
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

			var refreshToken string
			var err error

			if tc.name != "InvalidRefreshToken" {
				refreshToken, err = server.tokenMaker.CreateRefreshToken(user.ID, user.Username, time.Hour)
				require.NoError(t, err)
			}

			tc.buildStubs(store, refreshToken)

			recorder := httptest.NewRecorder()
			url := "/api/v1/auth/refresh"
			request, err := http.NewRequest(http.MethodPost, url, nil)
			require.NoError(t, err)
			request.Header.Set("User-Agent", session.UserAgent)

			if tc.name == "InvalidRefreshToken" {
				request.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: "invalid-token"})
			} else if refreshToken != "" {
				request.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: refreshToken})
			}

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetUserSessionsAPI(t *testing.T) {
	user := randomUserForSessions()
	sessions := []db.Session{
		randomSession(user),
		randomSession(user),
		randomSession(user),
	}

	testCases := []struct {
		name          string
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListSessionsByUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(sessions, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchSessionsList(t, recorder.Body.String(), sessions)
			},
		},
		{
			name: "NoAuthorization",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {

			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListSessionsByUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InternalError",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListSessionsByUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return([]db.Session{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := "/api/v1/sessions"
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestBlockSessionAPI(t *testing.T) {
	user := randomUserForSessions()
	session := randomSession(user)
	otherUser := randomUserForSessions()
	otherSession := randomSession(otherUser)

	testCases := []struct {
		name          string
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: gin.H{
				"session_id": session.ID,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetSession(gomock.Any(), gomock.Eq(session.ID)).
					Times(1).
					Return(session, nil)

				store.EXPECT().
					BlockSession(gomock.Any(), gomock.Eq(session.ID)).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name: "SessionNotFound",
			body: gin.H{
				"session_id": uuid.New(),
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetSession(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.Session{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "ForbiddenSession",
			body: gin.H{
				"session_id": otherSession.ID,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetSession(gomock.Any(), gomock.Eq(otherSession.ID)).
					Times(1).
					Return(otherSession, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name: "NoAuthorization",
			body: gin.H{
				"session_id": session.ID,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {

			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetSession(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := "/api/v1/sessions/block"
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestLogoutUserAPI(t *testing.T) {
	user := randomUserForSessions()
	session := randomSession(user)
	session.ClientIp = "192.0.2.1"
	session.Username = user.Username
	session.UserID = user.ID

	testCases := []struct {
		name          string
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore, refreshToken string)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK_WithRefreshToken",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				session.RefreshTokenHash = token.HashRefresh(refreshToken)
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Eq(token.HashRefresh(refreshToken))).
					Times(1).
					Return(session, nil)
				store.EXPECT().
					BlockSession(gomock.Any(), gomock.Eq(session.ID)).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name: "OK_WithoutRefreshToken",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				// No cookie present — handler returns 200 immediately without DB calls
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name: "NoAuthorization",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// No auth header
			},
			buildStubs: func(store *mockdb.MockStore, refreshToken string) {
				store.EXPECT().
					GetSessionByRefreshTokenHash(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
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

			var refreshToken string
			var err error

			if tc.name == "OK_WithRefreshToken" {
				refreshToken, err = server.tokenMaker.CreateRefreshToken(user.ID, user.Username, time.Hour)
				require.NoError(t, err)
			}

			tc.buildStubs(store, refreshToken)

			recorder := httptest.NewRecorder()
			url := "/api/v1/auth/logout"
			request, err := http.NewRequest(http.MethodPost, url, nil)
			require.NoError(t, err)

			if refreshToken != "" {
				request.AddCookie(&http.Cookie{Name: RefreshCookieName, Value: refreshToken})
			}

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func addAuthorization(
	t *testing.T,
	request *http.Request,
	tokenMaker token.Maker,
	authorizationType string,
	userID int64,
	username string,
	duration time.Duration,
) {
	token, err := tokenMaker.CreateToken(userID, username, duration)
	require.NoError(t, err)

	authorizationHeader := fmt.Sprintf("%s %s", authorizationType, token)
	request.Header.Set(authorizationHeaderKey, authorizationHeader)
}

func requireBodyMatchLoginResponse(t *testing.T, body string, user db.User) {
	var response LoginUserResponse
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.NotEmpty(t, response.SessionID)
	require.NotEmpty(t, response.AccessToken)
	require.NotZero(t, response.AccessTokenExpiresAt)
	require.Equal(t, user.Username, response.User.Username)
	require.Equal(t, user.Email, response.User.Email)
	require.Equal(t, user.FullName, response.User.FullName)
}

func requireBodyMatchRenewResponse(t *testing.T, body string) {
	var response RenewAccessTokenResponse
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.NotEmpty(t, response.AccessToken)
	require.NotZero(t, response.AccessTokenExpiresAt)
}

func requireBodyMatchSessionsList(t *testing.T, body string, sessions []db.Session) {
	var response struct {
		Sessions []SessionResponse `json:"sessions"`
		Count    int               `json:"count"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(sessions), response.Count)
	require.Equal(t, len(sessions), len(response.Sessions))

	for i, session := range sessions {
		require.Equal(t, session.ID, response.Sessions[i].ID)
		require.Equal(t, session.UserID, response.Sessions[i].UserID)
		require.Equal(t, session.Username, response.Sessions[i].Username)
		require.Equal(t, session.IsBlocked, response.Sessions[i].IsBlocked)
	}
}
