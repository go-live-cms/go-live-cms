package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

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
	var blockDoc BlockDocV1
	if err := json.Unmarshal(result.Content, &blockDoc); err != nil {
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

	// Size/depth limits before any walk over the tree (#139).
	if err := req.Doc.checkLimits(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Deduplicate blocks_order to prevent duplicate rendering
	req.Doc.deduplicateBlocksOrder()

	// Sanitize the block tree before it is persisted (stored-XSS defence, #188).
	// Neutralises dangerous link/image URL schemes, on* handler attrs, disallowed
	// node types, and unsafe highlight colors. Best-effort, never rejects the save.
	// publishPost reads this already-sanitized working copy, so it's covered too.
	req.Doc.sanitize()

	// Validate Block Spec v1
	if req.Doc.DocVersion != 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("unsupported doc_version: %d", req.Doc.DocVersion)})
		return
	}

	// Validate blocks_order integrity
	for _, blockID := range req.Doc.BlocksOrder {
		if _, exists := req.Doc.Blocks[blockID]; !exists {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("block_id %s in blocks_order not found in blocks", blockID)})
			return
		}
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

	// Best-effort: compact the LevelDB collaboration log for this document.
	// Squash failure is non-fatal and does not affect the publish response.
	server.triggerCollabSquash(postID, requestIDFromContext(c))

	c.JSON(http.StatusOK, PublishResponse{
		VersionID: version.ID,
		VersionNo: version.VersionNo,
	})
}

// triggerCollabSquash fires a best-effort async squash request to the WebSocket
// collaboration server for the given postID. It runs in a goroutine and never
// blocks or fails the caller. Squash merges all LevelDB update entries for the
// document into a single snapshot, preventing unbounded log growth.
//
// Silently skips if CollabServerURL or CollabSquashSecret are not configured.
// requestID (the publish request's) is forwarded as X-Request-ID so the WS
// server's squash log line can be matched to it.
func (server *Server) triggerCollabSquash(postID int64, requestID string) {
	// Trim trailing slashes so URLs like "http://websocket:1234/" don't produce
	// "//_internal/..." (which the WS server's route regex would not match,
	// silently breaking squash-on-publish).
	collabURL := strings.TrimRight(server.config.CollabServerURL, "/")
	secret := server.config.CollabSquashSecret
	if collabURL == "" || secret == "" {
		return
	}

	logger := slog.Default()
	if server.logger != nil {
		logger = server.logger
	}
	go func() {
		docName := fmt.Sprintf("post-%d", postID)
		url := fmt.Sprintf("%s/_internal/documents/%s/squash", collabURL, docName)
		log := logger.With(requestIDKey, requestID, "doc", docName)

		req, err := http.NewRequest(http.MethodPost, url, nil)
		if err != nil {
			log.Warn("collab squash: failed to build request", "error", err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		if requestID != "" {
			req.Header.Set(requestIDHeader, requestID)
		}

		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Warn("collab squash: request failed", "error", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			log.Warn("collab squash: unexpected status", "status", resp.StatusCode)
			return
		}
		log.Info("collab squash complete")
	}()
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
