// Package api — post templates (#322)
//
// A template is a post's content saved under a name, per post type, to start
// new posts from ("New post: Blank or from a template" on Home). Optionally it
// also keeps the post's settings: its category terms and featured image.
//
// Storage: its own table (post_templates, 000040), not posts with a template
// status, so no read of posts can show one: not the admin lists, counts or
// search, not /public, the sitemap, feeds, menus or archives, not the
// scheduler, not the collab server. A template has no live document; it is a
// snapshot of the source's working copy, read after a collab flush like
// publish and duplicate.
//
// Routes (every one needs a token):
//   - GET    /post-templates?type=     any content role (the new-post chooser)
//   - POST   /post-templates           admins and editors: {post_id, name, with_settings}
//   - PUT    /post-templates/:id       admins and editors: {name} (rename)
//   - DELETE /post-templates/:id       admins and editors
//   - POST   /post-templates/:id/posts any content role who may create a draft:
//     a new draft owned by the caller, made by newPostCopy like a duplicate
//     (#354): the template's block_doc with every block id regenerated, its
//     category and featured image. The collab server seeds the post's live doc
//     from block_doc on first open (#283); nothing else is copied.
//
// The content gets prepareForStore, the checks every new post's body gets
// (limits, sanitizer, theme blocks #376), when it is saved and again when it is
// used (the installed theme blocks may have changed in between).
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Template names: one line, 3..postTemplateNameMax characters (a post made
// from it takes the name as its title, and titles have the same minimum).
const (
	postTemplateNameMin = 3
	postTemplateNameMax = 120
)

// codeTemplateNameTaken is the 409 for a name the post type already has (the
// post_templates_type_name_key index, case-insensitive).
const codeTemplateNameTaken = "template_name_taken"

type CreatePostTemplateRequest struct {
	// PostID is the post whose working copy is saved; the template gets its type.
	PostID int64  `json:"post_id" binding:"required,min=1"`
	Name   string `json:"name" binding:"required,max=120,single_line"`
	// WithSettings also saves the post's category and featured image.
	WithSettings bool `json:"with_settings"`
}

type RenamePostTemplateRequest struct {
	Name string `json:"name" binding:"required,max=120,single_line"`
}

type PostTemplateTerm struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type PostTemplateResponse struct {
	ID       int64  `json:"id"`
	PostType string `json:"post_type"`
	Name     string `json:"name"`
	// The saved settings: the category terms, and the featured image's media id
	// (null when none was saved or the image was deleted since).
	Terms           []PostTemplateTerm `json:"terms"`
	FeaturedImageID *int64             `json:"featured_image_id"`
	// Who saved it (null and "" once that member is removed).
	CreatedByID   *int64    `json:"created_by_id"`
	CreatedByName string    `json:"created_by_name"`
	CreatedAt     time.Time `json:"created_at"`
	ChangedAt     time.Time `json:"changed_at"`
}

func toPostTemplateResponse(row db.ListPostTemplatesRow) PostTemplateResponse {
	resp := PostTemplateResponse{
		ID:            row.ID,
		PostType:      row.PostType,
		Name:          row.Name,
		Terms:         []PostTemplateTerm{},
		CreatedByName: row.CreatedByName,
		CreatedAt:     row.CreatedAt,
		ChangedAt:     row.ChangedAt,
	}
	if row.FeaturedMediaID.Valid {
		id := row.FeaturedMediaID.Int64
		resp.FeaturedImageID = &id
	}
	if row.CreatedBy.Valid {
		id := row.CreatedBy.Int64
		resp.CreatedByID = &id
	}
	if len(row.Terms) > 0 {
		// The query builds it; a malformed value would be a bug there, and the
		// terms are only a label, so it leaves them empty rather than failing.
		_ = json.Unmarshal(row.Terms, &resp.Terms)
	}
	return resp
}

// postTemplateName trims a template name and checks its length (in
// characters, like the column). ok is false after answering 400.
func postTemplateName(c *gin.Context, raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	if n := len([]rune(name)); n < postTemplateNameMin || n > postTemplateNameMax {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  "name must be 3 to 120 characters",
			"fields": gin.H{"name": "must be 3 to 120 characters"},
		})
		return "", false
	}
	return name, true
}

func templateNameTaken(c *gin.Context) {
	c.JSON(http.StatusConflict, gin.H{"error": "a template with this name already exists for this post type", "code": codeTemplateNameTaken})
}

func parseTemplateID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid template ID"})
		return 0, false
	}
	return id, true
}

// getPostTemplateRow reads one template as the list shows it.
func (server *Server) getPostTemplateRow(ctx context.Context, id int64) (db.ListPostTemplatesRow, error) {
	rows, err := server.store.ListPostTemplates(ctx, db.ListPostTemplatesParams{ID: sql.NullInt64{Int64: id, Valid: true}})
	if err != nil {
		return db.ListPostTemplatesRow{}, err
	}
	if len(rows) == 0 {
		return db.ListPostTemplatesRow{}, sql.ErrNoRows
	}
	return rows[0], nil
}

// templateSlugBase is the slug a post made from a template starts from: the
// name's, with room for generateUniqueSlug's suffix.
func templateSlugBase(name string) string {
	return strings.TrimRight(truncateRunes(normalizePostSlug(name), postSlugMax-len("-99")), "-")
}

// templatePostURL is the url of a post made from a template, the path the
// admin builds for a new post (<type>/<slug>) without an origin the API can't
// know. Nothing reads posts.url for routing; duplicates replace its slug.
func templatePostURL(postType, slug string) string {
	return "/" + postType + "/" + slug
}

// listPostTemplates handles GET /post-templates?type=.
func (server *Server) listPostTemplates(c *gin.Context) {
	postType := strings.TrimSpace(c.Query("type"))
	if len(postType) > 50 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid type"})
		return
	}
	rows, err := server.store.ListPostTemplates(c.Request.Context(), db.ListPostTemplatesParams{
		PostType: sql.NullString{String: postType, Valid: postType != ""},
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list templates"})
		return
	}
	templates := make([]PostTemplateResponse, len(rows))
	for i, row := range rows {
		templates[i] = toPostTemplateResponse(row)
	}
	c.JSON(http.StatusOK, gin.H{"templates": templates})
}

// createPostTemplate handles POST /post-templates: saves a post's working copy
// (and with with_settings its category and featured image) as a template of
// its type. Admins and editors (the route), and the caller must be able to
// read the post (they can: moderators read every post). A trashed post is
// refused (409), as for duplicate. The collab server is flushed first so the
// template has the last edits (503 if that fails). 201 {template}; 400 for
// content prepareForStore refuses; 404; 409 for a name the type already has.
func (server *Server) createPostTemplate(c *gin.Context) {
	var req CreatePostTemplateRequest
	if !bindJSON(c, &req) {
		return
	}
	name, ok := postTemplateName(c, req.Name)
	if !ok {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}

	post, err := server.store.GetPost(c.Request.Context(), req.PostID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	if !server.checkPost(c, caller, post, canReadPost) {
		return
	}
	if isTrashed(post) {
		postTrashedError().write(c)
		return
	}

	// Like duplicate: the last edits reach block_doc only when the collab
	// server stores, so make it store now and read what it stored.
	if err := server.flushCollabDoc(c.Request.Context(), post.ID, requestIDFromContext(c)); err != nil {
		server.requestLog(c).Warn("collab flush before saving a template failed", "post_id", post.ID, "error", err)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "the collaboration server could not save the latest edits; no template was saved, try again"})
		return
	}
	if post, err = server.store.GetPost(c.Request.Context(), post.ID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	// The same checks as any post body (#283, #376): a stored working copy
	// passed them once, but maybe under older rules.
	doc, err := parseStoredBlockDoc(post.BlockDoc)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "the post's content is not a valid block document"})
		return
	}
	if err := doc.prepareForStore(server.themeBlocks); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	blockDoc, err := json.Marshal(doc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to marshal block document"})
		return
	}

	template, err := server.store.CreatePostTemplateTx(c.Request.Context(), db.CreatePostTemplateTxParams{
		SourcePostID: post.ID,
		PostType:     post.PostType,
		Name:         name,
		BlockDoc:     blockDoc,
		WithSettings: req.WithSettings,
		CreatedBy:    caller.ID,
	})
	if err != nil {
		if isUniqueViolation(err) {
			templateNameTaken(c)
			return
		}
		server.requestLog(c).Warn("saving a template failed", "post_id", post.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the template"})
		return
	}
	server.respondPostTemplate(c, http.StatusCreated, template.ID)
}

// respondPostTemplate answers {template} as the list shows it.
func (server *Server) respondPostTemplate(c *gin.Context, status int, id int64) {
	row, err := server.getPostTemplateRow(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the template"})
		return
	}
	c.JSON(status, gin.H{"template": toPostTemplateResponse(row)})
}

// renamePostTemplate handles PUT /post-templates/:id {name}. 200 {template};
// 404; 409 for a name the type already has.
func (server *Server) renamePostTemplate(c *gin.Context) {
	id, ok := parseTemplateID(c)
	if !ok {
		return
	}
	var req RenamePostTemplateRequest
	if !bindJSON(c, &req) {
		return
	}
	name, ok := postTemplateName(c, req.Name)
	if !ok {
		return
	}
	if _, err := server.store.RenamePostTemplate(c.Request.Context(), db.RenamePostTemplateParams{ID: id, Name: name}); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
			return
		}
		if isUniqueViolation(err) {
			templateNameTaken(c)
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to rename the template"})
		return
	}
	server.respondPostTemplate(c, http.StatusOK, id)
}

// deletePostTemplate handles DELETE /post-templates/:id. Posts made from it
// keep their content: they never referred back to it. 204; 404.
func (server *Server) deletePostTemplate(c *gin.Context) {
	id, ok := parseTemplateID(c)
	if !ok {
		return
	}
	deleted, err := server.store.DeletePostTemplate(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete the template"})
		return
	}
	if deleted == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
		return
	}
	c.Status(http.StatusNoContent)
}

// createPostFromTemplate handles POST /post-templates/:id/posts: a new draft
// owned by the caller, titled with the template's name, of its post type, with
// its content (every block id new) and saved category and featured image. Any
// content role may (canCreatePost: a contributor's own draft). 201 {post}; 400
// for content the current checks refuse; 403; 404; 409 if a concurrent write
// took the slug or url.
func (server *Server) createPostFromTemplate(c *gin.Context) {
	id, ok := parseTemplateID(c)
	if !ok {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	if !canCreatePost(caller, []int64{caller.ID}, "draft") {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	template, err := server.store.GetPostTemplate(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the template"})
		return
	}

	params, media, err := server.newPostCopy(c.Request.Context(), copySource{
		BlockDoc: template.BlockDoc,
		PostType: template.PostType,
		SlugBase: templateSlugBase(template.Name),
		URL:      func(slug string) string { return templatePostURL(template.PostType, slug) },
		Check:    true,
	}, postCopy{Owner: caller, Title: template.Name})
	if err != nil {
		if errors.Is(err, errInvalidCopyBlockDoc) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "the template's content is no longer valid: " + err.Error()})
			return
		}
		server.requestLog(c).Warn("post from template failed", "template_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create the post"})
		return
	}

	post, err := server.store.CreatePostFromTemplateTx(c.Request.Context(), db.CreatePostFromTemplateTxParams{
		TemplateID:        template.ID,
		CreatePostsParams: params,
		ContentMedia:      media,
		PublicMediaPath: func(mediaPath string) string {
			return publicMediaPath(server.config.UploadPath, mediaPath)
		},
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows): // deleted meanwhile
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
		case isUniqueViolation(err):
			c.JSON(http.StatusConflict, gin.H{"error": uniqueViolationMessage(err)})
		default:
			server.requestLog(c).Warn("post from template failed", "template_id", id, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create the post"})
		}
		return
	}

	server.recordPostActivity(c, db.ActivityCreated, post.ID, map[string]any{"post_type": post.PostType, "template_id": template.ID})

	c.JSON(http.StatusCreated, gin.H{"post": toPostResponse(post)})
}
