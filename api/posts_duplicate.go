// Package api — duplicating a post (#354)
//
// POST /posts/:id/duplicate copies a post into a new draft owned by the
// caller. copyPost holds the copy itself, so templates (#322) can reuse it.
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

// emptyBlockDoc is a new post's body when it has none (createPost's default).
var emptyBlockDoc = json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)

// postCopy is what copyPost needs besides the source: who owns the copy, and
// the copy's title and parent. The caller decides them (and the permissions).
type postCopy struct {
	Owner  db.User
	Title  string
	Parent sql.NullInt64
}

// copyPost creates a draft copy of source (see the file comment for what is
// copied) in one transaction (DuplicatePostTx).
func (server *Server) copyPost(ctx context.Context, source db.Post, opts postCopy) (db.Post, error) {
	blockDoc, err := regenerateBlockIDs(source.BlockDoc, uuid.NewString)
	if err != nil {
		return db.Post{}, fmt.Errorf("copy block_doc: %w", err)
	}
	var parsed BlockDocV1
	if err := json.Unmarshal(blockDoc, &parsed); err != nil {
		return db.Post{}, fmt.Errorf("copy block_doc: %w", err)
	}

	slug, err := server.generateUniqueSlug(ctx, copySlug(source.Slug), 0)
	if err != nil {
		return db.Post{}, err
	}
	url, err := server.generateUniqueURL(ctx, copyURL(source.Url, source.Slug, slug))
	if err != nil {
		return db.Post{}, err
	}

	return server.store.DuplicatePostTx(ctx, db.DuplicatePostTxParams{
		SourceID: source.ID,
		CreatePostsParams: db.CreatePostsParams{
			Title:       opts.Title,
			Description: source.Description,
			UserID:      opts.Owner.ID,
			Username:    opts.Owner.Username,
			Url:         url,
			PostType:    source.PostType,
			PostStatus:  "draft",
			PostParent:  opts.Parent,
			MenuOrder:   source.MenuOrder,
			Slug:        slug,
			BlockDoc:    blockDoc,
		},
		ContentMediaIDs: parsed.extractMediaIDsFromBlocks(),
	})
}

// duplicatePost handles POST /posts/:id/duplicate.
//
// Anyone who can read the post (canReadPostBlocks) and create posts may
// duplicate it: the copy is a draft they own, which canCreatePost allows a
// contributor too. The source's parent is kept only if the caller may nest
// under it (createPost's rule: canEditPost on the parent); otherwise the copy
// is top-level.
//
// Returns 201 {"post": ...}, 400 for a bad id, 403, 404 for a missing post,
// 409 if a concurrent write took the slug or url.
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
	if !ok || !server.checkPost(c, caller, source, canReadPostBlocks) {
		return
	}
	if !canCreatePost(caller, []int64{caller.ID}, "draft") {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	parent, ok := server.copyParent(c, caller, source.PostParent)
	if !ok {
		return
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

	c.JSON(http.StatusCreated, gin.H{"post": toPostResponse(post)})
}

// copyParent is the copy's parent: the source's, if the caller may nest a
// post under it. Moderators always may; a contributor only under a post they
// can edit, else the copy has no parent. ok=false means a response was
// written (the lookup failed).
func (server *Server) copyParent(c *gin.Context, caller db.User, parent sql.NullInt64) (sql.NullInt64, bool) {
	if !parent.Valid || canModeratePosts(caller) {
		return parent, true
	}
	post, err := server.store.GetPost(c.Request.Context(), parent.Int64)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return sql.NullInt64{}, true
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get parent post"})
		return sql.NullInt64{}, false
	}
	if !canEditPost(caller, post) {
		return sql.NullInt64{}, true
	}
	return parent, true
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
// replaced by the copy's (the admin builds it as <origin>/<type>/<slug>), or
// the source's as is, which generateUniqueURL then suffixes.
func copyURL(sourceURL, sourceSlug, slug string) string {
	if sourceSlug != "" && strings.HasSuffix(sourceURL, "/"+sourceSlug) {
		return strings.TrimSuffix(sourceURL, sourceSlug) + slug
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
