#!/bin/bash

# Start godoc documentation server
# This script starts the godoc server and opens the documentation in the browser

echo "🚀 Starting Go Live CMS Documentation Server..."

# Check if godoc is installed
if ! command -v godoc &> /dev/null
then
    echo "📦 Installing godoc..."
    go install golang.org/x/tools/cmd/godoc@latest
fi

# Start godoc server
echo "🌐 Starting godoc server on http://localhost:6060"
echo "📚 Go Live CMS documentation will be available at:"
echo "    http://localhost:6060/pkg/github.com/go-live-cms/go-live-cms/"
echo ""
echo "Press Ctrl+C to stop the server"

godoc -http=:6060
