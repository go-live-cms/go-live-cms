// Package api — The site logo (#488, docs/design/theme-builder.md 4.1)
//
// settings.site_logo_media_id (000057) is the image Settings > General picks; NULL = none.
// PUT /settings sets it (admins only, like every setting): an image's media id, else 400
// invalid_site_logo; null clears it, absent keeps it. Deleting the media clears it (ON
// DELETE SET NULL).
//
// GET /settings returns the id as stored and `site_logo`, what the Site logo block renders:
// the media's public path, size, variants and alt text (the block-media shape of
// post_block_media.go), or null for none. GET /settings is public and cached (#185): the
// logo is part of the published site, so nothing here is private.
package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

var errInvalidSiteLogoID = errors.New("site_logo_media_id must be a media id or null")

// siteLogoUpdate interprets site_logo_media_id: set reports whether the request changes it,
// and id is the new logo (nil: none).
func (req UpdateSettingsRequest) siteLogoUpdate() (set bool, id *int64, err error) {
	raw := bytes.TrimSpace(req.SiteLogoMediaID)
	if len(raw) == 0 {
		return false, nil, nil
	}
	if string(raw) == "null" {
		return true, nil, nil
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil || value <= 0 {
		return false, nil, errInvalidSiteLogoID
	}
	return true, &value, nil
}

// checkSiteLogo answers 400 (or 500) itself unless id is an image in the media library.
func (server *Server) checkSiteLogo(c *gin.Context, id int64) bool {
	media, err := server.store.GetMedia(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			msg := "the site logo must be an image in the media library"
			c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "invalid_site_logo", "fields": gin.H{"site_logo_media_id": msg}})
			return false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the site logo"})
		return false
	}
	if !strings.HasPrefix(media.MimeType, "image/") {
		msg := "the site logo must be an image"
		c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "invalid_site_logo", "fields": gin.H{"site_logo_media_id": msg}})
		return false
	}
	return true
}

// SiteLogoResponse is GET /settings' `site_logo`: what the Site logo block and the admin's
// field show.
type SiteLogoResponse struct {
	ID         int64         `json:"id"`
	MediaPath  string        `json:"media_path"`
	Width      int32         `json:"width"`
	Height     int32         `json:"height"`
	Variants   MediaVariants `json:"variants"`
	Alt        string        `json:"alt"`
	MimeType   string        `json:"mime_type"`
	Name       string        `json:"name"`
	Filename   string        `json:"filename"`
	Decorative bool          `json:"decorative,omitempty"`
}

// siteLogo looks the logo's media up. A missing row (deleted between the two reads) or a
// failed lookup gives null, so the settings still answer; the block then shows nothing.
func (server *Server) siteLogo(ctx context.Context, settings db.Setting) *SiteLogoResponse {
	if !settings.SiteLogoMediaID.Valid {
		return nil
	}
	media, err := server.store.GetMedia(ctx, settings.SiteLogoMediaID.Int64)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			server.logger.Warn("site_logo_lookup_failed", "media_id", settings.SiteLogoMediaID.Int64, "error", err)
		}
		return nil
	}
	return &SiteLogoResponse{
		ID:         media.ID,
		MediaPath:  publicMediaPath(server.config.UploadPath, media.MediaPath),
		Width:      media.Width,
		Height:     media.Height,
		Variants:   publicVariants(server.config.UploadPath, resizedOnly(variantsResponse(media.Variants))),
		Alt:        media.Alt,
		MimeType:   media.MimeType,
		Name:       media.Name,
		Filename:   media.OriginalFilename,
		Decorative: media.Decorative,
	}
}
