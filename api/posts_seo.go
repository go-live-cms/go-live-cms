// Package api — Post SEO settings (#357)
//
// A post's SEO title, meta description, social image, "Hide from search engines"
// (noindex) and canonical URL are typed columns on posts (000031). They are post
// settings like the title and excerpt (#358): golive_post_settings snapshots them,
// so on a published post an edit reaches the site on Update, versions record them
// and restore-settings brings them back.
//
//   - PUT /posts/:id/seo replaces them as a whole. Editors and admins only
//     (requireContentEditor, the content rule): contributors see them read-only.
//   - GET /posts/:id answers the working values as "seo" (the admin's).
//   - /public/posts/:id and /slug/:slug answer the published values as "seo", with
//     the social image resolved: the social image, else the featured image, else
//     none, as its 1200 x 630 "social" variant (media_variants.go) when it has one.
//   - /public/posts lists each post's published noindex, so the sitemap can leave
//     it out. Nothing else hides a noindex post: RSS, archives and site search keep it.
//
// The SEO title and description are soft-limited in the admin (60 and 160
// characters, never blocking); the API caps them at 255 and 500.
package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// socialVariantName is the media variant used for og:image / twitter:image.
const socialVariantName = "social"

// UpdatePostSEORequest is the body of PUT /posts/:id/seo. Every field is
// replaced: an absent one is cleared ("" / null / false).
type UpdatePostSEORequest struct {
	SEOTitle       string `json:"seo_title" binding:"max=255,single_line"`
	SEODescription string `json:"seo_description" binding:"max=500"`
	// SocialImageID is an image in the media library; null uses the featured image.
	SocialImageID *int64 `json:"social_image_id" binding:"omitempty,min=1"`
	Noindex       bool   `json:"noindex"`
	CanonicalURL  string `json:"canonical_url" binding:"max=2048"`
}

// PostSEOResponse is a post's SEO settings as the admin edits them.
type PostSEOResponse struct {
	SEOTitle       string `json:"seo_title"`
	SEODescription string `json:"seo_description"`
	SocialImageID  *int64 `json:"social_image_id"`
	Noindex        bool   `json:"noindex"`
	CanonicalURL   string `json:"canonical_url"`
}

func toPostSEOResponse(post db.Post) *PostSEOResponse {
	resp := &PostSEOResponse{
		SEOTitle:       post.SeoTitle,
		SEODescription: post.SeoDescription,
		Noindex:        post.Noindex,
		CanonicalURL:   post.CanonicalUrl,
	}
	if post.SocialImageID.Valid {
		id := post.SocialImageID.Int64
		resp.SocialImageID = &id
	}
	return resp
}

var errInvalidCanonicalURL = errors.New("canonical_url must be an absolute http:// or https:// URL without spaces")

// validCanonicalURL checks a canonical URL (#357, decision 5): empty (the post's
// own address), or an absolute http(s) URL with a host, no spaces and no
// user:password part.
func validCanonicalURL(raw string) error {
	if raw == "" {
		return nil
	}
	if strings.IndexFunc(raw, unicode.IsSpace) >= 0 || strings.ContainsAny(raw, "\\") {
		return errInvalidCanonicalURL
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" {
		return errInvalidCanonicalURL
	}
	if scheme := strings.ToLower(parsed.Scheme); scheme != "http" && scheme != "https" {
		return errInvalidCanonicalURL
	}
	if parsed.Hostname() == "" {
		return errInvalidCanonicalURL
	}
	return nil
}

// updatePostSEO handles PUT /posts/:id/seo.
func (server *Server) updatePostSEO(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	var req UpdatePostSEORequest
	if !bindJSON(c, &req) {
		return
	}
	// Not while the post is in the trash (#327).
	if !server.authorizeWritePost(c, id) {
		return
	}
	params := db.UpdatePostSEOParams{
		ID:             id,
		SeoTitle:       strings.TrimSpace(req.SEOTitle),
		SeoDescription: strings.TrimSpace(req.SEODescription),
		Noindex:        req.Noindex,
		CanonicalUrl:   strings.TrimSpace(req.CanonicalURL),
	}
	if err := validCanonicalURL(params.CanonicalUrl); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "fields": gin.H{"canonical_url": err.Error()}})
		return
	}

	ctx := c.Request.Context()
	if req.SocialImageID != nil {
		media, err := server.store.GetMedia(ctx, *req.SocialImageID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusBadRequest, gin.H{"error": "social image not found", "fields": gin.H{"social_image_id": "not found"}})
			return
		case err != nil:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get social image"})
			return
		case !strings.HasPrefix(media.MimeType, "image/"):
			c.JSON(http.StatusBadRequest, gin.H{"error": "social image must be an image", "fields": gin.H{"social_image_id": "must be an image"}})
			return
		}
		params.SocialImageID = sql.NullInt64{Int64: media.ID, Valid: true}
	}

	post, err := server.store.UpdatePostSEO(ctx, params)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update SEO settings"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(post)})
}

// publicPostSEO is a published post's SEO as the public site uses it. An empty
// title or description means "use the post's own" (the site builds those
// fallbacks: the excerpt, then the first paragraph).
type publicPostSEO struct {
	Title        string             `json:"title"`
	Description  string             `json:"description"`
	Noindex      bool               `json:"noindex"`
	CanonicalURL string             `json:"canonical_url"`
	Image        *publicSocialImage `json:"image"`
}

// publicSocialImage is the image shared links show: the URL path under /uploads,
// its size (0 when unknown) and alt text.
type publicSocialImage struct {
	URL    string `json:"url"`
	Width  int32  `json:"width"`
	Height int32  `json:"height"`
	Alt    string `json:"alt"`
}

// publicSEO builds the published SEO of a post from its snapshot (nil: a post
// published without one, which has none). The image is the social image, else
// the featured image; a media row deleted since is skipped. A legacy featured
// image with no media id keeps its URL, without a size.
func (server *Server) publicSEO(ctx context.Context, settings *PostSettings) (publicPostSEO, error) {
	var seo publicPostSEO
	if settings == nil {
		return seo, nil
	}
	seo = publicPostSEO{
		Title:        settings.SEOTitle,
		Description:  settings.SEODescription,
		Noindex:      settings.Noindex,
		CanonicalURL: settings.CanonicalURL,
	}

	var ids []int64
	if settings.SocialImageID != nil {
		ids = append(ids, *settings.SocialImageID)
	}
	featured := settings.FeaturedImage
	if featured != nil && featured.ID != nil {
		ids = append(ids, *featured.ID)
	}
	if len(ids) > 0 {
		rows, err := server.store.GetMediaByIDs(ctx, ids)
		if err != nil {
			return seo, err
		}
		byID := make(map[int64]db.Medium, len(rows))
		for _, row := range rows {
			byID[row.ID] = row
		}
		for _, id := range ids {
			if media, ok := byID[id]; ok && strings.HasPrefix(media.MimeType, "image/") {
				seo.Image = server.socialImage(media)
				return seo, nil
			}
		}
	}
	if featured != nil && featured.ID == nil && featured.URL != "" {
		seo.Image = &publicSocialImage{URL: publicMediaPath(server.config.UploadPath, featured.URL)}
	}
	return seo, nil
}

// socialImage is the media's social crop when it has one, else the original.
func (server *Server) socialImage(media db.Medium) *publicSocialImage {
	image := &publicSocialImage{
		URL:    publicMediaPath(server.config.UploadPath, media.MediaPath),
		Width:  media.Width,
		Height: media.Height,
		Alt:    media.Alt,
	}
	if media.Decorative {
		image.Alt = ""
	}
	if variant, ok := parseMediaVariants(media.Variants)[socialVariantName]; ok && variant.Path != "" {
		image.URL = publicMediaPath(server.config.UploadPath, variant.Path)
		image.Width, image.Height = variant.Width, variant.Height
	}
	return image
}

// publishedNoindex reports whether a post's published settings hide it from
// search engines.
func publishedNoindex(settings *PostSettings) bool {
	return settings != nil && settings.Noindex
}
