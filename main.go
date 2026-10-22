package main

import (
	"database/sql"
	"log/slog"
	"os"

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

	server, err := api.NewServer(config, db.NewStore(conn))
	if err != nil {
		fatal("cannot set up server", err)
	}

	// Server-to-server routes (collab WS role lookup, metrics) run on their own
	// listener, which must not be published to the internet.
	go func() {
		slog.Info("starting internal API", "address", config.InternalServerAddress)
		if err := server.StartInternal(config.InternalServerAddress); err != nil {
			fatal("cannot start internal server", err)
		}
	}()

	slog.Info("starting API", "address", config.ServerAddress)
	if err := server.Start(config.ServerAddress); err != nil {
		fatal("cannot start server", err)
	}
}
