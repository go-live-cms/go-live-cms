#!/bin/bash

# WebSocket Development Setup Script

echo "🚀 Setting up WebSocket server with hot reload..."

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Please run this script from the websocket/ directory"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo ""
echo "🔧 Setup complete! Choose your development method:"
echo ""
echo "Option 1 - Local development:"
echo "  npm run dev"
echo ""
echo "Option 2 - Docker development (recommended):"
echo "  docker compose -f docker-compose.dev.yml up --build"
echo ""
echo "⚠️  IMPORTANT: Before starting, you need to:"
echo "  1. Run 'go run cmd/export-pubkey/main.go' in your Go project"
echo "  2. Copy the public key to your .env file"
echo ""
echo "🔍 Test with: curl http://localhost:1234/"
echo "   Should respond with: 'GoLive WebSocket server is running'"
echo ""
echo "🔥 Hot reload is enabled - server restarts on file changes!"