# GoLive CMS - Development Guide

A full-stack CMS built with Go (Gin), PostgreSQL, and Astro.

## 🚀 Quick Start

```bash
git clone <repo>
cd go-live-cms
./scripts/gen-ws-env.sh          # ⚠️  REQUIRED: Generates auth keys
make devbuild
```

### Prerequisites

- Docker & Docker Compose
- Go 1.19+
- Node.js 18+
- WSL (for Windows users)

### Development Setup

1. **Clone and setup the project:**

   ```bash
   git clone <repository-url>
   cd go-live-cms
   ```

2. **Important**
   Make sure the startdev.sh, wait-for.sh and start.sh are in the LF format instead of CRLF

3. **Environment configuration:**

   ```bash
   cp example.app.env app.env
   # Edit app.env with your configuration if needed
   ```

4. **Start development environment:**

   ```bash
   make dev
   ```

   This will start:

   - PostgreSQL database on port 5432
   - Go API server on http://localhost:8080
   - Astro frontend on http://localhost:4321

5. **Check logs (optional):**
   ```bash
   make devlogs        # All services
   make devlogs-api    # API only
   make devlogs-web    # Frontend only
   ```

## 🛠️ Development Commands

### Docker Development

```bash
make dev           # Start development environment
make devdown       # Stop development environment
make devrebuild    # Rebuild and restart all services
make devlogs       # View all logs
make devlogs-api   # View API logs only
make devlogs-web   # View frontend logs only
```

### Production

```bash
make prod          # Start production environment
make proddown      # Stop production environment
make prodlogs      # View production logs
```

### Database Management

```bash
make postgres      # Start standalone PostgreSQL container
make createdb      # Create database
make dropdb        # Drop database
make migrateup     # Run all migrations
make migratedown   # Rollback all migrations
```

### Code Generation & Testing

```bash
make sqlc          # Generate Go code from SQL queries
make mock          # Generate mocks for testing
make test          # Run all tests
make server        # Run API server locally (without Docker)
```

### Documentation

```bash
make install-godoc # Install godoc tool
make docs          # Start documentation server on http://localhost:6060
```

The documentation will be available at:

- **Package Documentation**: http://localhost:6060/pkg/github.com/go-live-cms/go-live-cms/
- **Util Package**: http://localhost:6060/pkg/github.com/go-live-cms/go-live-cms/util/

## 📁 Project Structure

```
golive-cms/
├── api/                    # API handlers and routes
├── db/
│   ├── migration/         # Database migrations
│   ├── query/            # SQL queries for sqlc
│   └── sqlc/             # Generated Go code from SQL
├── token/                 # PASETO token handling
├── util/                  # Utility functions
├── web/                   # Astro frontend application
└── main.go               # API server entry point
```

## 🗄️ Database Development

### Creating New Migrations

1. **Create migration files:**

   ```bash
   migrate create -ext sql -dir db/migration -seq add_new_table
   ```

   This creates two files:

   - `000002_add_new_table.up.sql` (schema changes)
   - `000002_add_new_table.down.sql` (rollback changes)

2. **Write your SQL in the `.up.sql` file:**

   ```sql
   CREATE TABLE "new_table" (
     "id" BIGSERIAL PRIMARY KEY,
     "name" varchar NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT (now())
   );
   ```

3. **Write rollback SQL in the `.down.sql` file:**

   ```sql
   DROP TABLE IF EXISTS "new_table";
   ```

4. **Apply migration:**
   ```bash
   make migrateup
   ```

### Creating New Database Queries

1. **Add SQL queries to appropriate file in `db/query/`:**

   ```sql
   -- db/query/new_table.sql

   -- name: CreateNewRecord :one
   INSERT INTO new_table (name) VALUES ($1) RETURNING *;

   -- name: GetNewRecord :one
   SELECT * FROM new_table WHERE id = $1 LIMIT 1;

   -- name: ListNewRecords :many
   SELECT * FROM new_table ORDER BY id LIMIT $1 OFFSET $2;
   ```

2. **Generate Go code:**
   ```bash
   make sqlc
   ```
   This generates methods in `db/sqlc/` that you can use in your handlers.

### Installing Dependencies

#### Go Dependencies

```bash
go mod tidy
```

#### sqlc (for generating Go code from SQL)

```bash
# On WSL/Ubuntu
sudo snap install sqlc

# Alternative: using Go
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest
```

#### migrate (for database migrations)

```bash
# On WSL/Ubuntu
curl -L https://github.com/golang-migrate/migrate/releases/download/v4.14.1/migrate.linux-amd64.tar.gz | tar xvz
sudo mv migrate.linux-amd64 $GOPATH/bin/migrate
migrate --version
```

## 🛣️ Adding New API Endpoints

### 1. Create the Handler

Add your handler function to the appropriate file in `api/`:

```go
// api/new_resource.go
func (server *Server) createNewResource(c *gin.Context) {
    // Your handler logic here
    c.JSON(http.StatusOK, gin.H{"message": "success"})
}
```

### 2. Add Route to Server

In `api/server.go`, add your route to the `setupRoutes()` function:

```go
func (server *Server) setupRoutes() {
    // ... existing code ...

    newResource := v1.Group("/new-resource")
    newResource.POST("", server.createNewResource)           // POST /api/v1/new-resource
    newResource.GET("", server.getNewResources)             // GET /api/v1/new-resource
    newResource.GET("/:id", server.getNewResourceByID)      // GET /api/v1/new-resource/:id
    newResource.PUT("/:id", server.updateNewResource)       // PUT /api/v1/new-resource/:id
    newResource.DELETE("/:id", server.deleteNewResource)    // DELETE /api/v1/new-resource/:id
}
```

### 3. Test Your Endpoint

```bash
# Test with curl
curl -X GET http://localhost:8080/api/v1/new-resource

# Or check the health endpoint
curl http://localhost:8080/health
```

## 🌟 Astro Frontend Development

### Project Structure

```
web/
├── src/
│   ├── components/        # Reusable Astro/React components
│   ├── layouts/          # Page layouts
│   ├── pages/            # Routes (file-based routing)
│   │   └── api/         # API endpoints (Astro server-side)
│   ├── lib/             # Utilities and API client
│   └── styles/          # Global styles
├── public/              # Static assets
└── astro.config.mjs     # Astro configuration
```

### Key Technologies

- **Astro**: Static site generator with partial hydration
- **React**: For interactive components
- **Tailwind CSS**: Utility-first CSS framework
- **MDX**: Markdown with JSX support

### Development Commands

```bash
cd web

# Development
npm run dev              # Start dev server (localhost:4321)
npm run dev:docker       # Start dev server for Docker (0.0.0.0:4321)

# Build
npm run build           # Build for production
npm run preview         # Preview production build

# Other
npm run astro           # Run Astro CLI commands
```

### Adding New Pages

1. **Create a new page in `src/pages/`:**

   ```astro
   ---
   // src/pages/my-new-page.astro
   import Layout from '../layouts/Layout.astro';
   ---

   <Layout title="My New Page">
     <h1>Welcome to my new page!</h1>
   </Layout>
   ```

2. **For dynamic routes, use brackets:**
   ```astro
   // src/pages/blog/[slug].astro - matches /blog/anything
   // src/pages/users/[id].astro - matches /users/123
   ```

### API Integration

The frontend communicates with the Go API using the client in `src/lib/api.ts`:

```typescript
// Example API call
import { apiClient } from "../lib/api";

const posts = await apiClient.get("/posts");
```

### Adding Interactive Components

1. **Create React component:**

   ```jsx
   // src/components/InteractiveButton.jsx
   import { useState } from "react";

   export default function InteractiveButton() {
     const [count, setCount] = useState(0);

     return (
       <button onClick={() => setCount(count + 1)}>
         Clicked {count} times
       </button>
     );
   }
   ```

2. **Use in Astro page:**

   ```astro
   ---
   import InteractiveButton from '../components/InteractiveButton.jsx';
   ---

   <InteractiveButton client:load />
   ```

### Environment Variables

- `PUBLIC_API_URL`: API base URL (automatically set in Docker)
- Add more in `astro.config.mjs` or `.env` files

## 🧪 Testing

```bash
# Run all Go tests
make test

# Run with coverage
go test -v -cover -coverprofile=coverage.out ./...

# View coverage in browser
go tool cover -html=coverage.out
```

## 🐛 Troubleshooting

### Common Issues

1. **Port conflicts**: Make sure ports 5432, 8080, and 4321 are available
2. **Database connection**: Wait for PostgreSQL to be healthy before starting API
3. **Hot reload not working**: The setup uses polling for file watching in Docker

### Useful Commands

```bash
# Check running containers
docker ps

# View database
docker exec -it <postgres_container> psql -U root -d golive_cms

# Reset everything
make devdown
docker system prune -f
make dev
```

## 📚 Additional Resources

- [Gin Documentation](https://gin-gonic.com/docs/)
- [SQLC Documentation](https://docs.sqlc.dev/)
- [Astro Documentation](https://docs.astro.build/)
- [Tailwind CSS](https://tailwindcss.com/docs)
- [Migrate Documentation](https://github.com/golang-migrate/migrate)
