# WebSocket Development Setup

This setup provides hot-reload WebSocket collaboration with PASETO v4.public authentication.

## Quick Start (New Developer)

1. **Clone and setup keys:**

   ```bash
   git clone <repo>
   cd go-live-cms
   ./scripts/gen-ws-env.sh    # Auto-creates websocket/.env with keys
   ```

2. **Start development environment:**
   ```bash
   docker compose -f compose.dev.yaml up --build
   ```

That's it! The WebSocket server will be running on `ws://localhost:1234` with hot-reload.

## What's Running

- **Postgres**: Database (port 5432)
- **API**: Go backend with PASETO authentication (port 8080)
- **Web**: Astro frontend (port 4321)
- **WebSocket**: Collaborative editing server with auth (port 1234)

## Development Features

- 🔥 **Hot Reload**: File changes auto-restart the WebSocket server
- 🔐 **Secure**: PASETO v4.public token verification
- 🎯 **Multi-audience**: Supports tokens from different services
- 📝 **Debugging**: Detailed logs for auth flow (dev only)

## Manual Setup (Alternative)

If the automated script doesn't work:

1. Copy template: `cp websocket/.env.example websocket/.env`
2. Get public key: `go run cmd/export-pubkey/main.go`
3. Update `PASETO_V4_PUBLIC_PEM` in `websocket/.env`
4. Run: `docker compose -f compose.dev.yaml up --build`

## Testing

Test WebSocket authentication:

```bash
cd websocket
./test-auth.sh
```

## Production Notes

- Token previews are hidden in production (`NODE_ENV=production`)
- Consider using `PASETO_V4_PUBLIC_PEM_FILE` for file-based keys
- Remove `golive.admin` from `PASETO_ALLOWED_AUDIENCES` when using WS-specific tokens

## Troubleshooting

- **"No ticket provided"**: Frontend isn't passing authentication token
- **"Token invalid"**: Check audience mismatch between API and WebSocket server
- **Hot reload not working**: Ensure `CHOKIDAR_USEPOLLING=true` in Docker
