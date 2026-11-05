package main

import (
	"context"
	"database/sql"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/api"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"

	_ "github.com/lib/pq"
)

// fatal logs at error level and exits; slog has no Fatal.
func fatal(msg string, err error) {
	slog.Error(msg, "error", err)
	os.Exit(1)
}

func main() {
	// JSON until the config says otherwise, so even a config error is structured.
	slog.SetDefault(api.NewLogger(os.Stdout, util.GinModeRelease))

	config, err := util.LoadConfig(".")
	if err != nil {
		fatal("cannot load config", err)
	}

	// Text in debug, JSON otherwise (api.NewLogger). SetDefault also routes the
	// standard log package (e.g. the dev seeders) through it.
	slog.SetDefault(api.NewLogger(os.Stdout, config.GinMode))

	// GIN_MODE defaults to release; debug (dev seeding, dev CORS) must be opted into.
	gin.SetMode(config.GinMode)
	slog.Info("starting Go Live CMS", "gin_mode", gin.Mode())

	conn, err := sql.Open(config.DBDriver, config.DBSource)
	if err != nil {
		fatal("cannot open db", err)
	}

	// One-off maintenance commands instead of the server.
	if len(os.Args) > 1 && os.Args[1] == "backfill-variants" {
		runBackfillVariants(config, db.NewStore(conn), os.Args[2:])
		return
	}

	server, err := api.NewServer(config, db.NewStore(conn))
	if err != nil {
		fatal("cannot set up server", err)
	}

	// SIGTERM (docker stop) or Ctrl+C: stop taking requests, let those in flight
	// and the scheduler's publish in flight finish, then exit.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Scheduled publishing (#147): every replica runs it; claims keep them apart.
	schedulerDone := make(chan struct{})
	go func() {
		defer close(schedulerDone)
		server.RunScheduledPublishing(ctx, config.ScheduledPublishInterval)
	}()

	// Activity log retention (#324): every replica prunes; deleting is idempotent.
	go server.RunActivityRetention(ctx, config.ActivityRetention)

	// Open signup (#191): expired pending signups are deleted hourly.
	go server.RunSignupRequestPrune(ctx, 0)

	// Server-to-server routes (collab WS role lookup, metrics) run on their own
	// listener, which must not be published to the internet.
	go func() {
		slog.Info("starting internal API", "address", config.InternalServerAddress)
		if err := server.ServeInternal(ctx, config.InternalServerAddress); err != nil {
			fatal("cannot start internal server", err)
		}
	}()

	slog.Info("starting API", "address", config.ServerAddress)
	if err := server.Serve(ctx, config.ServerAddress); err != nil {
		fatal("cannot start server", err)
	}
	<-schedulerDone
	slog.Info("API stopped")
}

// runBackfillVariants implements `main backfill-variants [-all]`: generates
// the image variants (#255) of media uploaded before variants existed. With
// -all it regenerates every image's variants (e.g. after the sizes change).
// Run it where the API runs, so UPLOAD_PATH points at the same files:
//
//	docker compose exec api /app/main backfill-variants
//	docker compose -f compose.dev.yaml exec api go run main.go backfill-variants
func runBackfillVariants(config util.Config, store db.Store, args []string) {
	flags := flag.NewFlagSet("backfill-variants", flag.ExitOnError)
	all := flags.Bool("all", false, "regenerate variants for every image, not only those without")
	_ = flags.Parse(args) // ExitOnError: it exits on a bad flag instead of returning

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	stats, err := api.BackfillMediaVariants(ctx, store, config.UploadPath, *all, slog.Default())
	slog.Info("media variant backfill finished",
		"scanned", stats.Scanned, "generated", stats.Generated, "skipped", stats.Skipped, "failed", stats.Failed)
	if err != nil {
		fatal("media variant backfill failed", err)
	}
}
