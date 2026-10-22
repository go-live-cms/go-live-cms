// Command seed runs the dev seed (devModeUtil) against the configured
// database: the admin account, dummy users, taxonomies, media with their
// sample image files, posts and pages. It is what debug-mode API startup
// does, as an explicit step.
//
// Usage (from the repo root, so app.env is found):
//
//	go run ./cmd/seed           # or: make seed
//	go run ./cmd/seed -force    # also outside GIN_MODE=debug
//
// In the dev stack, run it in the api container, which has the stack's
// DB_SOURCE and UPLOAD_PATH:
//
//	docker compose -f compose.dev.yaml exec api go run ./cmd/seed
//
// It is safe to run more than once: the admin is skipped if it exists, the
// dummy data is skipped if the database has more than one user, and only
// sample image files that a media row references but that are missing from
// UPLOAD_PATH are written back (never overwritten).
//
// The seed creates accounts with public passwords, so it refuses to run
// unless GIN_MODE=debug, or -force is given. Even when forced, a release-mode
// API then refuses to start until those passwords are changed
// (devModeUtil.FindSeededAccountsWithSeededPasswords).
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/go-live-cms/go-live-cms/api"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/devModeUtil"
	"github.com/go-live-cms/go-live-cms/util"

	_ "github.com/lib/pq"
)

// errNotDebugMode is returned by checkMode when seeding outside debug mode
// without -force.
var errNotDebugMode = errors.New("refusing to seed")

func main() {
	force := flag.Bool("force", false, "seed even when GIN_MODE is not debug (e.g. a release-mode database)")
	flag.Parse()

	slog.SetDefault(api.NewLogger(os.Stdout, util.GinModeDebug))

	config, err := util.LoadConfig(".")
	if err != nil {
		fail("cannot load config", err)
	}
	if err := checkMode(config, *force); err != nil {
		fail("not seeding", err)
	}

	conn, err := sql.Open(config.DBDriver, config.DBSource)
	if err != nil {
		fail("cannot open db", err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.PingContext(ctx); err != nil {
		fail("cannot reach db", err)
	}

	seed(context.Background(), db.NewStore(conn), config)
}

// checkMode refuses to seed outside GIN_MODE=debug unless forced.
func checkMode(config util.Config, force bool) error {
	if config.IsDebugMode() {
		return nil
	}
	if force {
		slog.Warn("seeding outside debug mode (-force): the seeded accounts have public passwords, "+
			"and a release-mode API refuses to start until they are changed",
			"gin_mode", config.GinMode)
		return nil
	}
	return fmt.Errorf("%w: GIN_MODE is %q, and the seed creates accounts with public passwords. "+
		"Set GIN_MODE=debug for a development database, or pass -force", errNotDebugMode, config.GinMode)
}

// seed runs the same seeders as debug-mode API startup, then writes back the
// sample image files that seeded media rows reference but that are missing
// (which startup never does).
func seed(ctx context.Context, store db.Store, config util.Config) {
	slog.Info("seeding", "upload_path", config.UploadPath)
	devModeUtil.CreateDefaultAdminUser(store, devModeUtil.AdminAccount(config))
	devModeUtil.CreateDummyData(store, config)
	if _, err := devModeUtil.RestoreSampleMediaFiles(ctx, store, config.UploadPath); err != nil {
		slog.Error("cannot restore sample media files", "error", err)
	}
}

func fail(msg string, err error) {
	slog.Error(msg, "error", err)
	os.Exit(1)
}
