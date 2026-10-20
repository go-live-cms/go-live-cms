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

	// GIN_MODE defaults to release; debug (dev seeding, dev CORS) must be opted into.
	gin.SetMode(config.GinMode)
	log.Println("⚙️  Gin mode:", gin.Mode())

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
	err = server.Start(config.ServerAddress)
	if err != nil {
		log.Fatal("cannot start server:", err)
	}
}
