// Package api — Sessions & Authentication Module
//
// Complete authentication and session management system providing secure login/logout flows,
// token rotation with reuse detection, and administrative session management.
//
// # Authentication Model
//
// This module implements a dual-token architecture optimized for web applications:
//
//   - **Access Tokens**: Short-lived Bearer tokens (15-30 min) for API authorization
//
//   - Sent via Authorization: Bearer header
//
//   - Contains user ID, username, expiration
//
//   - Used by authMiddleware for request authentication
//
//   - **Refresh Tokens**: Long-lived tokens (7-30 days) for session persistence
//
//   - Stored in secure, httpOnly, SameSite=Strict cookies
//
//   - Path-restricted to /api/v1/auth
//
//   - Contains session ID for database linkage
//
//   - Used exclusively for access token renewal
//
// # Token Rotation & Security
//
// **Automatic Rotation**: Each refresh request issues new access + refresh tokens,
// invalidating the previous refresh token. This limits exposure windows and enables
// reuse detection.
//
// **Reuse Detection**: If a previously-used refresh token is presented, the entire
// session is immediately blocked as a potential compromise indicator. This protects
// against token theft scenarios.
//
// **Session Binding**: Refresh tokens are bound to session records containing:
//   - User agent and IP tracking for anomaly detection
//   - Expiration management
//   - Admin blocking capabilities
//
// # Route Organization
//
// **Public Authentication Endpoints** (/api/v1/auth):
//   - POST /login — Password authentication → access + refresh tokens
//   - POST /refresh — Cookie-based renewal → new access + refresh tokens
//   - POST /logout — Destroys current session (requires access token)
//
// **Protected Session Management** (/api/v1/sessions):
//   - GET / — List user's active sessions (admin or self)
//   - PUT /block — Block specific session by ID
//
// # Cross-Module Dependencies
//
// **Token System** (`token` package):
//   - PasetoV4Maker for secure token creation/validation
//   - Payload extraction and JTI handling
//   - Configurable expiration and issuer/audience claims
//
// **Database Layer** (`db/sqlc`):
//   - CreateSession, GetSession, BlockSession operations
//   - User lookup and credential validation
//   - Session listing with pagination and filtering
//
// **Middleware Integration** (`auth.go`):
//   - Bearer token validation for protected endpoints
//   - Payload injection into request context
//   - Error handling for expired/invalid tokens
//
// **Configuration** (`util` package):
//   - Cookie security settings (domain, secure flags)
//   - Token duration configuration
//   - Development vs production cookie behavior
//
// # HTTP Status Codes
//
// **Authentication Flow**:
//   - 200 OK — Successful login/refresh/logout
//   - 401 Unauthorized — Invalid credentials, expired/malformed tokens
//   - 409 Conflict — Session reuse detected (security violation)
//   - 500 Internal Server Error — Token creation, database, or hashing failures
//
// **Session Management**:
//   - 200 OK — Session list retrieved, session blocked successfully
//   - 400 Bad Request — Invalid session ID format or missing parameters
//   - 404 Not Found — Session not found or unauthorized access
//   - 403 Forbidden — Insufficient permissions for admin operations
//
// # Implementation Files
//
//   - `sessions_routes.go` — Route registration and middleware application
//   - `sessions_bindings.go` — Request/response structures and validation
//   - `sessions_presenters.go` — Response formatting and data transformation
//   - `sessions_handlers_auth.go` — Login/refresh/logout implementation
//   - `sessions_handlers_manage.go` — Session listing and administrative actions
//   - `sessions_cookies.go` — Secure cookie utilities and configuration
//   - `sessions_utils.go` — Token helpers, logging, and common utilities
//
// # Security Considerations
//
// - httpOnly cookies prevent XSS token theft
// - SameSite=Strict provides CSRF protection
// - Secure flag enforced in production
// - Token rotation limits credential lifetime
// - Reuse detection identifies potential compromises
// - Session binding enables behavioral analysis
package api
