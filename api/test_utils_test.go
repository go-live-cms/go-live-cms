package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

func newTestServer(t *testing.T, store db.Store) *Server {

	gin.SetMode(gin.TestMode)

	server, err := NewServer(newTestConfig(t), store)
	require.NoError(t, err)

	return server
}

// newTestConfig returns a test-mode config with fresh PASETO v4 keys and a
// temp upload dir, for tests that need to call NewServer themselves.
func newTestConfig(t *testing.T) util.Config {
	// Generate fresh PASETO v4 keys for each test
	privKey := p.NewV4AsymmetricSecretKey()
	pubKey := privKey.Public()
	localKey := p.NewV4SymmetricKey()

	tempDir := t.TempDir()
	uploadPath := filepath.Join(tempDir, "uploads", "media")
	err := os.MkdirAll(uploadPath, 0755)
	require.NoError(t, err)

	return util.Config{
		PasetoV4PrivateKeyHex: privKey.ExportHex(),
		PasetoV4PublicKeyHex:  pubKey.ExportHex(),
		PasetoV4LocalKeyHex:   localKey.ExportHex(),
		PasetoIssuer:          "test-issuer",
		PasetoAudience:        "test-audience",
		PasetoAccessKID:       "test-access-kid",
		PasetoRefreshKID:      "test-refresh-kid",
		AccessTokenDuration:   time.Minute,
		RefreshTokenDuration:  time.Hour,
		UploadPath:            uploadPath,
		MaxUploadSize:         "10MB",
		RoleLookupSecret:      testRoleLookupSecret,
		IsTestMode:            true,
		// Mail (#148): unused in test mode (the "log" driver), but tests that
		// turn test mode off need a complete release-mode setup.
		SMTPHost:      "smtp.test.invalid",
		SMTPPort:      587,
		MailFrom:      "GoLive CMS <no-reply@test.invalid>",
		PublicBaseURL: testPublicBaseURL,
		// Required by NewServer: every publish flushes the collab server first.
		CollabInternalURL:    newFakeCollabServer(t),
		CollabInternalSecret: testCollabInternalSecret,
	}
}

// newFakeCollabServer is a collab server whose internal endpoints answer 200
// to everything (a publish's flush: "stored, or not loaded"). Tests of the
// flush itself use their own server (collab_publish_test.go).
func newFakeCollabServer(t *testing.T) string {
	t.Helper()
	collab := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(collab.Close)
	return collab.URL
}

// stubRoleLookup permits authMiddleware's caller DB lookup (which requireRole
// and callerUser then reuse) for the given authenticated user. Call it AFTER a test case's own
// buildStubs so per-case GetUser expectations keep precedence (gomock
// consumes identical matchers in declaration order, skipping exhausted
// ones). AnyTimes() also tolerates unauthenticated cases where the
// middleware never runs.
func stubRoleLookup(store *mockdb.MockStore, user db.User) {
	store.EXPECT().
		GetUser(gomock.Any(), gomock.Eq(user.ID)).
		Return(user, nil).
		AnyTimes()
}
