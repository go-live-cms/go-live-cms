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
- 🎟️ **Single-use tickets**: Short-lived, doc-bound tickets instead of access tokens in the URL
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

- Consider using `PASETO_V4_PUBLIC_PEM_FILE` for file-based keys
- Sockets authenticate with `?ticket=<collab ticket>`: single use, 30s, bound to one
  document, minted by `POST /api/v1/collab/tickets`. Access tokens are never accepted,
  so a proxy access log holding the socket URL holds nothing replayable (#233).
- Set `API_URL` (required) to the Go API base, e.g. `http://api:8080/api/v1`. Every
  connection redeems its ticket there, which also returns the caller's current role.
  Only admins and editors may connect.

## Troubleshooting

- **"No ticket provided"**: The client didn't fetch a ticket from `POST /collab/tickets`
- **401 "Invalid or expired ticket"**: Bad signature or issuer (check the public key and
  `PASETO_ISSUER` match the API), the ticket is for another document, expired, or was
  already used. Every connect needs a fresh ticket
- **403 Forbidden on connect**: The user isn't an admin or editor (contributors can't
  collaborate)
- **503 Service Unavailable on connect**: Ticket redemption at `API_URL` failed. Check
  that the API is up and reachable from the websocket container
- **Server exits with "API_URL is required"**: Add `API_URL` to `websocket/.env` or the
  compose `environment:` block
- **Hot reload not working**: Ensure `CHOKIDAR_USEPOLLING=true` in Docker
