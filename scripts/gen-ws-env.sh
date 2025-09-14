#!/usr/bin/env bash
set -euo pipefail

# WebSocket Environment Setup Script
# Automatically exports keys from Go API and creates websocket/.env

echo "🔑 Generating WebSocket .env from Go API keys..."

OUT="websocket/.env"
TEMP_KEY=$(mktemp)

# Export the public key from Go API
if ! go run cmd/export-pubkey/main.go > "$TEMP_KEY" 2>/dev/null; then
    echo "❌ Failed to export public key. Make sure Go dependencies are installed."
    echo "   Try: go mod download"
    rm -f "$TEMP_KEY"
    exit 1
fi

# Extract just the PEM from the output (skip comments)
PEM_CONTENT=$(grep -A 10 "BEGIN PUBLIC KEY" "$TEMP_KEY" | grep -E "(BEGIN|END) PUBLIC KEY|^[A-Za-z0-9+/=]+$")

# Create the .env file
cat > "$OUT" << EOF
# WebSocket Server Configuration
HOST=0.0.0.0
PORT=1234
NODE_ENV=development

# PASETO v4.public Authentication Configuration  
# Auto-generated from Go API keys
PASETO_ISSUER=golive.auth
PASETO_AUDIENCE=golive.admin-ws

# Support multiple audiences (comma-separated)
# Keep golive.admin while migrating, remove later when using WS-specific tokens
PASETO_ALLOWED_AUDIENCES=golive.admin-ws,golive.auth,golive.admin

# PASETO v4.public Ed25519 public key
PASETO_V4_PUBLIC_PEM="$PEM_CONTENT"

# Alternative methods (commented out):
# PASETO_V4_PUBLIC_PEM_B64="base64_encoded_pem_here"
# PASETO_V4_PUBLIC_PEM_FILE="/run/secrets/public.pem"
EOF

# Clean up
rm -f "$TEMP_KEY"

echo "✅ Created $OUT with current Go API public key"
echo ""
echo "🚀 Ready to run:"
echo "   docker compose -f compose.dev.yaml up --build"
echo ""
echo "🔄 If keys change, re-run this script to update the WebSocket .env"