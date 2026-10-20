package main

import (
	"database/sql"
	"log"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/api"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"

	_ "github.com/lib/pq"
)

func main() {
	config, err := util.LoadConfig(".")
	if err != nil {
		log.Fatal("❌ Cannot load config:", err)
	}

	log.Println("🚀 Starting Go Live CMS...")

	gin.SetMode(gin.DebugMode)

	log.Println("📊 Connecting to database...")
	conn, err := sql.Open(config.DBDriver, config.DBSource)
	if err != nil {
		log.Fatal("❌ Cannot connect to db:", err)
	}
	log.Println("✅ Database connected successfully")

	log.Println("🔧 Setting up server...")
	server, err := api.NewServer(config, db.NewStore(conn))
	if err != nil {
		log.Fatal("❌ Cannot set up server:", err)
	}

	log.Println("🌐 Starting Go Live CMS API on port", config.ServerAddress)
	// Server-to-server routes (collab WS role lookup) run on their own listener,
	// which must not be published to the internet.
	go func() {
		log.Println("Starting internal API on", config.InternalServerAddress)
		if err := server.StartInternal(config.InternalServerAddress); err != nil {
			log.Fatal("cannot start internal server:", err)
		}
	}()

	err = server.Start(config.ServerAddress)
	if err != nil {
		log.Fatal("cannot start server:", err)
	}
}
