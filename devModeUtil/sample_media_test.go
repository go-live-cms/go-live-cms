package devModeUtil

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

func TestSampleImagesEmbedded(t *testing.T) {
	var total int
	for n := 1; n <= sampleImageCount; n++ {
		data, cfg, err := sampleImage(n)
		require.NoError(t, err, sampleImageName(n))
		require.Equal(t, 800, cfg.Width)
		require.Equal(t, 600, cfg.Height)
		total += len(data)
	}
	// Keep the repo and the binary small (they are embedded).
	require.Less(t, total, 1<<20, "sample images total %d bytes", total)
}

func TestSampleMediaPathAndURL(t *testing.T) {
	for _, uploadPath := range []string{"/app/uploads/media", "./uploads/media", "uploads/media"} {
		require.Equal(t, uploadPath+"/sample-image-3.jpg", sampleMediaPath(uploadPath, "sample-image-3.jpg"))
		require.Equal(t, "/uploads/media/sample-image-3.jpg", sampleMediaURL(uploadPath, "sample-image-3.jpg"))
	}
}

func TestEnsureSampleMediaFiles(t *testing.T) {
	// An absolute path, as in compose (/app/uploads/media): before #201 the
	// seed joined it onto "." and wrote somewhere else.
	uploadPath := filepath.Join(t.TempDir(), "uploads", "media")
	require.True(t, filepath.IsAbs(uploadPath))

	written, err := EnsureSampleMediaFiles(uploadPath)
	require.NoError(t, err)
	require.Equal(t, sampleImageCount, written)
	for n := 1; n <= sampleImageCount; n++ {
		got, err := os.ReadFile(filepath.Join(uploadPath, sampleImageName(n)))
		require.NoError(t, err)
		want, _, err := sampleImage(n)
		require.NoError(t, err)
		require.True(t, bytes.Equal(want, got), sampleImageName(n))
	}

	// Second run: nothing to do. A missing file is restored, an existing
	// (e.g. replaced) one is kept.
	written, err = EnsureSampleMediaFiles(uploadPath)
	require.NoError(t, err)
	require.Zero(t, written)

	replaced := filepath.Join(uploadPath, sampleImageName(1))
	require.NoError(t, os.WriteFile(replaced, []byte("replaced"), 0644))
	require.NoError(t, os.Remove(filepath.Join(uploadPath, sampleImageName(2))))

	written, err = EnsureSampleMediaFiles(uploadPath)
	require.NoError(t, err)
	require.Equal(t, 1, written)
	got, err := os.ReadFile(replaced)
	require.NoError(t, err)
	require.Equal(t, "replaced", string(got))
	require.FileExists(t, filepath.Join(uploadPath, sampleImageName(2)))
}

func TestCreateDummyMediaStoresFiles(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	uploadPath := filepath.Join(t.TempDir(), "media")
	users := []db.User{{ID: 7}, {ID: 8}}

	var created []db.CreateMediaParams
	store.EXPECT().
		CreateMedia(gomock.Any(), gomock.Any()).
		Times(sampleImageCount).
		DoAndReturn(func(_ context.Context, arg db.CreateMediaParams) (db.Medium, error) {
			created = append(created, arg)
			return db.Medium{ID: int64(len(created)), Name: arg.Name, MediaPath: arg.MediaPath}, nil
		})

	media := createDummyMedia(store, users, util.Config{UploadPath: uploadPath})
	require.Len(t, media, sampleImageCount)

	for i, arg := range created {
		name := sampleImageName(i + 1)
		require.Equal(t, name, arg.Name)
		require.Equal(t, uploadPath+"/"+name, arg.MediaPath)
		require.Equal(t, "image/jpeg", arg.MimeType)
		require.Equal(t, int32(800), arg.Width)
		require.Equal(t, int32(600), arg.Height)
		require.Equal(t, users[i%2].ID, arg.UserID)

		info, err := os.Stat(filepath.Join(uploadPath, name))
		require.NoError(t, err)
		require.Equal(t, info.Size(), arg.FileSize)
	}
}

func TestCreateDummyDataSkipRestoresFiles(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	uploadPath := filepath.Join(t.TempDir(), "media")

	// Already seeded: no writes to the store, but the files come back.
	store.EXPECT().CountTotalUsers(gomock.Any()).Times(1).Return(int64(5), nil)

	CreateDummyData(store, util.Config{UploadPath: uploadPath})

	for n := 1; n <= sampleImageCount; n++ {
		require.FileExists(t, filepath.Join(uploadPath, sampleImageName(n)))
	}
}

func TestAdminAccount(t *testing.T) {
	require.Equal(t, SeededAccount{Username: "admin", Password: "123456"}, AdminAccount(util.Config{}))
	require.Equal(t,
		SeededAccount{Username: "root", Password: "s3cret-pass"},
		AdminAccount(util.Config{SeedAdminUsername: "root", SeedAdminPassword: "s3cret-pass"}))
	require.Equal(t,
		SeededAccount{Username: "root", Password: "123456"},
		AdminAccount(util.Config{SeedAdminUsername: "root"}))
}

func TestConfiguredAdminAccounts(t *testing.T) {
	require.Empty(t, ConfiguredAdminAccounts(util.Config{}))
	require.Empty(t, ConfiguredAdminAccounts(util.Config{SeedAdminUsername: "admin", SeedAdminPassword: "x"}))
	// A renamed admin is checked against the public default password even
	// when SEED_ADMIN_PASS is set (that one isn't public).
	require.Equal(t,
		[]SeededAccount{{Username: "root", Password: "123456"}},
		ConfiguredAdminAccounts(util.Config{SeedAdminUsername: "root", SeedAdminPassword: "x"}))
}

func TestCreateDefaultAdminUserUsesAccount(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	account := SeededAccount{Username: "root", Password: "s3cret-pass"}

	store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Eq("root")).Times(1).Return(db.User{}, sql.ErrNoRows)
	store.EXPECT().
		CreateUser(gomock.Any(), gomock.Any()).
		Times(1).
		DoAndReturn(func(_ context.Context, arg db.CreateUserParams) (db.User, error) {
			require.Equal(t, "root", arg.Username)
			require.Equal(t, "root@golive-cms.local", arg.Email)
			require.Equal(t, "admin", arg.Role)
			require.True(t, util.CheckPasswordMatch("s3cret-pass", arg.HashedPassword))
			return db.User{Username: arg.Username, Email: arg.Email, Role: arg.Role}, nil
		})

	CreateDefaultAdminUser(store, account)

	// Existing account: skipped.
	store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Eq("root")).Times(1).Return(db.User{Username: "root"}, nil)
	CreateDefaultAdminUser(store, account)
}
