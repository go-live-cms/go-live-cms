package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

func TestCheckMode(t *testing.T) {
	testCases := []struct {
		name    string
		ginMode string
		force   bool
		wantErr bool
	}{
		{name: "debug", ginMode: util.GinModeDebug},
		{name: "release refused", ginMode: util.GinModeRelease, wantErr: true},
		{name: "test refused", ginMode: util.GinModeTest, wantErr: true},
		{name: "unset refused", ginMode: "", wantErr: true},
		{name: "release forced", ginMode: util.GinModeRelease, force: true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkMode(util.Config{GinMode: tc.ginMode}, tc.force)
			if tc.wantErr {
				require.ErrorIs(t, err, errNotDebugMode)
				require.Contains(t, err.Error(), "-force")
				return
			}
			require.NoError(t, err)
		})
	}
}

// An already-seeded database: the admin and dummy data are skipped (no
// writes), and the sample files are still put in place.
func TestSeedAlreadySeeded(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	uploadPath := filepath.Join(t.TempDir(), "media")

	store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Eq("admin")).Times(1).Return(db.User{Username: "admin"}, nil)
	store.EXPECT().CountTotalUsers(gomock.Any()).Times(1).Return(int64(5), nil)

	seed(store, util.Config{UploadPath: uploadPath})

	require.FileExists(t, filepath.Join(uploadPath, "sample-image-1.jpg"))
	require.FileExists(t, filepath.Join(uploadPath, "sample-image-12.jpg"))
}

func TestSeedUsesConfiguredAdmin(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)

	store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Eq("root")).Times(1).Return(db.User{}, sql.ErrNoRows)
	store.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(1).Return(db.User{Username: "root"}, nil)
	store.EXPECT().CountTotalUsers(gomock.Any()).Times(1).Return(int64(2), nil)

	seed(store, util.Config{
		UploadPath:        filepath.Join(t.TempDir(), "media"),
		SeedAdminUsername: "root",
		SeedAdminPassword: "s3cret-pass",
	})
}
