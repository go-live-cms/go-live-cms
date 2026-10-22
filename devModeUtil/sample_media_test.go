package devModeUtil

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
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

func TestStoreSampleImage(t *testing.T) {
	// An absolute path, as in compose (/app/uploads/media): before #201 the
	// seed joined it onto "." and wrote somewhere else.
	uploadPath := filepath.Join(t.TempDir(), "uploads", "media")
	require.True(t, filepath.IsAbs(uploadPath))
	want, _, err := sampleImage(1)
	require.NoError(t, err)

	name, err := storeSampleImage(uploadPath, 1)
	require.NoError(t, err)
	require.Equal(t, "sample-image-1.jpg", name)
	got, err := os.ReadFile(filepath.Join(uploadPath, name))
	require.NoError(t, err)
	require.True(t, bytes.Equal(want, got))

	// The same image already there (an earlier seed): reused.
	name, err = storeSampleImage(uploadPath, 1)
	require.NoError(t, err)
	require.Equal(t, "sample-image-1.jpg", name)

	// A different file with that name (someone's upload) is left alone.
	other := filepath.Join(uploadPath, "sample-image-2.jpg")
	require.NoError(t, os.WriteFile(other, []byte("not ours"), 0644))
	name, err = storeSampleImage(uploadPath, 2)
	require.NoError(t, err)
	require.Equal(t, "sample-image-2_1.jpg", name)
	got, err = os.ReadFile(other)
	require.NoError(t, err)
	require.Equal(t, "not ours", string(got))
	require.FileExists(t, filepath.Join(uploadPath, "sample-image-2_1.jpg"))

	// And the next run finds its own copy under the alternative name.
	name, err = storeSampleImage(uploadPath, 2)
	require.NoError(t, err)
	require.Equal(t, "sample-image-2_1.jpg", name)
}

func TestRestoreSampleMediaFiles(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	uploadPath := filepath.Join(t.TempDir(), "uploads", "media")
	require.NoError(t, os.MkdirAll(uploadPath, 0755))

	// Rows reference images 1, 2 and 3. 1 is missing, 2 was replaced by
	// another file, 3 is intact; 4..12 have no row (deleted in the admin).
	intact, _, err := sampleImage(3)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(uploadPath, sampleImageName(2)), []byte("replaced"), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(uploadPath, sampleImageName(3)), intact, 0644))

	store.EXPECT().
		ListMediaPathsIn(gomock.Any(), gomock.Any()).
		Times(1).
		DoAndReturn(func(_ context.Context, paths []string) ([]string, error) {
			require.Len(t, paths, sampleImageCount)
			require.Contains(t, paths, uploadPath+"/sample-image-1.jpg")
			return []string{
				uploadPath + "/sample-image-1.jpg",
				uploadPath + "/sample-image-2.jpg",
				uploadPath + "/sample-image-3.jpg",
			}, nil
		})

	written, err := RestoreSampleMediaFiles(context.Background(), store, uploadPath)
	require.NoError(t, err)
	require.Equal(t, 1, written)

	require.FileExists(t, filepath.Join(uploadPath, sampleImageName(1)))
	got, err := os.ReadFile(filepath.Join(uploadPath, sampleImageName(2)))
	require.NoError(t, err)
	require.Equal(t, "replaced", string(got))
	for n := 4; n <= sampleImageCount; n++ {
		require.NoFileExists(t, filepath.Join(uploadPath, sampleImageName(n)))
	}
}

func TestRestoreSampleMediaFilesStoreError(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	uploadPath := filepath.Join(t.TempDir(), "media")
	store.EXPECT().ListMediaPathsIn(gomock.Any(), gomock.Any()).Times(1).Return(nil, errors.New("down"))

	_, err := RestoreSampleMediaFiles(context.Background(), store, uploadPath)
	require.Error(t, err)
	require.NoDirExists(t, uploadPath)
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

// A debug-mode restart on a seeded database writes nothing: no store writes
// and no files (deleted sample media must not come back as orphans).
func TestCreateDummyDataSkipWritesNoFiles(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	uploadPath := filepath.Join(t.TempDir(), "media")

	store.EXPECT().CountTotalUsers(gomock.Any()).Times(1).Return(int64(5), nil)

	CreateDummyData(store, util.Config{UploadPath: uploadPath})

	require.NoDirExists(t, uploadPath)
}

func TestSeededImageURLs(t *testing.T) {
	media := []db.Medium{
		{MediaPath: "/app/uploads/media/sample-image-1.jpg"},
		{MediaPath: "/app/uploads/media/sample-image-2_1.jpg"},
	}
	urls := seededImageURLs("/app/uploads/media", media)
	require.Equal(t, []string{"/uploads/media/sample-image-1.jpg", "/uploads/media/sample-image-2_1.jpg"}, urls)
	require.Equal(t, urls[1], pickImageURL(urls, 3))
	require.Equal(t, "", pickImageURL(nil, 0))
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
