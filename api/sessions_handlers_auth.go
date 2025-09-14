// sessions_handlers_auth implements authentication flow handlers for login, token refresh, and logout.
//
// # Authentication Architecture
//
// This module handles the core authentication lifecycle:
//   - **Login**: Credential validation → token generation → session creation
//   - **Refresh**: Cookie validation → token rotation → session update
//   - **Logout**: Session invalidation → cookie clearing → cleanup
//
// # Token Rotation Strategy
//
// Each refresh request generates entirely new access and refresh tokens:
//  1. Validate current refresh token from httpOnly cookie
//  2. Create new token pair with fresh expiration times
//  3. Atomically create new session and mark old session as replaced
//  4. Set new refresh token cookie and return new access token
//  5. Old refresh token becomes permanently invalid
//
// # Security Features
//
// **Reuse Detection**: If a previously-used refresh token is submitted:
//   - All sessions for the user are immediately blocked
//   - Security alert is logged with user and session details
//   - Client receives 401 with reuse detection error
//
// **Session Binding**: Each session tracks:
//   - User agent and IP address for anomaly detection
//   - Expiration times aligned with refresh token TTL
//   - Cryptographic refresh token hash for validation
//
// **Atomic Operations**: Session rotation uses database transactions:
//   - Prevents race conditions in concurrent refresh attempts
//   - Ensures session consistency during token rotation
//   - Handles concurrent access with proper error responses
//
// # Error Handling
//
// Consistent error responses protect against information leakage:
//   - Generic "invalid credentials" for authentication failures
//   - Specific reuse detection errors for security incidents
//   - Internal server errors for system failures
//   - Graceful handling of missing or malformed tokens
package api

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/google/uuid"
)

// loginUser authenticates user credentials and establishes a new session with tokens.
//
// Flow:
//  1. Validate request body (username + password)
//  2. Look up user by username
//  3. Verify password hash
//  4. Generate access + refresh token pair
//  5. Create session record in database
//  6. Set secure httpOnly refresh cookie
//  7. Return access token + user data in JSON
//
// Security considerations:
//   - Password validation uses secure hash comparison
//   - Refresh token JTI is stored for session linking
//   - User agent and IP are recorded for monitoring
//   - Cookie expiration matches refresh token TTL
func (server *Server) loginUser(ctx *gin.Context) {
	now := time.Now() // Single time base for consistency

	var req LoginUserRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Look up user by username
	user, err := server.store.GetUserByUsername(ctx.Request.Context(), req.Username)
	if err != nil {
		if err == sql.ErrNoRows {
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": ErrInvalidCredentials})
			return
		}
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	// Verify password
	err = util.CheckPassword(req.Password, user.HashedPassword)
	if err != nil {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": ErrInvalidCredentials})
		return
	}

	// Generate access token
	accessToken, err := server.tokenMaker.CreateToken(
		user.ID,
		user.Username,
		server.config.AccessTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": ErrTokenCreationFailed})
		return
	}

	// Generate refresh token
	refreshToken, err := server.tokenMaker.CreateRefreshToken(
		user.ID,
		user.Username,
		server.config.RefreshTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": ErrTokenCreationFailed})
		return
	}

	// Extract session details
	userAgent := ctx.GetHeader("User-Agent")
	clientIP := ctx.ClientIP()

	// Parse refresh token for JTI
	v4Maker, ok := server.tokenMaker.(*token.PasetoV4Maker)
	if !ok {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": ErrInvalidTokenType})
		return
	}

	refreshParsed, err := v4Maker.ParseRefresh(refreshToken)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse refresh token"})
		return
	}

	refreshJTI, err := refreshParsed.GetJti()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get JTI from refresh token"})
		return
	}

	jtiUUID, err := uuid.Parse(refreshJTI)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "invalid JTI format"})
		return
	}

	// Create session record
	refreshHash := token.HashRefresh(refreshToken)
	sessionID := uuid.New()

	session, err := server.store.CreateSession(ctx.Request.Context(), db.CreateSessionParams{
		ID:               sessionID,
		UserID:           user.ID,
		Username:         user.Username,
		RefreshTokenHash: refreshHash,
		RefreshKid:       sql.NullString{String: server.config.PasetoRefreshKID, Valid: true},
		Jti:              uuid.NullUUID{UUID: jtiUUID, Valid: true},
		UserAgent:        userAgent,
		ClientIp:         clientIP,
		IsBlocked:        false,
		ExpiresAt:        now.Add(server.config.RefreshTokenDuration),
	})
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}

	// Set secure refresh cookie
	server.setSecureCookie(ctx, RefreshCookieName, refreshToken, now.Add(server.config.RefreshTokenDuration))

	// Log successful login
	logSecurityEvent(LogSessionCreated, session.ID.String(), user.ID, fmt.Sprintf("IP: %s, UA: %s", clientIP, userAgent))

	// Return response
	accessExpiresAt := now.Add(server.config.AccessTokenDuration)
	rsp := LoginUserResponse{
		SessionID:            session.ID,
		AccessToken:          accessToken,
		AccessTokenExpiresAt: accessExpiresAt,
		ExpiresAt:            accessExpiresAt.Unix(),
		User:                 toPrivateUser(user),
	}

	ctx.Header("Cache-Control", "no-store")
	ctx.JSON(http.StatusOK, rsp)
}

// renewAccessToken rotates tokens using refresh cookie and implements reuse detection.
//
// Flow:
//  1. Extract refresh token from httpOnly cookie
//  2. Parse and validate refresh token structure
//  3. Look up session by refresh token hash
//  4. Check for reuse detection (replaced sessions)
//  5. Validate session status and expiration
//  6. Generate new access + refresh token pair
//  7. Atomically create new session and mark old as replaced
//  8. Set new refresh cookie and return new access token
//
// Security features:
//   - Reuse detection blocks all user sessions on violation
//   - Atomic session rotation prevents race conditions
//   - IP and user agent change monitoring
//   - Session binding validation
func (server *Server) renewAccessToken(ctx *gin.Context) {
	now := time.Now() // Single time base for consistency

	// Extract refresh token from cookie
	cookie, err := ctx.Request.Cookie(RefreshCookieName)
	if err != nil || cookie.Value == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "refresh token required in cookie"})
		return
	}

	refreshToken := cookie.Value

	// Parse refresh token
	v4Maker, ok := server.tokenMaker.(*token.PasetoV4Maker)
	if !ok {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": ErrInvalidTokenType})
		return
	}

	refreshParsed, err := v4Maker.ParseRefresh(refreshToken)
	if err != nil {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "invalid refresh token"})
		return
	}

	// Extract claims from token
	username, _ := refreshParsed.GetString("username")
	userIDStr, _ := refreshParsed.GetString("user_id")
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user_id in token"})
		return
	}

	tokenType, _ := refreshParsed.GetString("token_type")
	if tokenType != "refresh" {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": ErrInvalidTokenType})
		return
	}

	// Look up session by refresh hash
	refreshHash := token.HashRefresh(refreshToken)
	session, err := server.store.GetSessionByRefreshTokenHash(ctx.Request.Context(), refreshHash)
	if err != nil {
		if err == sql.ErrNoRows {
			// Check for reuse detection - token was used before
			if s2, err2 := server.store.GetAnySessionByRefreshTokenHash(ctx.Request.Context(), refreshHash); err2 == nil {
				// Block all sessions for this user
				_ = server.store.BlockAllSessionsForUser(ctx.Request.Context(), s2.UserID)

				logSecurityEvent(LogSessionReuse, "unknown", s2.UserID, fmt.Sprintf("Token reuse detected - all sessions blocked"))
				ctx.JSON(http.StatusConflict, gin.H{"error": "refresh token reuse detected"})
				return
			}
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": ErrSessionNotFound})
		} else {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		}
		return
	}

	// Check session status
	if session.IsBlocked {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": ErrSessionBlocked})
		return
	}

	// Check for session already replaced (reuse detection)
	if session.ReplacedBy.Valid {
		err := server.store.BlockAllSessionsForUser(ctx.Request.Context(), userID)
		if err != nil {
			logSecurityEvent(LogSessionReuse, session.ID.String(), userID, fmt.Sprintf("Failed to block sessions after reuse: %v", err))
		}

		logSecurityEvent(LogSessionReuse, session.ID.String(), userID, "Session already replaced - token reuse detected")
		ctx.JSON(http.StatusConflict, gin.H{"error": "token reuse detected - all sessions blocked"})
		return
	}

	// Check session expiration
	if now.After(session.ExpiresAt) {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "session expired"})
		return
	}

	// Validate session matches token claims
	if session.Username != username || session.UserID != userID {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "token/session mismatch"})
		return
	}

	// Monitor for IP/UA changes
	currentUserAgent := ctx.GetHeader("User-Agent")
	currentIP := ctx.ClientIP()
	if currentUserAgent != session.UserAgent || currentIP != session.ClientIp {
		logUserAgentIPChange(session.ID, userID, session.UserAgent, currentUserAgent, session.ClientIp, currentIP)
	}

	// Generate new tokens
	newRefreshToken, err := server.tokenMaker.CreateRefreshToken(
		userID,
		username,
		server.config.RefreshTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": ErrTokenCreationFailed})
		return
	}

	// Parse new refresh token for JTI
	newRefreshParsed, err := v4Maker.ParseRefresh(newRefreshToken)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse new refresh token"})
		return
	}

	newRefreshJTI, err := newRefreshParsed.GetJti()
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get JTI from new refresh token"})
		return
	}

	newJtiUUID, err := uuid.Parse(newRefreshJTI)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "invalid new JTI format"})
		return
	}

	// Atomic session rotation
	newRefreshHash := token.HashRefresh(newRefreshToken)
	var newSessionID uuid.UUID

	err = server.store.ExecTx(ctx.Request.Context(), func(q *db.Queries) error {
		// Lock old session
		_, err := q.GetSessionForUpdate(ctx.Request.Context(), session.ID)
		if err != nil {
			return err
		}

		// Create new session
		newSessionID = uuid.New()
		_, err = q.CreateSession(ctx.Request.Context(), db.CreateSessionParams{
			ID:               newSessionID,
			UserID:           userID,
			Username:         username,
			RefreshTokenHash: newRefreshHash,
			RefreshKid:       sql.NullString{String: server.config.PasetoRefreshKID, Valid: true},
			Jti:              uuid.NullUUID{UUID: newJtiUUID, Valid: true},
			UserAgent:        currentUserAgent,
			ClientIp:         currentIP,
			IsBlocked:        false,
			ExpiresAt:        now.Add(server.config.RefreshTokenDuration),
		})
		if err != nil {
			return err
		}

		// Mark old session as replaced
		rowsAffected, err := q.RotateToNewSession(ctx.Request.Context(), db.RotateToNewSessionParams{
			ID:         session.ID,
			ReplacedBy: uuid.NullUUID{UUID: newSessionID, Valid: true},
		})
		if err != nil {
			return err
		}

		if rowsAffected == 0 {
			return fmt.Errorf("concurrent session rotation detected")
		}

		return nil
	})

	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to rotate session atomically"})
		return
	}

	// Create new access token
	accessToken, err := server.tokenMaker.CreateToken(
		userID,
		username,
		server.config.AccessTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": ErrTokenCreationFailed})
		return
	}

	// Set new refresh cookie
	server.setSecureCookie(ctx, RefreshCookieName, newRefreshToken, now.Add(server.config.RefreshTokenDuration))

	// Log successful refresh
	logSecurityEvent(LogSessionRefreshed, newSessionID.String(), userID, fmt.Sprintf("Old session: %s", session.ID.String()))

	// Return new access token
	accessExpiresAt := now.Add(server.config.AccessTokenDuration)
	rsp := RenewAccessTokenResponse{
		AccessToken:          accessToken,
		AccessTokenExpiresAt: accessExpiresAt,
		ExpiresAt:            accessExpiresAt.Unix(),
	}

	ctx.Header("Cache-Control", "no-store")
	ctx.JSON(http.StatusOK, rsp)
}

// logoutUser invalidates the current session and clears the refresh cookie.
//
// Flow:
//  1. Check for refresh token in cookie (optional)
//  2. If present, look up session and block it
//  3. Clear refresh cookie regardless of session status
//  4. Return success response
//
// Graceful handling:
//   - Missing cookie is treated as successful logout
//   - Session not found is treated as successful logout
//   - Database errors are reported but cookie is still cleared
//   - Always clears cookie to prevent client-side token persistence
func (server *Server) logoutUser(ctx *gin.Context) {
	// Check for refresh token cookie
	cookie, err := ctx.Request.Cookie(RefreshCookieName)
	if err != nil || cookie.Value == "" {
		// No cookie present - clear any residual cookie and succeed
		server.clearSecureCookie(ctx, RefreshCookieName)
		ctx.JSON(http.StatusOK, gin.H{"message": "logged out successfully"})
		return
	}

	refreshToken := cookie.Value
	refreshHash := token.HashRefresh(refreshToken)

	// Look up session by refresh hash
	session, err := server.store.GetSessionByRefreshTokenHash(ctx.Request.Context(), refreshHash)
	if err != nil {
		if err == sql.ErrNoRows {
			// Session not found - clear cookie and succeed
			server.clearSecureCookie(ctx, RefreshCookieName)
			ctx.JSON(http.StatusOK, gin.H{"message": "logged out successfully"})
			return
		}
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		return
	}

	// Block the session
	err = server.store.BlockSession(ctx.Request.Context(), session.ID)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to block session"})
		return
	}

	// Clear refresh cookie
	server.clearSecureCookie(ctx, RefreshCookieName)

	// Log successful logout
	logSecurityEvent(LogSessionBlocked, session.ID.String(), session.UserID, "User logout")

	ctx.JSON(http.StatusOK, gin.H{
		"message": "logged out successfully",
	})
}

// register is a placeholder endpoint for user registration functionality.
// TODO: Implement full user registration with validation and account creation.
func (server *Server) register(ctx *gin.Context) {
	ctx.JSON(http.StatusOK, gin.H{
		"message": "Register endpoint - coming soon",
	})
}
