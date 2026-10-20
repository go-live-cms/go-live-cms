package devModeUtil

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// Credentials of the accounts the dev seeders create. They are public (they are
// in this file), so an account that still has one outside development is an
// open door.
const (
	DefaultAdminUsername = "admin"
	DefaultAdminPassword = "123456"
	DummyUserPassword    = "password123"
)

// dummyUsers are the usernames and roles createDummyUsers seeds, all with
// DummyUserPassword.
var dummyUsers = []struct {
	username string
	role     string
}{
	{"editor", "editor"},
	{"author", "contributor"},
	{"contributor", "contributor"},
	{"moderator", "editor"},
}

// SeededAccount is a username and the password the dev seeders gave it.
type SeededAccount struct {
	Username string
	Password string
}

// SeededAccounts lists every account the dev seeders create, with its seeded
// password.
func SeededAccounts() []SeededAccount {
	accounts := []SeededAccount{{Username: DefaultAdminUsername, Password: DefaultAdminPassword}}
	for _, u := range dummyUsers {
		accounts = append(accounts, SeededAccount{Username: u.username, Password: DummyUserPassword})
	}
	return accounts
}

// FindSeededAccountsWithSeededPasswords returns the usernames of seeded
// accounts that exist and whose password still verifies against the seeded
// one. Missing accounts are skipped; any other store error is returned, so a
// caller can fail closed.
//
// Before #228, every deployment ran in debug mode and so got these accounts;
// release-mode startup uses this to find the ones never rotated.
func FindSeededAccountsWithSeededPasswords(ctx context.Context, store db.Store) ([]string, error) {
	var found []string
	for _, account := range SeededAccounts() {
		user, err := store.GetUserByUsername(ctx, account.Username)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("look up seeded account %q: %w", account.Username, err)
		}
		if util.CheckPasswordMatch(account.Password, user.HashedPassword) {
			found = append(found, account.Username)
		}
	}
	return found, nil
}
