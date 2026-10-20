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

# 1) Extract the hex public key from app.env (anchored, so comments are ignored)
echo "📤 Reading public key from app.env..."
read_env() { grep -E "^$1=" app.env | tail -n1 | cut -d= -f2- | tr -d ' \r"' || true; }
PUB_KEY_HEX="$(read_env PASETO_V4_PUBLIC_KEY_HEX)"

if [[ ! "$PUB_KEY_HEX" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "❌ PASETO_V4_PUBLIC_KEY_HEX missing or not 64 hex chars (32 bytes) in app.env"
    exit 1
fi

for tool in xxd base64 fold; do
    command -v "$tool" >/dev/null || { echo "❌ '$tool' is required but not installed"; exit 1; }
done

# 2) Wrap the raw Ed25519 key in an SPKI DER structure and PEM-encode it.
# SPKI prefix for Ed25519: 302a300506032b6570032100 (12 bytes) + 32-byte key.
# Bytes are piped straight through, never stored in shell variables (which
# would drop NULs and trailing newlines).
echo "🔧 Converting public key to PEM format..."
{
    echo "-----BEGIN PUBLIC KEY-----"
    printf '%s' "302a300506032b6570032100${PUB_KEY_HEX}" | xxd -r -p | base64 | tr -d '\n' | fold -w 64
    echo
    echo "-----END PUBLIC KEY-----"
} > "$PUBFILE"

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
ISS="$(read_env PASETO_ISSUER)"; ISS="${ISS:-golive.auth}"

# 6) Write .env
cat > "$OUT" <<EOF
# WebSocket Server Configuration
HOST=0.0.0.0
PORT=1234
NODE_ENV=development

# PASETO v4.public Authentication Configuration
# Auto-generated from Go API keys. Sockets authenticate with single-use collab
# tickets (audience golive.admin-ws, fixed), never with access tokens (#233).
PASETO_ISSUER=$ISS

# Use file-based PEM to avoid multiline issues in env files
PASETO_V4_PUBLIC_PEM_FILE=/run/secrets/public.pem
EOF

echo "✅ Created $OUT with configuration"
echo "✅ Created $PUBFILE with public key"
echo ""
echo "🚀 Ready to run: make dev"