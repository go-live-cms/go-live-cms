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

type LoginUserRequest struct {
	Username string `json:"username" binding:"required,alphanum"`
	Password string `json:"password" binding:"required,min=6"`
}

type LoginUserResponse struct {
	SessionID            uuid.UUID    `json:"session_id"`
	AccessToken          string       `json:"access_token"`
	AccessTokenExpiresAt time.Time    `json:"access_token_expires_at"`
	ExpiresAt            int64        `json:"expires_at"`
	User                 UserResponse `json:"user"`
}

type RenewAccessTokenRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type RenewAccessTokenResponse struct {
	AccessToken          string    `json:"access_token"`
	AccessTokenExpiresAt time.Time `json:"access_token_expires_at"`
	ExpiresAt            int64     `json:"expires_at"`
}

type BlockSessionRequest struct {
	SessionID uuid.UUID `json:"session_id" binding:"required"`
}

type SessionResponse struct {
	ID        uuid.UUID `json:"id"`
	UserID    int64     `json:"user_id"`
	Username  string    `json:"username"`
	UserAgent string    `json:"user_agent"`
	ClientIP  string    `json:"client_ip"`
	IsBlocked bool      `json:"is_blocked"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

func toSessionResponse(session db.Session) SessionResponse {
	return SessionResponse{
		ID:        session.ID,
		UserID:    session.UserID,
		Username:  session.Username,
		UserAgent: session.UserAgent,
		ClientIP:  session.ClientIp,
		IsBlocked: session.IsBlocked,
		ExpiresAt: session.ExpiresAt,
		CreatedAt: session.CreatedAt,
	}
}

func (server *Server) loginUser(ctx *gin.Context) {
	var req LoginUserRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	user, err := server.store.GetUserByUsername(ctx.Request.Context(), req.Username)
	if err != nil {
		if err == sql.ErrNoRows {
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
			return
		}
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	err = util.CheckPassword(req.Password, user.HashedPassword)
	if err != nil {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}

	accessToken, err := server.tokenMaker.CreateToken(
		user.ID,
		user.Username,
		server.config.AccessTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create access token"})
		return
	}

	refreshToken, err := server.tokenMaker.CreateRefreshToken(
		user.ID,
		user.Username,
		server.config.RefreshTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create refresh token"})
		return
	}

	userAgent := ctx.GetHeader("User-Agent")
	clientIP := ctx.ClientIP()

	v4Maker, ok := server.tokenMaker.(*token.PasetoV4Maker)
	if !ok {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "token maker type error"})
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

	refreshHash := token.HashRefresh(refreshToken)

	sessionID := uuid.New()
	session, err := server.store.CreateSession(ctx.Request.Context(), db.CreateSessionParams{
		ID:               sessionID,
		UserID:           user.ID,
		Username:         user.Username,
		RefreshToken:     refreshToken, // Keep for backward compatibility during migration TODO: remove later
		RefreshTokenHash: refreshHash,
		RefreshKid:       sql.NullString{String: server.config.PasetoRefreshKID, Valid: true},
		Jti:              uuid.NullUUID{UUID: jtiUUID, Valid: true},
		UserAgent:        userAgent,
		ClientIp:         clientIP,
		IsBlocked:        false,
		ExpiresAt:        time.Now().Add(server.config.RefreshTokenDuration),
	})
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create session"})
		return
	}

	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     "refresh_token",
		Value:    refreshToken,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		Path:     "/api/v1/auth", // Broader path to include refresh AND logout
		Expires:  time.Now().Add(server.config.RefreshTokenDuration),
		Domain:   server.config.CookieDomain,
	})

	accessExpiresAt := time.Now().Add(server.config.AccessTokenDuration)
	rsp := LoginUserResponse{
		SessionID:            session.ID,
		AccessToken:          accessToken,
		AccessTokenExpiresAt: accessExpiresAt,
		ExpiresAt:            accessExpiresAt.Unix(),
		User:                 toUserResponse(user),
	}

	ctx.JSON(http.StatusOK, rsp)
}

func (server *Server) renewAccessToken(ctx *gin.Context) {

	var refreshToken string

	cookie, err := ctx.Request.Cookie("refresh_token")
	if err == nil && cookie.Value != "" {
		refreshToken = cookie.Value
	} else {
		// Fallback to JSON body for backward compatibility TODO: deprecate this later
		var req RenewAccessTokenRequest
		if err := ctx.ShouldBindJSON(&req); err != nil {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "refresh token required"})
			return
		}
		refreshToken = req.RefreshToken
	}

	if refreshToken == "" {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "refresh token required"})
		return
	}

	v4Maker, ok := server.tokenMaker.(*token.PasetoV4Maker)
	if !ok {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "token maker type error"})
		return
	}

	refreshParsed, err := v4Maker.ParseRefresh(refreshToken)
	if err != nil {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "invalid refresh token"})
		return
	}

	username, _ := refreshParsed.GetString("username")
	userIDStr, _ := refreshParsed.GetString("user_id")
	userID, err := strconv.ParseInt(userIDStr, 10, 64)
	if err != nil {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user_id in token"})
		return
	}

	tokenType, _ := refreshParsed.GetString("token_type")
	if tokenType != "refresh" {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token type"})
		return
	}

	refreshHash := token.HashRefresh(refreshToken)

	session, err := server.store.GetSessionByRefreshTokenHash(ctx.Request.Context(), refreshHash)
	if err != nil {
		if err == sql.ErrNoRows {
			ctx.JSON(http.StatusUnauthorized, gin.H{"error": "session not found"})
		} else {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		}
		return
	}

	if session.IsBlocked {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "session is blocked"})
		return
	}

	if time.Now().After(session.ExpiresAt) {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "session expired"})
		return
	}

	if session.Username != username || session.UserID != userID {
		ctx.JSON(http.StatusUnauthorized, gin.H{"error": "token/session mismatch"})
		return
	}

	currentUserAgent := ctx.GetHeader("User-Agent")
	currentIP := ctx.ClientIP()
	if currentUserAgent != session.UserAgent {

		fmt.Printf("⚠️ User-Agent change detected for user %s: %s -> %s\n", username, session.UserAgent, currentUserAgent)
	}
	if currentIP != session.ClientIp {

		fmt.Printf("⚠️ IP address change detected for user %s: %s -> %s\n", username, session.ClientIp, currentIP)
	}

	accessToken, err := server.tokenMaker.CreateToken(
		userID,
		username,
		server.config.AccessTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create access token"})
		return
	}

	newRefreshToken, err := server.tokenMaker.CreateRefreshToken(
		userID,
		username,
		server.config.RefreshTokenDuration,
	)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create refresh token"})
		return
	}

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

	newRefreshHash := token.HashRefresh(newRefreshToken)

	err = server.store.RotateSession(ctx.Request.Context(), db.RotateSessionParams{
		ID:         session.ID,
		ReplacedBy: uuid.NullUUID{UUID: newJtiUUID, Valid: true},
	})
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to rotate session"})
		return
	}

	newSessionID := uuid.New()
	_, err = server.store.CreateSession(ctx.Request.Context(), db.CreateSessionParams{
		ID:               newSessionID,
		UserID:           userID,
		Username:         username,
		RefreshToken:     newRefreshToken, // Keep for backward compatibility during migration TODO: remove later
		RefreshTokenHash: newRefreshHash,
		RefreshKid:       sql.NullString{String: server.config.PasetoRefreshKID, Valid: true},
		Jti:              uuid.NullUUID{UUID: newJtiUUID, Valid: true},
		UserAgent:        currentUserAgent,
		ClientIp:         currentIP,
		IsBlocked:        false,
		ExpiresAt:        time.Now().Add(server.config.RefreshTokenDuration),
	})
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create new session"})
		return
	}

	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     "refresh_token",
		Value:    newRefreshToken,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		Path:     "/api/v1/auth", // Broader path to include refresh AND logout
		Expires:  time.Now().Add(server.config.RefreshTokenDuration),
		Domain:   server.config.CookieDomain,
	})

	accessExpiresAt := time.Now().Add(server.config.AccessTokenDuration)
	rsp := RenewAccessTokenResponse{
		AccessToken:          accessToken,
		AccessTokenExpiresAt: accessExpiresAt,
		ExpiresAt:            accessExpiresAt.Unix(),
	}

	ctx.JSON(http.StatusOK, rsp)
}

func (server *Server) getUserSessions(ctx *gin.Context) {

	authPayload := ctx.MustGet(authorizationPayloadKey).(*token.Payload)

	sessions, err := server.store.ListSessionsByUser(ctx.Request.Context(), authPayload.UserID)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get sessions"})
		return
	}

	sessionResponses := make([]SessionResponse, len(sessions))
	for i, session := range sessions {
		sessionResponses[i] = toSessionResponse(session)
	}

	ctx.JSON(http.StatusOK, gin.H{
		"sessions": sessionResponses,
		"count":    len(sessionResponses),
	})
}

func (server *Server) blockSession(ctx *gin.Context) {
	var req BlockSessionRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	authPayload := ctx.MustGet(authorizationPayloadKey).(*token.Payload)

	session, err := server.store.GetSession(ctx.Request.Context(), req.SessionID)
	if err != nil {
		if err == sql.ErrNoRows {
			ctx.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
			return
		}
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		return
	}

	if session.UserID != authPayload.UserID {
		ctx.JSON(http.StatusForbidden, gin.H{"error": "not authorized to block this session"})
		return
	}

	err = server.store.BlockSession(ctx.Request.Context(), req.SessionID)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to block session"})
		return
	}

	ctx.JSON(http.StatusOK, gin.H{
		"message":    "session blocked successfully",
		"session_id": req.SessionID,
	})
}

func (server *Server) logoutUser(ctx *gin.Context) {

	var refreshToken string

	cookie, err := ctx.Request.Cookie("refresh_token")
	if err == nil && cookie.Value != "" {
		refreshToken = cookie.Value
	} else {

		var req struct {
			RefreshToken string `json:"refresh_token"`
		}
		if err := ctx.ShouldBindJSON(&req); err == nil && req.RefreshToken != "" {
			refreshToken = req.RefreshToken
		} else {

			authPayload := ctx.MustGet(authorizationPayloadKey).(*token.Payload)
			sessions, err := server.store.ListSessionsByUser(ctx.Request.Context(), authPayload.UserID)
			if err != nil {
				ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get sessions"})
				return
			}

			currentUserAgent := ctx.GetHeader("User-Agent")
			currentClientIP := ctx.ClientIP()

			for _, session := range sessions {
				if session.UserAgent == currentUserAgent && session.ClientIp == currentClientIP && !session.IsBlocked {
					refreshToken = session.RefreshToken
					break
				}
			}
		}
	}

	if refreshToken == "" {

		http.SetCookie(ctx.Writer, &http.Cookie{
			Name:     "refresh_token",
			Value:    "",
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteStrictMode,
			Path:     "/api/v1/auth", // Same path as when setting
			MaxAge:   -1,
			Domain:   server.config.CookieDomain,
		})
		ctx.JSON(http.StatusOK, gin.H{"message": "logged out successfully"})
		return
	}

	refreshHash := token.HashRefresh(refreshToken)

	session, err := server.store.GetSessionByRefreshTokenHash(ctx.Request.Context(), refreshHash)
	if err != nil {
		if err == sql.ErrNoRows {

			http.SetCookie(ctx.Writer, &http.Cookie{
				Name:     "refresh_token",
				Value:    "",
				HttpOnly: true,
				Secure:   true,
				SameSite: http.SameSiteStrictMode,
				Path:     "/api/v1/auth", // Same path as when setting
				MaxAge:   -1,
				Domain:   server.config.CookieDomain,
			})
			ctx.JSON(http.StatusOK, gin.H{"message": "logged out successfully"})
			return
		}
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		return
	}

	err = server.store.BlockSession(ctx.Request.Context(), session.ID)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to block session"})
		return
	}

	http.SetCookie(ctx.Writer, &http.Cookie{
		Name:     "refresh_token",
		Value:    "",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		Path:     "/api/v1/auth", // Same path as when setting
		MaxAge:   -1,
		Domain:   server.config.CookieDomain,
	})

	ctx.JSON(http.StatusOK, gin.H{
		"message": "logged out successfully",
	})
}
