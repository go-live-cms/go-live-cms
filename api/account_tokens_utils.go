// account_tokens_utils holds the shared pieces of the emailed-token flows
// (invitations, password reset): token minting and hashing, links, and mail.
//
// # Tokens
//
// 32 bytes from crypto/rand, base64url without padding (43 characters). Only
// their SHA-256 is stored: they are high-entropy random values, so a fast
// hash is enough, and it lets the lookup be an indexed equality match. They
// are never logged and never appear in API responses other than the email.
package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/mailer"
)

const (
	accountTokenBytes = 32
	// accountTokenLen is the encoded length: base64url, no padding.
	accountTokenLen = (accountTokenBytes*8 + 5) / 6

	// mailSendTimeout bounds one email delivery.
	mailSendTimeout = 30 * time.Second

	// Paths of the web pages the emailed links open (web/src/pages).
	acceptInvitePath  = "/accept-invite"
	resetPasswordPath = "/reset-password"
)

// newAccountToken returns a fresh random token and its hash for storage.
func newAccountToken() (token string, hash []byte, err error) {
	b := make([]byte, accountTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, hashAccountToken(token), nil
}

// hashAccountToken is the stored form of a token.
func hashAccountToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// parseAccountToken returns the hash of a well-formed token, or false for
// anything that can't be one of ours (skipping the database lookup).
func parseAccountToken(token string) ([]byte, bool) {
	if len(token) != accountTokenLen {
		return nil, false
	}
	if _, err := base64.RawURLEncoding.DecodeString(token); err != nil {
		return nil, false
	}
	return hashAccountToken(token), true
}

// respondInvalidAccountToken is the one answer for an unknown, malformed,
// expired, revoked or used token: callers can't tell them apart.
func respondInvalidAccountToken(c *gin.Context) {
	c.JSON(http.StatusBadRequest, gin.H{"error": "this link is invalid or has expired", "code": "invalid_token"})
}

// accountLink builds an emailed link. The token goes in the fragment, which
// browsers never send to a server, so it stays out of access logs, proxies
// and Referer headers; the page reads it and POSTs it to the API.
func (server *Server) accountLink(path, token string) string {
	return server.publicURL + path + "#token=" + token
}

// siteTitle is the site title setting for email subjects and bodies, or the
// default when it can't be read (an email beats no email).
func (server *Server) siteTitle(ctx context.Context) string {
	settings, err := server.store.GetSettings(ctx)
	if err != nil || !settings.SiteTitle.Valid || settings.SiteTitle.String == "" {
		return mailer.DefaultSiteTitle
	}
	return settings.SiteTitle.String
}

// sendMail delivers msg with a bounded wait. ctx should not be a request
// context that ends when the response is written.
func (server *Server) sendMail(ctx context.Context, msg mailer.Message) error {
	ctx, cancel := context.WithTimeout(ctx, mailSendTimeout)
	defer cancel()
	return server.mailer.Send(ctx, msg)
}
