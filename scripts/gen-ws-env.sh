#!/usr/bin/env bash
set -euo pipefail

# WebSocket Environment Setup Script
# Automatically exports keys from Go API and creates websocket/.env

echo "🔑 Generating WebSocket .env from Go API keys..."

OUT="websocket/.env"
PUBFILE="websocket/public.pem"
TMP="$(mktemp)"

# 1) Run exporter
if ! go run cmd/export-pubkey/main.go > "$TMP" 2>/dev/null; then
    echo "❌ Failed to export public key. Make sure Go dependencies are installed."
    echo "   Try: go mod download"
    rm -f "$TMP"
    exit 1
fi

# 2) Extract PEM to file (avoid multiline env values)
# First get just the PEM lines, then clean up any quotes
grep -A 2 "BEGIN PUBLIC KEY" "$TMP" | grep -E "(BEGIN|END) PUBLIC KEY|^[A-Za-z0-9+/=]+$" | sed 's/^"//' | sed 's/"$//' > "$PUBFILE"

# 3) Extract issuer/audience from exporter output (with fallbacks)
ISS=$(grep -oE '^PASETO_ISSUER=.*' "$TMP" | cut -d= -f2 || true)
AUD=$(grep -oE '^PASETO_AUDIENCE=.*' "$TMP" | cut -d= -f2 || true)
ISS=${ISS:-golive.auth}
AUD=${AUD:-golive.admin-ws}

# 4) Write .env (no multiline values)
cat > "$OUT" <<EOF
# WebSocket Server Configuration
HOST=0.0.0.0
PORT=1234
NODE_ENV=development

# PASETO v4.public Authentication Configuration  
# Auto-generated from Go API keys
PASETO_ISSUER=$ISS
# Primary audience (kept for reference)
PASETO_AUDIENCE=$AUD
# Allow a small set during migration (adjust as you converge)
PASETO_ALLOWED_AUDIENCES=$AUD,golive.admin,golive.auth

# Use file-based PEM to avoid multiline issues in env files
PASETO_V4_PUBLIC_PEM_FILE=/run/secrets/public.pem

# Alternative methods (commented out):
# PASETO_V4_PUBLIC_PEM="single_line_pem_here"
# PASETO_V4_PUBLIC_PEM_B64="base64_encoded_pem_here"
EOF

# Clean up
rm -f "$TMP"

echo "✅ Created $OUT with current Go API configuration"
echo "✅ Created $PUBFILE with public key"
echo ""
echo "🚀 Ready to run:"
echo "   docker compose -f compose.dev.yaml up --build"
echo ""
echo "ℹ️  The PEM file will be mounted in Docker at /run/secrets/public.pem"
echo "🔄 If keys change, re-run this script to update both files"