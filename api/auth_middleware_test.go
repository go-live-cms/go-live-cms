package api

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// TestAuthMiddlewareRejections covers every way authMiddleware turns a
// request away. Header and token failures must be decided before the caller
// row is read, so a bad token never costs a query.
func TestAuthMiddlewareRejections(t *testing.T) {
	user := randomUserNew()

	accessToken := func(t *testing.T, server *Server, dur time.Duration) string {
		tok, err := server.tokenMaker.CreateToken(user.ID, user.Username, dur)
		require.NoError(t, err)
		return tok
	}
	noLookup := func(store *mockdb.MockStore) {
		store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
	}

	testCases := []struct {
		name          string
		header        func(t *testing.T, server *Server) string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:       "MissingHeader",
			header:     func(t *testing.T, server *Server) string { return "" },
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
				require.Contains(t, recorder.Body.String(), "authorization header is not provided")
			},
		},
		{
			name:       "TokenWithoutScheme",
			header:     func(t *testing.T, server *Server) string { return accessToken(t, server, time.Minute) },
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
				require.Contains(t, recorder.Body.String(), "invalid authorization header format")
			},
		},
		{
			name:       "UnsupportedScheme",
			header:     func(t *testing.T, server *Server) string { return "Basic " + accessToken(t, server, time.Minute) },
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
				require.Contains(t, recorder.Body.String(), "unsupported authorization type basic")
			},
		},
		{
			name:   "SchemeIsCaseInsensitive",
			header: func(t *testing.T, server *Server) string { return "BEARER " + accessToken(t, server, time.Minute) },
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(user, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:       "GarbageToken",
			header:     func(t *testing.T, server *Server) string { return "Bearer not-a-token" },
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:       "ExpiredToken",
			header:     func(t *testing.T, server *Server) string { return "Bearer " + accessToken(t, server, -time.Minute) },
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
				require.Contains(t, recorder.Body.String(), "expired")
			},
		},
		{
			name: "TokenFromAnotherServer",
			header: func(t *testing.T, server *Server) string {
				other := newTestServer(t, server.store)
				return "Bearer " + accessToken(t, other, time.Minute)
			},
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			// A refresh token is v4.local; it must never pass as a bearer token.
			name: "RefreshTokenAsBearer",
			header: func(t *testing.T, server *Server) string {
				tok, err := server.tokenMaker.CreateRefreshToken(user.ID, user.Username, time.Hour)
				require.NoError(t, err)
				return "Bearer " + tok
			},
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			// Collab tickets are signed with the access key but are WS-only (#233).
			name: "CollabTicketAsBearer",
			header: func(t *testing.T, server *Server) string {
				ticket, _, err := server.collabTickets.CreateWSTicket(user.ID, user.Username, "post-1", time.Minute)
				require.NoError(t, err)
				return "Bearer " + ticket
			},
			buildStubs: noLookup,
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "DeletedUserForbidden",
			header: func(t *testing.T, server *Server) string { return "Bearer " + accessToken(t, server, time.Minute) },
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:   "UserLookupFails",
			header: func(t *testing.T, server *Server) string { return "Bearer " + accessToken(t, server, time.Minute) },
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(db.User{}, sql.ErrConnDone)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
				require.Contains(t, recorder.Body.String(), "failed to verify user")
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
			server.router.GET(
				"/auth-test",
				authMiddleware(server.tokenMaker, server.store),
				func(c *gin.Context) { c.Status(http.StatusOK) },
			)

			recorder := httptest.NewRecorder()
			request, err := http.NewRequest(http.MethodGet, "/auth-test", nil)
			require.NoError(t, err)
			if header := tc.header(t, server); header != "" {
				request.Header.Set(authorizationHeaderKey, header)
			}

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
		})
	}
}

// TestCallerUserWithoutCachedRow covers callerUser's fallback lookup, used
// when a handler runs without authMiddleware having cached the caller row.
func TestCallerUserWithoutCachedRow(t *testing.T) {
	user := randomUserNew()

	testCases := []struct {
		name       string
		lookupErr  error
		wantOK     bool
		wantStatus int
	}{
		{name: "Found", wantOK: true},
		{name: "DeletedUser", lookupErr: sql.ErrNoRows, wantStatus: http.StatusForbidden},
		{name: "LookupFails", lookupErr: errors.New("connection reset"), wantStatus: http.StatusInternalServerError},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(user, tc.lookupErr)
			server := newTestServer(t, store)

			tok, err := server.tokenMaker.CreateToken(user.ID, user.Username, time.Minute)
			require.NoError(t, err)
			payload, err := server.tokenMaker.VerifyToken(tok)
			require.NoError(t, err)

			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
			c.Set(authorizationPayloadKey, payload)

			got, ok := server.callerUser(c)
			require.Equal(t, tc.wantOK, ok)
			if tc.wantOK {
				require.Equal(t, user.ID, got.ID)
				require.False(t, c.IsAborted())
				return
			}
			require.True(t, c.IsAborted())
			require.Equal(t, tc.wantStatus, recorder.Code)
		})
	}
}
