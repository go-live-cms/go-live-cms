// media_captions.go holds a video's captions (#507, WCAG 1.2.2, split out of #481).
//
// A video block stores only its media id, so captions belong to the media item, not the
// block: media.captions_media_id (000059) is the WebVTT file, itself a text/vtt media item,
// and media.captions_lang its language. Replacing either file, or changing which file
// captions the video, reaches every post without republishing.
//
//   - Upload: ".vtt" is in allowedMediaTypes, checked by content (isWebVTT).
//   - Serving: /uploads answers a .vtt as text/vtt; charset=utf-8 (the mime type registered in init),
//     with the global nosniff, so a caption file is never read as HTML.
//   - PUT /media/:id {captions_media_id, captions_lang}: only on a video, only a text/vtt
//     item (captionsUpdateFor). Without a language, the site language is stored.
//   - The public block media (post_block_media.go) gives a video entry
//     `captions: {url, lang, label}`; the renderer adds <track kind="captions">.
//   - "Used in" for a captions file lists the posts whose video blocks show a video it
//     captions (captionsUsages), so deleting it warns.
//   - Deleting the captions file clears captions_media_id (ON DELETE SET NULL); deleting the
//     video leaves the captions file in the library.
//
// Cache (#185): every write above is PUT, replace or DELETE /media/:id, which purge the
// public cache (publicCachePurgeRoutes), so the cached block media follow.
package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// captionsMimeType is the stored type of a WebVTT file, and what /uploads serves it as.
const captionsMimeType = "text/vtt"

// captionsServedType is the Content-Type of a .vtt under /uploads.
const captionsServedType = "text/vtt; charset=utf-8"

// webVTTBOM is the UTF-8 byte order mark a WebVTT file may start with.
const webVTTBOM = "\xEF\xBB\xBF"

// isWebVTT matches a WebVTT file: "WEBVTT" (after an optional BOM) followed by a space, a
// tab or a line break, as the WebVTT parser requires, and text throughout what was read.
// Anything that sniffs as HTML (or any other non-text type) is refused, so a file renamed
// to .vtt can't be stored as captions.
func isWebVTT(head []byte) bool {
	rest := bytes.TrimPrefix(head, []byte(webVTTBOM))
	if !bytes.HasPrefix(rest, []byte("WEBVTT")) || len(rest) == len("WEBVTT") {
		return false
	}
	switch rest[len("WEBVTT")] {
	case ' ', '\t', '\n', '\r':
	default:
		return false
	}
	detected, _, _ := strings.Cut(http.DetectContentType(head), ";")
	return detected == "text/plain"
}

// The file server behind /uploads types files by extension (mime.TypeByExtension). Go's
// built-in table has no .vtt, and the system's may not either; sniffing would then say
// text/plain, which a <track> refuses. Registered once, so every file served by extension
// (and nothing else, a 404 included) gets it. nosniff is global (securityHeadersMiddleware).
func init() {
	if err := mime.AddExtensionType(".vtt", captionsServedType); err != nil {
		panic(err)
	}
}

// captionsLangPattern is a BCP-47 tag in the shape a <track srclang> takes ("en",
// "pt-BR", "zh-Hant-TW"), at most 35 characters (the column's CHECK).
var captionsLangPattern = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$`)

func validCaptionsLang(tag string) bool {
	return len(tag) <= 35 && captionsLangPattern.MatchString(tag)
}

var errInvalidCaptionsID = errors.New("captions_media_id must be a media id or null")

// captionsUpdate interprets captions_media_id: set reports whether the request changes the
// captions, and id is the new file (nil removes them).
func (req UpdateMediaRequest) captionsUpdate() (set bool, id *int64, err error) {
	if len(req.CaptionsMediaID) == 0 {
		return false, nil, nil
	}
	if string(req.CaptionsMediaID) == "null" {
		return true, nil, nil
	}
	var value int64
	dec := json.NewDecoder(bytes.NewReader(req.CaptionsMediaID))
	if err := dec.Decode(&value); err != nil || value <= 0 {
		return false, nil, errInvalidCaptionsID
	}
	return true, &value, nil
}

// captionsRequest is what a PUT asks of the captions, already parsed.
type captionsRequest struct {
	set  bool    // captions_media_id was in the request
	id   *int64  // the new captions file; nil removes them (with set)
	lang *string // captions_lang, trimmed and valid; nil keeps it
}

func (r captionsRequest) any() bool { return r.set || r.lang != nil }

// parseCaptionsRequest reads the captions fields of a PUT, or writes the 400.
func parseCaptionsRequest(c *gin.Context, req UpdateMediaRequest) (captionsRequest, bool) {
	set, id, err := req.captionsUpdate()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "invalid_captions"})
		return captionsRequest{}, false
	}
	out := captionsRequest{set: set, id: id}
	if req.CaptionsLang != nil {
		lang := strings.TrimSpace(*req.CaptionsLang)
		if !validCaptionsLang(lang) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "captions_lang must be a language tag such as en or pt-BR", "code": "invalid_captions_lang"})
			return captionsRequest{}, false
		}
		out.lang = &lang
	}
	return out, true
}

// applyCaptions checks a captions change against the stored rows and fills the update's
// captions params, or writes the error and returns false. The media must be a video and
// the file a text/vtt item; a language alone needs captions to apply to. Setting captions
// without a language keeps the stored one, else stores the site language; removing them
// clears it.
//
// loaded is the media row when the handler already read it (the ownership check), else nil.
func (server *Server) applyCaptions(c *gin.Context, mediaID int64, loaded *db.Medium, req captionsRequest, params *db.UpdateMediaMetadataParams) bool {
	ctx := c.Request.Context()
	var video db.Medium
	if loaded != nil {
		video = *loaded
	} else {
		row, err := server.store.GetMedia(ctx, mediaID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
				return false
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
			return false
		}
		video = row
	}
	if !strings.HasPrefix(video.MimeType, "video/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "only a video can have captions", "code": "captions_not_video"})
		return false
	}

	lang := req.lang
	switch {
	case req.set && req.id == nil:
		empty := ""
		lang = &empty
	case req.set:
		captions, err := server.store.GetMedia(ctx, *req.id)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the captions file"})
			return false
		}
		if err != nil || captions.MimeType != captionsMimeType {
			c.JSON(http.StatusBadRequest, gin.H{"error": "captions must be a WebVTT (.vtt) file in the media library", "code": "invalid_captions"})
			return false
		}
		// Replacing the file keeps its language. New captions (none before, or the old file
		// was deleted: ON DELETE SET NULL leaves captions_lang behind) get the site's.
		if lang == nil && (!video.CaptionsMediaID.Valid || video.CaptionsLang == "") {
			site := server.captionsDefaultLang(ctx)
			lang = &site
		}
	case !video.CaptionsMediaID.Valid:
		c.JSON(http.StatusBadRequest, gin.H{"error": "captions_lang needs a captions file", "code": "invalid_captions"})
		return false
	}

	params.SetCaptions = req.set
	if req.id != nil {
		params.CaptionsMediaID = sql.NullInt64{Int64: *req.id, Valid: true}
	}
	if lang != nil {
		params.CaptionsLang = sql.NullString{String: *lang, Valid: true}
	}
	return true
}

// captionsDefaultLang is the site language, the captions' language when a PUT names none,
// or en-US (the column's default) when the settings can't be read.
func (server *Server) captionsDefaultLang(ctx context.Context) string {
	settings, err := server.store.GetSettings(ctx)
	if err != nil || settings.SiteLanguage == "" {
		return "en-US"
	}
	return settings.SiteLanguage
}

// BlockCaptions is a video's captions in the public block media (#507): the WebVTT file's
// /uploads URL, its language (the track's srclang) and its label (the captions file's name,
// shown in the player's captions menu; the language when it has none).
type BlockCaptions struct {
	URL   string `json:"url"`
	Lang  string `json:"lang,omitempty"`
	Label string `json:"label"`
}

// blockCaptions builds a video's captions entry from its captions row, or nil when the
// row isn't a WebVTT file (only those are accepted, but a row may predate that).
func (server *Server) blockCaptions(video, captions db.Medium) *BlockCaptions {
	if captions.MimeType != captionsMimeType {
		return nil
	}
	label := strings.TrimSpace(captions.Name)
	if label == "" {
		label = video.CaptionsLang
	}
	return &BlockCaptions{
		URL:   publicMediaPath(server.config.UploadPath, captions.MediaPath),
		Lang:  video.CaptionsLang,
		Label: label,
	}
}

// captionsLangOf is the language a response shows: none without captions, whatever
// captions_lang still holds after the file was deleted (ON DELETE SET NULL).
func captionsLangOf(captionsID sql.NullInt64, lang string) string {
	if !captionsID.Valid {
		return ""
	}
	return lang
}

// MediaUsageCaptions (#507): the media is the captions of a video a post's video block
// shows (BlockID says which block).
const MediaUsageCaptions = "captions"

// captionsUsedIn is "Used in" for a captions file: the posts using a video it captions,
// one row per post, with a captions usage per video block (other blocks showing the video,
// such as a file block, don't render its captions). Posts the caller can't read are left
// out, as in getMediaPosts.
func captionsUsedIn(rows []db.GetPostsByCaptionsMediaRow, canRead func(db.GetPostsByCaptionsMediaRow) bool) []PostWithMediaOrderResponse {
	var out []PostWithMediaOrderResponse
	index := map[int64]int{}
	for _, row := range rows {
		if !canRead(row) {
			continue
		}
		var blocks []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		_ = json.Unmarshal(row.Blocks, &blocks)
		var usages []MediaUsage
		for _, block := range blocks {
			if block.Type == "video" {
				usages = append(usages, MediaUsage{Type: MediaUsageCaptions, BlockID: block.ID, BlockType: block.Type})
			}
		}
		if len(usages) == 0 {
			continue
		}
		if at, ok := index[row.ID]; ok {
			out[at].Usages = append(out[at].Usages, usages...)
			continue
		}
		index[row.ID] = len(out)
		link := toPostResponseFromMediaRow(db.GetPostsByMediaRow{
			ID:               row.ID,
			Title:            row.Title,
			Description:      row.Description,
			UserID:           row.UserID,
			Username:         row.Username,
			Url:              row.Url,
			PostType:         row.PostType,
			PostStatus:       row.PostStatus,
			PostParent:       row.PostParent,
			MenuOrder:        row.MenuOrder,
			CreatedAt:        row.CreatedAt,
			ChangedAt:        row.ChangedAt,
			RelationshipType: MediaUsageCaptions,
		})
		link.Usages = usages
		out = append(out, link)
	}
	return out
}
