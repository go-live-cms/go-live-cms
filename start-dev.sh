#!/bin/sh

set -e

echo "🚀 Starting development environment..."
echo "📊 Running database migrations..."

# Wait for database to be ready and run migrations
/usr/local/bin/migrate -path /app/db/migration -database "$DB_SOURCE" -verbose up

echo "🔥 Starting live reload server with Air..."
echo "Air binary location: $(which air || echo 'Air not found in PATH')"
echo "Go bin location: /go/bin/air"

# Execute air with full path
exec /go/bin/air -c .air.toml