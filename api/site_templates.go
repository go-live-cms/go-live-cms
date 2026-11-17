package api

// Templates and parts (#490, docs/design/theme-builder.md 5.1, 5.7, 7.3): creation. After
// "Customize" or "New template" creates a row, its block_doc is written only by the collab
// server (rule 11): the template-<id> document kind, admin only.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Where a new template's working copy starts (site_templates.source).
const (
	siteTemplateFromTheme   = "theme"
	siteTemplateFromStarter = "starter"
	siteTemplateFromBlank   = "blank"
)

// CreateSiteTemplateRequest is POST /site-design/templates: "Customize" a slug of the
// active theme from its shipped default (from: theme), core's starter (from: starter), or
// nothing (from: blank). Title is optional: the shipped file's or starter's title, else
// one made from the slug.
type CreateSiteTemplateRequest struct {
	Kind  string  `json:"kind" binding:"required,oneof=template part"`
	Slug  string  `json:"slug" binding:"required,max=80"`
	Title *string `json:"title" binding:"omitempty,max=480"`
	From  string  `json:"from" binding:"required,oneof=theme starter blank"`
}

// SiteTemplateResponse is a template or part's working side: never its Yjs state.
type SiteTemplateResponse struct {
	ID            int64           `json:"id"`
	ThemeSlug     string          `json:"theme_slug"`
	Kind          string          `json:"kind"`
	Slug          string          `json:"slug"`
	Title         string          `json:"title"`
	BlockDoc      json.RawMessage `json:"block_doc,omitempty"`
	BlockRevision int64           `json:"block_revision"`
	WorkingState  string          `json:"working_state"`
	Source        string          `json:"source"`
	SourceHash    string          `json:"source_hash"`
	Published     bool            `json:"published"`
	// DocName is the collab document the Site editor connects to (POST /collab/tickets).
	DocName   string    `json:"doc_name"`
	CreatedAt time.Time `json:"created_at"`
	ChangedAt time.Time `json:"changed_at"`
}

// normalizedBlockDocJSON is a stored doc as responses give it: `{}` as a well-formed empty
// Block Spec doc (#304), anything unreadable as stored.
func normalizedBlockDocJSON(raw json.RawMessage) json.RawMessage {
	if doc, err := parseStoredBlockDoc(raw); err == nil {
		if encoded, err := json.Marshal(doc); err == nil {
			return encoded
		}
	}
	return raw
}

func toSiteTemplateResponse(row db.SiteTemplate) SiteTemplateResponse {
	blockDoc := normalizedBlockDocJSON(row.BlockDoc)
	return SiteTemplateResponse{
		ID:            row.ID,
		ThemeSlug:     row.ThemeSlug,
		Kind:          row.Kind,
		Slug:          row.Slug,
		Title:         row.Title,
		BlockDoc:      blockDoc,
		BlockRevision: row.BlockRevision,
		WorkingState:  row.WorkingState,
		Source:        row.Source,
		SourceHash:    row.SourceHash,
		Published:     row.PublishedBlockDoc.Valid,
		DocName:       siteTemplateDocName(row.ID),
		CreatedAt:     row.CreatedAt,
		ChangedAt:     row.ChangedAt,
	}
}

// siteTemplateDocName is a template's collab document name (isCollabDocName).
func siteTemplateDocName(id int64) string {
	return string(collabDocTemplate) + "-" + strconv.FormatInt(id, 10)
}

// siteTemplateTitle is the title a new row gets: the request's (trimmed, one line, at
// most 120 characters), else the source's, else one made from the slug.
func siteTemplateTitle(requested *string, fallback, slug string) (string, bool) {
	if requested != nil {
		title := strings.TrimSpace(*requested)
		if title != "" {
			if utf8.RuneCountInString(title) > sitedesign.MaxTitleRunes || strings.ContainsAny(title, "\r\n") {
				return "", false
			}
			return title, true
		}
	}
	if fallback != "" {
		return fallback, true
	}
	return humanizeTemplateName(slug), true
}

// createSiteTemplate handles POST /site-design/templates (admin, design 5.7, 7.3).
//
// The row is created for the active theme with the working copy its source gives: the
// theme's shipped default for the slug (its config's block_templates / block_parts, from
// the scan; 404 no_theme_default when it ships none), core's starter
// (sitedesign.Starter; 404 no_starter for a part other than header and footer), or an
// empty doc. A copied doc gets new block ids and goes through prepareForStoreAs with the
// kind's rules (400 template_invalid: a shipped default built for blocks this build
// doesn't have). No Yjs state is made: the collab server seeds template-<id> from
// block_doc when the editor first opens it, as for a new post (rule 11).
//
// Returns 201 with the row; 400 invalid_slug / invalid_title; 409 template_exists (with
// its id) when the theme already has that kind and slug; 404 when there is no active
// theme. Activity: site_template_created {kind, slug, source}.
func (server *Server) createSiteTemplate(c *gin.Context) {
	var req CreateSiteTemplateRequest
	if !bindJSON(c, &req) {
		return
	}
	if !sitedesign.SlugPattern.MatchString(req.Slug) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  "slug must be lowercase letters, digits, - and _ (at most 80), starting with a letter or digit",
			"code":   "invalid_slug",
			"fields": gin.H{"slug": "is not a template slug"},
		})
		return
	}

	theme, err := server.store.GetActiveTheme(c)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active theme found"})
			return
		}
		server.requestLog(c).Error("site_template_create_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get active theme"})
		return
	}

	var (
		doc        json.RawMessage
		sourceHash string
		baseTitle  string
	)
	switch req.From {
	case siteTemplateFromTheme:
		shipped, ok := themeBlockTemplateFromConfig(theme.Config, req.Kind, req.Slug)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "the active theme ships no block " + req.Kind + " for this slug", "code": "no_theme_default"})
			return
		}
		doc, sourceHash, baseTitle = shipped.Doc, shipped.Hash, shipped.Title
	case siteTemplateFromStarter:
		starter, ok := sitedesign.Starter(req.Kind, req.Slug)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "there is no starter for this " + req.Kind, "code": "no_starter"})
			return
		}
		// Hashed as a theme default is (the doc as the store keeps it), so section 9's
		// "changed since" compares like with like whatever the source.
		normalized, err := server.normalizeSiteTemplateDoc(starter.Doc, req.Kind)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "template_invalid"})
			return
		}
		doc, sourceHash, baseTitle = starter.Doc, sitedesign.Hash(normalized), starter.Title
		if req.Kind == sitedesign.KindTemplate {
			// A starter's title names the generic layout; the slug says which route.
			baseTitle = ""
		}
	default:
		doc = json.RawMessage(`{}`)
	}

	title, ok := siteTemplateTitle(req.Title, baseTitle, req.Slug)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title must be one line of at most 120 characters", "code": "invalid_title", "fields": gin.H{"title": "is too long or not one line"}})
		return
	}

	if req.From != siteTemplateFromBlank {
		doc, err = server.copySiteTemplateDoc(doc, req.Kind)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "template_invalid"})
			return
		}
	}

	row, err := server.store.CreateSiteTemplate(c, db.CreateSiteTemplateParams{
		ThemeSlug:  theme.Slug,
		Kind:       req.Kind,
		Slug:       req.Slug,
		Title:      title,
		BlockDoc:   doc,
		Source:     req.From,
		SourceHash: sourceHash,
		CreatedBy:  sql.NullInt64{Int64: getAuthPayload(c).UserID, Valid: true},
	})
	if err != nil {
		if db.IsUniqueViolation(err) {
			existing, lookupErr := server.store.GetSiteTemplateBySlug(c, db.GetSiteTemplateBySlugParams{ThemeSlug: theme.Slug, Kind: req.Kind, Slug: req.Slug})
			body := gin.H{"error": "this theme already has a customized " + req.Kind + " for this slug", "code": "template_exists"}
			if lookupErr == nil {
				body["id"] = existing.ID
			}
			c.JSON(http.StatusConflict, body)
			return
		}
		server.requestLog(c).Error("site_template_create_failed", "theme", theme.Slug, "kind", req.Kind, "slug", req.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create template"})
		return
	}
	// "Used in" (#496): a copied default that shows media lists them from the start. The
	// collab server's first store syncs them again, so a failure here is only logged.
	if uses := publishedContentMedia(row.BlockDoc); len(uses) > 0 {
		if err := server.store.SyncSiteTemplateMedia(c, db.SiteTemplateMediaParams(row.ID, false, uses)); err != nil {
			server.requestLog(c).Warn("site_template_media_sync_failed", "template_id", row.ID, "error", err)
		}
	}

	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivitySiteTemplateCreated,
		ObjectType: db.ActivityObjectSiteDesign,
		ObjectID:   row.ID,
		Payload:    map[string]any{"kind": row.Kind, "slug": row.Slug, "source": row.Source},
	})
	c.JSON(http.StatusCreated, toSiteTemplateResponse(row))
}

// copySiteTemplateDoc gives a shipped or starter doc fresh block ids and runs the store's
// checks for its kind, returning the doc to store.
func (server *Server) copySiteTemplateDoc(raw json.RawMessage, kind string) (json.RawMessage, error) {
	renamed, err := regenerateBlockIDs(raw, uuid.NewString)
	if err != nil {
		return nil, errors.New("the template's blocks can't be copied")
	}
	encoded, err := server.normalizeSiteTemplateDoc(renamed, kind)
	if err != nil {
		return nil, err
	}
	if int64(len(encoded)) > blockDocBodyLimit {
		return nil, errors.New("the template is too large")
	}
	return encoded, nil
}

// normalizeSiteTemplateDoc runs the store's checks for kind on a doc and returns it as the
// store would keep it.
func (server *Server) normalizeSiteTemplateDoc(raw json.RawMessage, kind string) (json.RawMessage, error) {
	var doc BlockDocV1
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, errors.New("the template's blocks can't be read")
	}
	if err := doc.prepareForStoreAs(server.themeBlocks, blockDocKind(kind)); err != nil {
		return nil, err
	}
	return json.Marshal(doc)
}
