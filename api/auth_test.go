package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// accessTokenIssuedAt signs a v4.public access token exactly like
// PasetoV4Maker.CreateToken but with a caller-chosen iat, so tests can hold a
// token minted before a password change without sleeping across seconds.
func accessTokenIssuedAt(t *testing.T, server *Server, user db.User, issuedAt time.Time) string {
	t.Helper()

	key, err := p.NewV4AsymmetricSecretKeyFromHex(server.config.PasetoV4PrivateKeyHex)
	require.NoError(t, err)

	tok := p.NewToken()
	tok.SetIssuedAt(issuedAt)
	tok.SetNotBefore(issuedAt.Add(-15 * time.Second))
	tok.SetExpiration(time.Now().Add(time.Minute))
	tok.SetIssuer(server.config.PasetoIssuer)
	tok.SetAudience(server.config.PasetoAudience)
	tok.SetSubject(user.Username)
	tok.SetJti(uuid.NewString())
	require.NoError(t, tok.Set("user_id", strconv.FormatInt(user.ID, 10)))
	require.NoError(t, tok.Set("username", user.Username))
	require.NoError(t, tok.Set("token_type", "access"))

	return tok.V4Sign(key, nil)
}

func TestIssuedBeforePasswordChange(t *testing.T) {
	changedAt := time.Date(2026, 10, 20, 12, 0, 0, 500_000_000, time.UTC)

	testCases := []struct {
		name     string
		issuedAt time.Time
		want     bool
	}{
		{"EarlierSecond", changedAt.Add(-time.Second), true},
		{"MuchEarlier", changedAt.Add(-time.Hour), true},
		// iat is serialized without fractional seconds, so a token minted
		// right after the change can carry an iat that is "before" it.
		{"SameSecondTruncatedIat", changedAt.Truncate(time.Second), false},
		{"SameSecondLater", changedAt.Add(400 * time.Millisecond), false},
		{"LaterSecond", changedAt.Add(time.Second), false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, issuedBeforePasswordChange(tc.issuedAt, changedAt))
		})
	}

	t.Run("NeverChanged", func(t *testing.T) {
		// users.password_changed_at defaults to 0001-01-01.
		require.False(t, issuedBeforePasswordChange(time.Now(), time.Time{}))
	})
}

// TestAuthMiddlewarePasswordChange exercises the iat-vs-password_changed_at
// check in authMiddleware on a synthetic route.
func TestAuthMiddlewarePasswordChange(t *testing.T) {
	testCases := []struct {
		name              string
		issuedAt          func() time.Time
		passwordChangedAt func() time.Time
		checkResponse     func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:              "RejectsTokenIssuedBeforePasswordChange",
			issuedAt:          func() time.Time { return time.Now().Add(-2 * time.Minute) },
			passwordChangedAt: func() time.Time { return time.Now().Add(-time.Minute) },
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
				require.Contains(t, recorder.Body.String(), "issued before the latest password change")
			},
		},
		{
			name:              "AcceptsTokenIssuedAfterPasswordChange",
			issuedAt:          time.Now,
			passwordChangedAt: func() time.Time { return time.Now().Add(-time.Minute) },
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			// The fresh session issued by a self password change shares its
			// second with password_changed_at; a raw comparison would reject
			// it because iat loses its fractional part.
			name:              "AcceptsTokenIssuedInSameSecondAsPasswordChange",
			issuedAt:          time.Now,
			passwordChangedAt: func() time.Time { return time.Now().Truncate(time.Second).Add(999 * time.Millisecond) },
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:              "AcceptsUserWhoNeverChangedPassword",
			issuedAt:          time.Now,
			passwordChangedAt: func() time.Time { return time.Time{} },
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			user := randomUserNew()
			user.PasswordChangedAt = tc.passwordChangedAt()

			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().
				GetUser(gomock.Any(), gomock.Eq(user.ID)).
				Times(1).
				Return(user, nil)

			server := newTestServer(t, store)
			server.router.GET(
				"/auth-test",
				authMiddleware(server.tokenMaker, server.store),
				func(c *gin.Context) { c.Status(http.StatusOK) },
			)

			recorder := httptest.NewRecorder()
			request, err := http.NewRequest(http.MethodGet, "/auth-test", nil)
			require.NoError(t, err)
			request.Header.Set(authorizationHeaderKey, "Bearer "+accessTokenIssuedAt(t, server, user, tc.issuedAt()))

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
		})
	}
}

// TestPasswordChangeRevokesAccessTokens walks the real routes: an access
// token that works before a self password change gets 401 right after it,
// on routes with and without requireRole, while a token minted after the
// change works.
func TestPasswordChangeRevokesAccessTokens(t *testing.T) {
	const currentPassword = "current-secret"
	const newPassword = "brand-new-secret"

	hashedCurrent, err := util.HashPassword(currentPassword)
	require.NoError(t, err)

	user := randomUserNew()
	user.Role = RoleAdmin
	user.HashedPassword = hashedCurrent
	user.PasswordChangedAt = time.Now().Add(-time.Hour)

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// stored stands in for the users row; UpdateUserTx writes to it.
	stored := user
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().
		GetUser(gomock.Any(), gomock.Eq(user.ID)).
		AnyTimes().
		DoAndReturn(func(_ any, _ int64) (db.User, error) { return stored, nil })
	store.EXPECT().
		UpdateUserTx(gomock.Any(), gomock.Any()).
		Times(1).
		DoAndReturn(func(_ any, arg db.UpdateUserTxParams) (db.UpdateUserTxResult, error) {
			stored.HashedPassword = arg.HashedPassword
			// The real tx stamps password_changed_at under the row lock.
			stored.PasswordChangedAt = time.Now()
			return db.UpdateUserTxResult{User: stored}, nil
		})
	store.EXPECT().
		CreateSession(gomock.Any(), gomock.Any()).
		Times(1).
		DoAndReturn(func(_ any, arg db.CreateSessionParams) (db.Session, error) {
			return db.Session{ID: arg.ID, UserID: arg.UserID}, nil
		})
	store.EXPECT().
		ListUsers(gomock.Any(), gomock.Any()).
		AnyTimes().
		Return([]db.User{}, nil)
	store.EXPECT().
		CountTotalUsers(gomock.Any()).
		AnyTimes().
		Return(int64(0), nil)

	server := newTestServer(t, store)

	do := func(method, url, accessToken string, body any) *httptest.ResponseRecorder {
		var reader *bytes.Reader
		if body != nil {
			data, err := json.Marshal(body)
			require.NoError(t, err)
			reader = bytes.NewReader(data)
		} else {
			reader = bytes.NewReader(nil)
		}
		request, err := http.NewRequest(method, url, reader)
		require.NoError(t, err)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(authorizationHeaderKey, "Bearer "+accessToken)

		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		return recorder
	}

	// Minted a minute ago, i.e. before the change below.
	oldToken := accessTokenIssuedAt(t, server, user, time.Now().Add(-time.Minute))

	require.Equal(t, http.StatusOK, do(http.MethodGet, "/api/v1/users/me", oldToken, nil).Code)
	require.Equal(t, http.StatusOK, do(http.MethodGet, "/api/v1/users", oldToken, nil).Code)

	recorder := do(http.MethodPut, fmt.Sprintf("/api/v1/users/%d", user.ID), oldToken,
		gin.H{"password": newPassword, "current_password": currentPassword})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	// No requireRole on /users/me; requireSiteAdmin on GET /users.
	require.Equal(t, http.StatusUnauthorized, do(http.MethodGet, "/api/v1/users/me", oldToken, nil).Code)
	require.Equal(t, http.StatusUnauthorized, do(http.MethodGet, "/api/v1/users", oldToken, nil).Code)

	// The token the password-change response hands back was minted in the
	// same second as the change and keeps working.
	var changed struct {
		AccessToken string `json:"access_token"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &changed))
	newToken := changed.AccessToken
	require.NotEmpty(t, newToken)
	require.Equal(t, http.StatusOK, do(http.MethodGet, "/api/v1/users/me", newToken, nil).Code)
	require.Equal(t, http.StatusOK, do(http.MethodGet, "/api/v1/users", newToken, nil).Code)
}
