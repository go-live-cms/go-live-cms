package api

import (
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	p "aidanwoods.dev/go-paseto"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/stretchr/testify/require"
)

const alphabet = "abcdefghijklmnopqrstuvwxyz"

func randomString(n int) string {
	var sb strings.Builder
	k := len(alphabet)

	for range n {
		c := alphabet[rand.Intn(k)]
		sb.WriteByte(c)
	}

	return sb.String()
}

func newTestServer(t *testing.T, store db.Store) *Server {

	gin.SetMode(gin.TestMode)

	// Generate fresh PASETO v4 keys for each test
	privKey := p.NewV4AsymmetricSecretKey()
	pubKey := privKey.Public()
	localKey := p.NewV4SymmetricKey()

	tempDir := t.TempDir()
	uploadPath := filepath.Join(tempDir, "uploads", "media")
	err := os.MkdirAll(uploadPath, 0755)
	require.NoError(t, err)

	config := util.Config{
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
		IsTestMode:            true,
	}

	server, err := NewServer(config, store)
	require.NoError(t, err)

	return server
}

// stubRoleLookup permits the requireRole middleware's caller-role DB lookup
// for the given authenticated user. Call it AFTER a test case's own
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
