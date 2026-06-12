#!/usr/bin/env bash
set -euo pipefail

# Navigate to repo root (script is in scripts/ subdirectory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

echo "🔑 Generating WebSocket .env from Go API keys..."

# Check if app.env exists
if [[ ! -f "app.env" ]]; then
    echo "❌ app.env not found. Please create it from example.app.env:"
    echo "   cp example.app.env app.env"
    exit 1
fi

OUT="websocket/.env"
PUBFILE="websocket/public.pem"

# 1) Extract the hex public key from app.env
echo "📤 Reading public key from app.env..."
PUB_KEY_HEX=$(grep "PASETO_V4_PUBLIC_KEY_HEX=" app.env | cut -d= -f2 | tr -d ' ')

if [[ -z "$PUB_KEY_HEX" ]]; then
    echo "❌ PASETO_V4_PUBLIC_KEY_HEX not found in app.env"
    exit 1
fi

# 2) Convert hex string to binary, then base64
echo "🔧 Converting public key to PEM format..."
PUB_KEY_BIN=$(echo -n "$PUB_KEY_HEX" | xxd -r -p)
PUB_KEY_B64=$(echo -n "$PUB_KEY_BIN" | base64 -w 64)

# 3) Create PEM file with proper headers (Ed25519 public key)
# The key type identifier for Ed25519 public keys is: 302a300506032b6570 (in hex)
# We prepend this to the actual public key
KEY_TYPE_HEX="302a300506032b6570"
KEY_TYPE_BIN=$(echo -n "$KEY_TYPE_HEX" | xxd -r -p)
FULL_KEY_BIN=$(printf "%b%b" "$KEY_TYPE_BIN" "$PUB_KEY_BIN")
FULL_KEY_B64=$(echo -n "$FULL_KEY_BIN" | base64 -w 64)

cat > "$PUBFILE" <<'PEMEOF'
-----BEGIN PUBLIC KEY-----
PEMEOF
echo "$FULL_KEY_B64" >> "$PUBFILE"
cat >> "$PUBFILE" <<'PEMEOF'
-----END PUBLIC KEY-----
PEMEOF

# 4) Verify PEM file was created properly
if [[ -s "$PUBFILE" ]] && grep -q "BEGIN PUBLIC KEY" "$PUBFILE"; then
    echo "✅ PEM file created successfully:"
    head -1 "$PUBFILE"
    echo "... (key content) ..."
    tail -1 "$PUBFILE"
else
    echo "❌ PEM file creation failed or is empty"
    rm -f "$PUBFILE"
    exit 1
fi

# 5) Extract issuer and audience
ISS=$(grep "PASETO_ISSUER=" app.env | cut -d= -f2 | tr -d ' ' || echo "golive.auth")
AUD=$(grep "PASETO_AUDIENCE=" app.env | cut -d= -f2 | tr -d ' ' || echo "golive.admin-ws")

# 6) Write .env
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

echo "✅ Created $OUT with configuration"
echo "✅ Created $PUBFILE with public key"
echo ""
echo "🚀 Ready to run: make dev"