package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// isolatedStore returns a store on a private database, created for this test
// from db/migration and dropped when it ends.
//
// It is for tests whose assertions depend on every row of a table, like the
// last-admin guard (guardLastAdmin counts every admin there is). The shared
// test database can't give them that: CI runs `go test ./...`, so this
// package and api run at once against it, and demoting the other admins
// there, even for a moment or inside a transaction that is rolled back, made
// api tests that act as an admin get 403s (or wait on the row locks). Here the
// only users are the ones the test creates.
func isolatedStore(t *testing.T) *SQLStore {
	t.Helper()
	ctx := context.Background()

	base, err := url.Parse(testDBSource)
	require.NoError(t, err)
	require.NotEmpty(t, base.Scheme, "isolatedStore needs DB_SOURCE as a URL (postgresql://user:pass@host:port/db)")

	name := fmt.Sprintf("golive_test_%d_%d", os.Getpid(), time.Now().UnixNano())
	admin, err := sql.Open("postgres", testDBSource)
	require.NoError(t, err)
	t.Cleanup(func() { admin.Close() })
	_, err = admin.ExecContext(ctx, "CREATE DATABASE "+name)
	require.NoError(t, err, "isolatedStore needs a role that may CREATE DATABASE")

	isolated := *base
	isolated.Path = "/" + name
	conn, err := sql.Open("postgres", isolated.String())
	require.NoError(t, err)
	// Registered after admin's Close, so it runs first: close every connection
	// to the private database, then drop it.
	t.Cleanup(func() {
		conn.Close()
		_, err := admin.ExecContext(context.Background(), "DROP DATABASE IF EXISTS "+name)
		require.NoError(t, err)
	})

	// The up migrations in order, as golang-migrate applies them (each file is
	// one multi-statement Exec).
	files, err := filepath.Glob(filepath.Join("..", "migration", "*.up.sql"))
	require.NoError(t, err)
	require.NotEmpty(t, files)
	sort.Strings(files)
	for _, file := range files {
		migration, err := os.ReadFile(file)
		require.NoError(t, err)
		if strings.TrimSpace(string(migration)) == "" {
			continue
		}
		_, err = conn.ExecContext(ctx, string(migration))
		require.NoError(t, err, "applying %s", filepath.Base(file))
	}

	return NewStore(conn).(*SQLStore)
}

// createUserIn creates a user with role in store's database.
func createUserIn(t *testing.T, store *SQLStore, role string) User {
	t.Helper()
	suffix := fmt.Sprintf("%d_%d", time.Now().UnixNano(), isolatedUsers.Add(1))
	user, err := store.CreateUser(context.Background(), CreateUserParams{
		Username:       "user_" + suffix,
		Email:          "user_" + suffix + "@example.com",
		FullName:       "Test User " + suffix,
		HashedPassword: "hashed",
		Role:           role,
	})
	require.NoError(t, err)
	return user
}

var isolatedUsers atomic.Int64

// countAdmins counts the admins in store's database, as guardLastAdmin does.
func countAdmins(t *testing.T, store *SQLStore) int {
	t.Helper()
	var admins int
	require.NoError(t, store.db.QueryRowContext(context.Background(),
		`SELECT count(*) FROM users WHERE lower(role) = 'admin'`).Scan(&admins))
	return admins
}
