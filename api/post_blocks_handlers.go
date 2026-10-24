package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/sqlc-dev/pqtype"
)

// BlockDocV1 represents Block Spec v1 document structure
type BlockDocV1 struct {
	DocVersion  int                    `json:"doc_version" binding:"required"`
	BlocksOrder []string               `json:"blocks_order" binding:"required"`
	Blocks      map[string]interface{} `json:"blocks" binding:"required"`
}

// parseStoredBlockDoc decodes a block doc read from the database for a response.
// Posts that never had blocks store `{}` (most seeded posts, posts created without a
// body), which decodes to doc_version 0 and null blocks_order/blocks. Clients read
// `doc.blocks_order.length`, so return a well-formed empty Block Spec v1 doc instead
// (#304).
func parseStoredBlockDoc(raw json.RawMessage) (BlockDocV1, error) {
	var doc BlockDocV1
	if err := json.Unmarshal(raw, &doc); err != nil {
		return doc, err
	}
	if doc.DocVersion == 0 && len(doc.BlocksOrder) == 0 && len(doc.Blocks) == 0 {
		doc.DocVersion = 1
	}
	if doc.BlocksOrder == nil {
		doc.BlocksOrder = []string{}
	}
	if doc.Blocks == nil {
		doc.Blocks = map[string]interface{}{}
	}
	return doc, nil
}

// deduplicateBlocksOrder removes duplicate block IDs while preserving order
func (doc *BlockDocV1) deduplicateBlocksOrder() {
	seen := make(map[string]bool)
	unique := make([]string, 0, len(doc.BlocksOrder))

	for _, id := range doc.BlocksOrder {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}

	doc.BlocksOrder = unique
}

// prepareForStore checks and normalizes a block document before it is
// written to block_doc, by PUT /posts/:id/blocks or the collab server's
// PUT /internal/posts/:id/collab. It modifies doc in place; an error means
// the document must be refused (400).
func (doc *BlockDocV1) prepareForStore() error {
	// Size/depth limits before any walk over the tree (#139).
	if err := doc.checkLimits(); err != nil {
		return err
	}

	// Deduplicate blocks_order to prevent duplicate rendering
	doc.deduplicateBlocksOrder()

	// Sanitize the block tree before it is persisted (stored-XSS defence, #188).
	// Neutralises dangerous link/image URL schemes, on* handler attrs, disallowed
	// node types, and unsafe highlight colors. Best-effort, never rejects the save.
	// publishPost reads this already-sanitized working copy, so it's covered too.
	doc.sanitize()

	// Validate Block Spec v1
	if doc.DocVersion != 1 {
		return fmt.Errorf("unsupported doc_version: %d", doc.DocVersion)
	}

	// Validate blocks_order integrity
	for _, blockID := range doc.BlocksOrder {
		if _, exists := doc.Blocks[blockID]; !exists {
			return fmt.Errorf("block_id %s in blocks_order not found in blocks", blockID)
		}
	}
	return nil
}

// extractMediaIDsFromBlocks extracts all mediaId values from image blocks in the document
func (doc *BlockDocV1) extractMediaIDsFromBlocks() []int64 {
	mediaIDs := make([]int64, 0)
	seen := make(map[int64]bool)

	for _, blockID := range doc.BlocksOrder {
		block, exists := doc.Blocks[blockID]
		if !exists {
			continue
		}

		// Type assert to map[string]interface{}
		blockMap, ok := block.(map[string]interface{})
		if !ok {
			continue
		}

		// Check if it's an image block
		blockType, ok := blockMap["type"].(string)
		if !ok || blockType != "image" {
			continue
		}

		// Extract attrs.mediaId
		attrs, ok := blockMap["attrs"].(map[string]interface{})
		if !ok {
			continue
		}

		mediaIDFloat, ok := attrs["mediaId"].(float64)
		if !ok {
			continue
		}

		mediaID := int64(mediaIDFloat)
		if mediaID > 0 && !seen[mediaID] {
			seen[mediaID] = true
			mediaIDs = append(mediaIDs, mediaID)
		}
	}

	return mediaIDs
}

// syncPostMediaAssociations creates/updates post_media associations for all images in the block document
// Images are assigned order values starting from 1 (order=0 is reserved for featured images)
func (server *Server) syncPostMediaAssociations(ctx *gin.Context, postID int64, doc *BlockDocV1) error {
	mediaIDs := doc.extractMediaIDsFromBlocks()

	// Delete existing content image associations (order > 0)
	// Keep featured image association (order = 0)
	existingMedia, err := server.store.GetMediaByPostWithOrder(ctx, postID)
	if err != nil {
		return fmt.Errorf("failed to get existing media: %w", err)
	}

	// Delete content associations that are no longer in the document
	for _, media := range existingMedia {
		if media.MediaOrder == 0 {
			// Skip featured image
			continue
		}

		// Check if this media ID is still in the document
		found := false
		for _, mediaID := range mediaIDs {
			if mediaID == media.ID {
				found = true
				break
			}
		}

		if !found {
			// Delete the association
			err := server.store.DeletePostMedia(ctx, db.DeletePostMediaParams{
				PostID:  postID,
				MediaID: media.ID,
			})
			if err != nil {
				return fmt.Errorf("failed to delete post_media: %w", err)
			}
		}
	}

	// Create/update associations for current media (order > 0 for content images)
	for i, mediaID := range mediaIDs {
		_, err := server.store.CreatePostMedia(ctx, db.CreatePostMediaParams{
			PostID:  postID,
			MediaID: mediaID,
			Order:   int32(i + 1), // Start from 1 (0 is reserved for featured image)
		})
		if err != nil {
			return fmt.Errorf("failed to create post_media: %w", err)
		}
	}

	return nil
}

// BlockDocResponse wraps the block document for API responses
type BlockDocResponse struct {
	Doc   BlockDocV1 `json:"doc"`
	Title *string    `json:"title,omitempty" binding:"omitempty,max=255"` // Optional title to update alongside blocks
}

// PublishRequest represents the request to publish a version
type PublishRequest struct {
	Label   *string `json:"label" binding:"omitempty,max=255"`
	Message *string `json:"message" binding:"omitempty,max=2000"`
}

// PublishResponse represents the response from publishing
type PublishResponse struct {
	VersionID int64 `json:"version_id"`
	VersionNo int32 `json:"version_no"`
}

// getAuthPayload retrieves the authenticated user payload from context
func getAuthPayload(c *gin.Context) *token.Payload {
	payload, _ := c.Get(authorizationPayloadKey)
	return payload.(*token.Payload)
}

// stringToNullString converts *string to sql.NullString
func stringToNullString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{Valid: false}
	}
	return sql.NullString{String: *s, Valid: true}
}

// getPostBlocks handles GET /posts/:id/blocks - get working copy
func (server *Server) getPostBlocks(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	result, err := server.store.GetPostBlocks(c, postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post blocks"})
		return
	}

	// Parse the JSONB content
	blockDoc, err := parseStoredBlockDoc(result.Content)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse block document"})
		return
	}

	// Set headers for optimistic concurrency
	c.Header("ETag", fmt.Sprintf(`W/"%d"`, result.Revision))
	c.Header("X-Revision", fmt.Sprintf("%d", result.Revision))

	c.JSON(http.StatusOK, BlockDocResponse{Doc: blockDoc})
}

// updatePostBlocks handles PUT /posts/:id/blocks - update working copy
func (server *Server) updatePostBlocks(c *gin.Context) {
	// Under Hocuspocus only the collab server writes block_doc (through the
	// internal PUT /internal/posts/:id/collab). A tab still running the old
	// autosave must not overwrite what it stored (#206).
	if server.config.UsesHocuspocus() {
		c.JSON(http.StatusConflict, gin.H{"error": "managed by collaboration server"})
		return
	}

	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	// Contributors get their post row loaded for the owner check; reused below.
	post, loaded, ok := server.authorizeLoadPost(c, postID, canEditPost)
	if !ok {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	// The title and post_media links are live fields: a contributor can't
	// change them once the post is published (canEditPostDetails). Moderators
	// pass without a post row.
	liveFieldsAllowed := !loaded || canEditPostDetails(caller, post)

	// Check If-Match header for optimistic concurrency
	ifMatch := c.GetHeader("If-Match")
	if ifMatch == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "If-Match header required"})
		return
	}

	expectedRevision, err := strconv.ParseInt(ifMatch, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid If-Match header"})
		return
	}

	// Parse request body
	var req BlockDocResponse
	if !bindJSON(c, &req) {
		return
	}

	if err := req.Doc.prepareForStore(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Refuse a title change the caller may not make before saving anything, so
	// the editor sees the error instead of a 200 that dropped the title. An
	// unchanged title (every autosave sends it) is fine.
	if !liveFieldsAllowed && req.Title != nil && *req.Title != "" && *req.Title != post.Title {
		c.JSON(http.StatusForbidden, gin.H{"error": "the title of a published post can only be changed by an editor"})
		return
	}

	// Marshal to JSONB
	contentBytes, err := json.Marshal(req.Doc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to marshal block document"})
		return
	}

	// Update with optimistic concurrency check
	result, err := server.store.UpdatePostBlocksIfRevisionMatches(c, db.UpdatePostBlocksIfRevisionMatchesParams{
		ID:            postID,
		BlockDoc:      contentBytes,
		BlockRevision: expectedRevision,
	})

	if err != nil {
		if err == sql.ErrNoRows {
			// Revision mismatch - return 412 Precondition Failed
			c.JSON(http.StatusPreconditionFailed, gin.H{"error": "revision mismatch"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post blocks"})
		return
	}

	// Update title if provided (refused above when it isn't allowed)
	if req.Title != nil && *req.Title != "" && liveFieldsAllowed {
		// Get current post to preserve other fields (contributors' is loaded)
		if !loaded {
			post, err = server.store.GetPost(c, postID)
		}
		if err == nil {
			_, err = server.store.UpdatePost(c, db.UpdatePostParams{
				ID:          postID,
				Title:       *req.Title,
				Description: post.Description,
				UserID:      post.UserID,
				Username:    post.Username,
				Url:         post.Url,
				PostType:    post.PostType,
				PostStatus:  post.PostStatus,
				PostParent:  post.PostParent,
				MenuOrder:   post.MenuOrder,
			})
			if err != nil {
				// Log error but don't fail the request - blocks were already saved
				server.requestLog(c).Warn("failed to update post title from blocks", "post_id", postID, "error", err)
			}
		}
	}

	// Parse updated content for response
	var updatedDoc BlockDocV1
	if err := json.Unmarshal(result.Content, &updatedDoc); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse updated document"})
		return
	}

	// Sync post_media associations for images in content. Skipped when the
	// caller may not change a published post's links; publishPost syncs them
	// from the published doc anyway.
	if liveFieldsAllowed {
		if err := server.syncPostMediaAssociations(c, postID, &updatedDoc); err != nil {
			// Log error but don't fail the request - blocks were already saved
			server.requestLog(c).Warn("failed to sync media associations", "post_id", postID, "error", err)
		}
	}

	// Set new revision header
	c.Header("X-Revision", fmt.Sprintf("%d", result.Revision))

	c.JSON(http.StatusOK, BlockDocResponse{Doc: updatedDoc})
}

// publishPost handles POST /posts/:id/publish - create published snapshot
func (server *Server) publishPost(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	// Get user ID from auth context
	authPayload := getAuthPayload(c)
	userID := authPayload.UserID

	// Parse request body
	// The body is optional; one that is sent must be valid.
	var req PublishRequest
	if !bindOptionalJSON(c, &req) {
		return
	}

	// Under Hocuspocus, edits reach block_doc only when the collab server
	// stores (debounced). Make it store now, or the snapshot below could miss
	// the last seconds of editing; if it can't, publish nothing (#206).
	if server.config.UsesHocuspocus() {
		if err := server.flushCollabDoc(c.Request.Context(), postID, requestIDFromContext(c)); err != nil {
			server.requestLog(c).Warn("collab flush before publish failed", "post_id", postID, "error", err)
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "the collaboration server could not save the latest edits; nothing was published, try again"})
			return
		}
	}

	// Get current working copy
	currentBlocks, err := server.store.GetPostBlocks(c, postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get current blocks"})
		return
	}

	// Get next version number
	nextVersionNo, err := server.store.GetNextVersionNoForPost(c, postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get next version number"})
		return
	}

	// Create version snapshot
	version, err := server.store.InsertPostVersion(c, db.InsertPostVersionParams{
		PostID:    postID,
		VersionNo: nextVersionNo,
		Label:     stringToNullString(req.Label),
		Message:   stringToNullString(req.Message),
		BlockDoc:  currentBlocks.Content,
		CreatedBy: sql.NullInt64{Int64: userID, Valid: true},
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create version snapshot"})
		return
	}

	// Update posts table with published version
	err = server.store.SetPublishedVersionOnPost(c, db.SetPublishedVersionOnPostParams{
		ID:                 postID,
		PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: currentBlocks.Content, Valid: true},
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to set published version"})
		return
	}

	// Sync post_media associations for images in published content
	var publishedDoc BlockDocV1
	if err := json.Unmarshal(currentBlocks.Content, &publishedDoc); err == nil {
		if err := server.syncPostMediaAssociations(c, postID, &publishedDoc); err != nil {
			// Log error but don't fail the request - version was already published
			server.requestLog(c).Warn("failed to sync media associations on publish", "post_id", postID, "error", err)
		}
	}

	// Best-effort: compact the y-websocket server's LevelDB log for this
	// document. Squash failure is non-fatal and does not affect the publish
	// response. Hocuspocus has no update log to compact.
	if !server.config.UsesHocuspocus() {
		server.triggerCollabSquash(postID, requestIDFromContext(c))
	}

	c.JSON(http.StatusOK, PublishResponse{
		VersionID: version.ID,
		VersionNo: version.VersionNo,
	})
}

// getPublicPostBlocks handles GET /public/posts/:id/blocks - get published snapshot
func (server *Server) getPublicPostBlocks(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	result, err := server.store.GetPublishedPostBlocks(c, postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get published blocks"})
		return
	}

	// Drafts (including unpublished posts) and archived posts aren't public, and
	// neither is a post marked published without a snapshot, e.g. its status set
	// through PUT /posts/:id after an unpublish cleared it (#136). Only publishPost
	// (and createPost for published posts) write the snapshot.
	if result.PostStatus != "published" || !result.Content.Valid {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}

	// Parsed once, as a map: image blocks get their variants and focal point
	// added (post_block_media.go). The shape check is what decoding into
	// BlockDocV1 used to enforce.
	var docMap map[string]interface{}
	if err := json.Unmarshal(result.Content.RawMessage, &docMap); err != nil || !isBlockDocShape(docMap) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse published document"})
		return
	}
	server.attachBlockMedia(c.Request.Context(), docMap)
	c.JSON(http.StatusOK, gin.H{"doc": docMap})
}
