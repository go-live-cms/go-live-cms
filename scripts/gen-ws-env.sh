#!/usr/bin/env bash
set -euo pipefail

echo "🔑 Generating WebSocket .env from Go API keys..."

OUT="websocket/.env"
PUBFILE="websocket/public.pem"
TMP="$(mktemp)"

# 1) Run exporter
echo "📤 Exporting keys from Go API..."
if ! go run cmd/export-pubkey/main.go > "$TMP" 2>/dev/null; then
    echo "❌ Failed to export public key. Make sure Go dependencies are installed."
    echo "   Try: go mod download"
    rm -f "$TMP"
    exit 1
fi

# 2) Extract PEM content from the multiline format
echo "🔧 Extracting PEM content..."
sed -n '/PASETO_V4_PUBLIC_PEM="/,/"$/p' "$TMP" | \
  sed '1s/PASETO_V4_PUBLIC_PEM="//; $s/"$//' | \
  sed 's/\\n/\n/g' > "$PUBFILE"

# 3) Verify PEM file was created properly
if [[ -s "$PUBFILE" ]] && grep -q "BEGIN PUBLIC KEY" "$PUBFILE"; then
    echo "✅ PEM file created successfully:"
    head -1 "$PUBFILE"
    echo "... (key content) ..."
    tail -1 "$PUBFILE"
else
    echo "❌ PEM file creation failed or is empty"
    echo "Debug: PEM file contents:"
    cat "$PUBFILE" || echo "(file empty or missing)"
    rm -f "$TMP"
    exit 1
fi

# 4) Extract issuer and audience
ISS=$(grep "PASETO_ISSUER=" "$TMP" | cut -d= -f2 || echo "golive.auth")
AUD=$(grep "PASETO_AUDIENCE=" "$TMP" | cut -d= -f2 || echo "golive.admin-ws")

# 5) Write .env
cat > "$OUT" <<EOF
# WebSocket Server Configuration
HOST=0.0.0.0
PORT=1234
NODE_ENV=development

# PASETO v4.public Authentication Configuration  
# Auto-generated from Go API keys
PASETO_ISSUER=$ISS
PASETO_AUDIENCE=$AUD
PASETO_ALLOWED_AUDIENCES=$AUD,golive.admin,golive.auth

# Use file-based PEM to avoid multiline issues in env files
PASETO_V4_PUBLIC_PEM_FILE=/run/secrets/public.pem
EOF

# Clean up
rm -f "$TMP"

echo "✅ Created $OUT with configuration"
echo "✅ Created $PUBFILE with public key"
echo ""
echo "🚀 Ready to run: make dev"