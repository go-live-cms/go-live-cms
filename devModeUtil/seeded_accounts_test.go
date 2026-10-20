package devModeUtil

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

func TestSeededAccountsMatchSeeders(t *testing.T) {
	accounts := SeededAccounts()
	require.Equal(t, SeededAccount{Username: "admin", Password: "123456"}, accounts[0])

	var dummies []string
	for _, account := range accounts[1:] {
		require.Equal(t, "password123", account.Password)
		dummies = append(dummies, account.Username)
	}
	require.Equal(t, []string{"editor", "author", "contributor", "moderator"}, dummies)
}

// expectSeededLookups makes the mock answer GetUserByUsername for every seeded
// account: with a user hashed from passwords[username] when present, or
// sql.ErrNoRows when the account doesn't exist.
func expectSeededLookups(t *testing.T, store *mockdb.MockStore, passwords map[string]string) {
	for _, account := range SeededAccounts() {
		password, ok := passwords[account.Username]
		if !ok {
			store.EXPECT().
				GetUserByUsername(gomock.Any(), gomock.Eq(account.Username)).
				Times(1).
				Return(db.User{}, sql.ErrNoRows)
			continue
		}
		hashed, err := util.HashPassword(password)
		require.NoError(t, err)
		store.EXPECT().
			GetUserByUsername(gomock.Any(), gomock.Eq(account.Username)).
			Times(1).
			Return(db.User{Username: account.Username, HashedPassword: hashed}, nil)
	}
}

func TestFindSeededAccountsWithSeededPasswords(t *testing.T) {
	testCases := []struct {
		name      string
		passwords map[string]string
		want      []string
	}{
		{name: "no seeded accounts", passwords: map[string]string{}},
		{
			name:      "default admin password",
			passwords: map[string]string{"admin": "123456"},
			want:      []string{"admin"},
		},
		{
			name:      "admin rotated",
			passwords: map[string]string{"admin": "a-real-password"},
		},
		{
			name: "admin and some dummies unrotated",
			passwords: map[string]string{
				"admin":     "123456",
				"editor":    "password123",
				"author":    "rotated-password",
				"moderator": "password123",
			},
			want: []string{"admin", "editor", "moderator"},
		},
		{
			// Each account is checked against its own seeded password only.
			name:      "admin with the dummy password",
			passwords: map[string]string{"admin": "password123"},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			expectSeededLookups(t, store, tc.passwords)

			found, err := FindSeededAccountsWithSeededPasswords(context.Background(), store)
			require.NoError(t, err)
			require.Equal(t, tc.want, found)
		})
	}
}

func TestFindSeededAccountsWithSeededPasswordsStoreError(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	dbErr := errors.New("connection refused")
	store.EXPECT().
		GetUserByUsername(gomock.Any(), gomock.Eq("admin")).
		Times(1).
		Return(db.User{}, dbErr)

	found, err := FindSeededAccountsWithSeededPasswords(context.Background(), store)
	require.ErrorIs(t, err, dbErr)
	require.Nil(t, found)
}
