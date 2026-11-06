// Package api — duplicating a post (#354)
//
// POST /posts/:id/duplicate copies a post into a new draft owned by the
// caller. newPostCopy holds the copy itself (fresh block ids, unique slug and
// url); posts made from a template (#322, post_templates.go) use it too.
//
// What the copy gets
//   - title "<title> (copy)", a new unique slug and url, status draft
//   - the source's post type, parent, description, taxonomy terms and
//     featured image
//   - the source's working copy (block_doc) with every block id regenerated:
//     ids are unique per document (and will anchor comments, #192)
//   - the caller as owner and only byline (user_posts)
//
// What it doesn't: versions, comments, a schedule or publish date, other post
// meta, and the Yjs state (post_ydoc_state). The collab server seeds the
// copy's live doc from its block_doc on first open, as for any new post with
// a body (#283); Yjs bytes are never copied between posts.
package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/google/uuid"
)

// copyTitleSuffix is appended to a duplicated post's title.
const copyTitleSuffix = " (copy)"

// copySlugSuffix is appended to a duplicated post's slug before it is made
// unique (-2, -3, ...), so duplicating twice gives x-copy, x-copy-2.
const copySlugSuffix = "-copy"

// postTitleMax and postSlugMax are CreatePostRequest's limits; a copy's title
// and slug stay within them, so the copy can be saved through PUT unchanged.
const (
	postTitleMax = 255
	postSlugMax  = 255
)

// emptyBlockDoc is a new post's body when it has none (createPost, and a copy
// of a post that never had blocks).
var emptyBlockDoc = json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)

// postCopy is what copyPost needs besides the source: who owns the copy, and
// the copy's title and parent. The caller decides them (and the permissions).
type postCopy struct {
	Owner  db.User
	Title  string
	Parent sql.NullInt64
}

// copySource is what a new post is copied from: another post (duplicate,
// #354) or a template (#322).
type copySource struct {
	BlockDoc    json.RawMessage
	PostType    string
	Description string
	MenuOrder   int32
	// SlugBase is the slug the copy starts from; it is made unique (-2, -3, …).
	SlugBase string
	// URL is the copy's url (before generateUniqueURL) for its final slug.
	URL func(slug string) string
	// PageTemplate is the copy's template (#336): a duplicated page keeps its own.
	PageTemplate string
	// Check runs the regenerated block_doc through prepareForStore, the checks
	// any new post's body gets (POST /posts). A template's content is checked
	// again when it is used, since the installed theme blocks may have changed
	// since it was saved. A duplicate copies a stored working copy as it is.
	Check bool
}

// errInvalidCopyBlockDoc wraps a prepareForStore refusal of a copy's
// block_doc (copySource.Check): the caller answers 400, not 500.
var errInvalidCopyBlockDoc = errors.New("invalid block document")

// newPostCopy builds a copy's row, shared by duplicates and posts made from a
// template: the source's block_doc with every block id regenerated
// (regenerateBlockIDs), a unique slug and url, draft status, the owner, title
// and parent from opts. It also returns the copy's content media uses for the
// post_media sync. Nothing is written.
func (server *Server) newPostCopy(ctx context.Context, src copySource, opts postCopy) (db.CreatePostsParams, []db.ContentMediaUse, error) {
	blockDoc, err := regenerateBlockIDs(src.BlockDoc, uuid.NewString)
	if err != nil {
		return db.CreatePostsParams{}, nil, fmt.Errorf("copy block_doc: %w", err)
	}
	var parsed BlockDocV1
	if err := json.Unmarshal(blockDoc, &parsed); err != nil {
		return db.CreatePostsParams{}, nil, fmt.Errorf("copy block_doc: %w", err)
	}
	if src.Check {
		if err := parsed.prepareForStore(server.themeBlocks); err != nil {
			return db.CreatePostsParams{}, nil, fmt.Errorf("%w: %v", errInvalidCopyBlockDoc, err)
		}
		if blockDoc, err = json.Marshal(parsed); err != nil {
			return db.CreatePostsParams{}, nil, fmt.Errorf("copy block_doc: %w", err)
		}
	}

	slug, err := server.generateUniqueSlug(ctx, src.SlugBase, 0)
	if errors.Is(err, errSlugsExhausted) {
		// x-copy … x-copy-99 are all taken: a random suffix instead, so a post
		// copied that often (or a template used that often, #322) still copies.
		random := "-" + uuid.NewString()[:8]
		base := truncateRunes(src.SlugBase, postSlugMax-len("-99")-len(random))
		slug, err = server.generateUniqueSlug(ctx, base+random, 0)
	}
	if err != nil {
		return db.CreatePostsParams{}, nil, err
	}
	url, err := server.generateUniqueURL(ctx, src.URL(slug))
	if err != nil {
		return db.CreatePostsParams{}, nil, err
	}

	return db.CreatePostsParams{
		Title:        opts.Title,
		Description:  src.Description,
		UserID:       opts.Owner.ID,
		Username:     opts.Owner.Username,
		Url:          url,
		PostType:     src.PostType,
		PostStatus:   "draft",
		PostParent:   opts.Parent,
		MenuOrder:    src.MenuOrder,
		Slug:         slug,
		BlockDoc:     blockDoc,
		PageTemplate: src.PageTemplate,
	}, parsed.contentMediaUses(), nil
}

// copyPost creates a draft copy of source (see the file comment for what is
// copied) in one transaction (DuplicatePostTx).
func (server *Server) copyPost(ctx context.Context, source db.Post, opts postCopy) (db.Post, error) {
	params, media, err := server.newPostCopy(ctx, copySource{
		BlockDoc:     source.BlockDoc,
		PostType:     source.PostType,
		Description:  source.Description,
		MenuOrder:    source.MenuOrder,
		SlugBase:     copySlug(source.Slug),
		URL:          func(slug string) string { return copyURL(source.Url, source.Slug, slug) },
		PageTemplate: source.PageTemplate,
	}, opts)
	if err != nil {
		return db.Post{}, err
	}
	return server.store.DuplicatePostTx(ctx, db.DuplicatePostTxParams{
		SourceID:          source.ID,
		CreatePostsParams: params,
		ContentMedia:      media,
	})
}

// duplicatePost handles POST /posts/:id/duplicate.
//
// Anyone who can read the post (canReadPost) and create posts may
// duplicate it: the copy is a draft they own, which canCreatePost allows a
// contributor too. The source's parent is kept only if the caller may nest
// under it (mayNestUnder, createPost's rule); otherwise the copy is top-level.
//
// Like publish, it flushes the collab server first so the copy has the last
// edits; if that fails nothing is copied (503).
//
// Returns 201 {"post": ...}, 400 for a bad id, 403, 404 for a missing post,
// 409 if a concurrent write took the slug or url, 503 if the flush failed.
func (server *Server) duplicatePost(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	source, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	caller, ok := server.callerUser(c)
	if !ok || !server.checkPost(c, caller, source, canReadPost) {
		return
	}
	// The trash is on its way out, not a template (#327): restore it first.
	if isTrashed(source) {
		postTrashedError().write(c)
		return
	}
	if !canCreatePost(caller, []int64{caller.ID}, "draft") {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	// Edits reach block_doc only when the collab server stores (debounced), so
	// make it store now, as publish does, and copy what it stored. Otherwise the
	// copy could miss the last seconds of editing.
	if err := server.flushCollabDoc(c.Request.Context(), id, requestIDFromContext(c)); err != nil {
		server.requestLog(c).Warn("collab flush before duplicate failed", "post_id", id, "error", err)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "the collaboration server could not save the latest edits; nothing was duplicated, try again"})
		return
	}
	if source, err = server.store.GetPost(c.Request.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	parent := source.PostParent
	if parent.Valid {
		allowed, ok := server.mayNestUnder(c, caller, parent.Int64)
		if !ok {
			return
		}
		if !allowed {
			parent = sql.NullInt64{}
		}
	}

	post, err := server.copyPost(c.Request.Context(), source, postCopy{
		Owner:  caller,
		Title:  copyTitle(source.Title),
		Parent: parent,
	})
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": uniqueViolationMessage(err)})
			return
		}
		server.requestLog(c).Warn("duplicate post failed", "post_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to duplicate post"})
		return
	}

	server.recordPostActivity(c, db.ActivityCreated, post.ID, map[string]any{"post_type": post.PostType, "source_id": id})

	c.JSON(http.StatusCreated, gin.H{"post": toPostResponse(post)})
}

// copyTitle is "<title> (copy)", the title cut (by runes) so the result fits
// postTitleMax.
func copyTitle(title string) string {
	return truncateRunes(strings.TrimSpace(title), postTitleMax-len([]rune(copyTitleSuffix))) + copyTitleSuffix
}

// copySlug is the slug a copy starts from (generateUniqueSlug suffixes it).
// Room is left for that suffix, so the stored slug fits postSlugMax.
func copySlug(slug string) string {
	base := normalizePostSlug(slug)
	base = strings.TrimRight(truncateRunes(base, postSlugMax-len(copySlugSuffix)-len("-99")), "-")
	return base + copySlugSuffix
}

// copyURL is the url a copy starts from: the source's with its slug segment
// replaced by the copy's (the admin builds it as <origin>/<type>/<slug>). A
// url without a path (older and seeded posts store a bare "<slug>-<n>") or an
// empty one becomes the copy's slug. Any other url is kept, and
// generateUniqueURL suffixes it.
func copyURL(sourceURL, sourceSlug, slug string) string {
	if sourceSlug != "" && strings.HasSuffix(sourceURL, "/"+sourceSlug) {
		return strings.TrimSuffix(sourceURL, sourceSlug) + slug
	}
	if !strings.Contains(sourceURL, "/") {
		return slug
	}
	return sourceURL
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// regenerateBlockIDs returns a copy of a stored block document with every
// block id replaced by a new one from newID: the blocks map's keys, each
// block's id, blocks_order, list children, and every data-block-id inside a
// block (its pm JSON, including nested nodes). The same old id always maps to
// the same new one, so the document's references stay consistent, and no id
// of the source survives. Numbers are kept as written (json.Number). A stored
// `{}` (a post that never had blocks) becomes the empty v1 doc.
func regenerateBlockIDs(raw json.RawMessage, newID func() string) (json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc map[string]interface{}
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	if len(doc) == 0 {
		return emptyBlockDoc, nil
	}

	ids := map[string]string{}
	mapID := func(old string) string {
		if id, ok := ids[old]; ok {
			return id
		}
		id := newID()
		ids[old] = id
		return id
	}

	if order, ok := doc["blocks_order"].([]interface{}); ok {
		for i, id := range order {
			if s, ok := id.(string); ok {
				order[i] = mapID(s)
			}
		}
	}
	if blocks, ok := doc["blocks"].(map[string]interface{}); ok {
		remapped := make(map[string]interface{}, len(blocks))
		for key, block := range blocks {
			if b, ok := block.(map[string]interface{}); ok {
				if id, ok := b["id"].(string); ok {
					b["id"] = mapID(id)
				}
				if children, ok := b["children"].([]interface{}); ok {
					for i, child := range children {
						if s, ok := child.(string); ok {
							children[i] = mapID(s)
						}
					}
				}
				remapDataBlockIDs(b, mapID)
			}
			remapped[mapID(key)] = block
		}
		doc["blocks"] = remapped
	}

	return json.Marshal(doc)
}

// remapDataBlockIDs replaces every "data-block-id" string under v.
func remapDataBlockIDs(v interface{}, mapID func(string) string) {
	switch node := v.(type) {
	case map[string]interface{}:
		for key, value := range node {
			if s, ok := value.(string); ok && key == "data-block-id" {
				node[key] = mapID(s)
				continue
			}
			remapDataBlockIDs(value, mapID)
		}
	case []interface{}:
		for _, value := range node {
			remapDataBlockIDs(value, mapID)
		}
	}
}
