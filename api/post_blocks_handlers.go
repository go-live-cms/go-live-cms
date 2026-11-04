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
// written to block_doc: by the collab server's PUT /internal/posts/:id/collab,
// or as a new post's initial body (POST /posts). It modifies doc in place; an error means
// the document must be refused (400). themeBlocks is the installed theme blocks'
// manifest (theme_blocks.go, #376).
func (doc *BlockDocV1) prepareForStore(themeBlocks ThemeBlockManifest) error {
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

	// Installed theme blocks (#376): undeclared attrs stripped, invalid values refused.
	if err := doc.applyThemeBlocks(themeBlocks); err != nil {
		return err
	}

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

// contentMediaUses lists the document's image blocks with a mediaId, in
// document order, for the post_media sync (#176): each block is one use, so a
// media shown twice gives two.
func (doc *BlockDocV1) contentMediaUses() []db.ContentMediaUse {
	uses := make([]db.ContentMediaUse, 0)

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
		if mediaID > 0 {
			uses = append(uses, db.ContentMediaUse{MediaID: mediaID, BlockID: blockID, BlockType: blockType})
		}
	}

	return uses
}

// publishedContentMedia gives PublishPostTx the image blocks of the published
// body, in document order. A body that doesn't parse as a block doc has no
// content images.
func publishedContentMedia(blockDoc json.RawMessage) []db.ContentMediaUse {
	var doc BlockDocV1
	if err := json.Unmarshal(blockDoc, &doc); err != nil {
		return nil
	}
	return doc.contentMediaUses()
}

// BlockDocResponse wraps the block document for API responses
type BlockDocResponse struct {
	Doc BlockDocV1 `json:"doc"`
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
	// CancelledScheduledUpdate: this Update superseded a pending scheduled update
	// (#335); omitted when there was none.
	CancelledScheduledUpdate bool `json:"cancelled_scheduled_update,omitempty"`
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

// getPostBlocks handles GET /posts/:id/blocks - get working copy (canReadPost)
func (server *Server) getPostBlocks(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	if !server.authorizePost(c, postID, canReadPost) {
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

	// The working copy's revision (block_revision)
	c.Header("ETag", fmt.Sprintf(`W/"%d"`, result.Revision))
	c.Header("X-Revision", fmt.Sprintf("%d", result.Revision))

	c.JSON(http.StatusOK, BlockDocResponse{Doc: blockDoc})
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

	// Flush, then PublishPostTx (posts_trash.go, shared with the bulk publish):
	// 503 if the collab server can't save, 409 for a post in the trash (#327).
	version, failure := server.publishPostByID(c, postID, userID, stringToNullString(req.Label), stringToNullString(req.Message))
	if failure != nil {
		failure.write(c)
		return
	}

	// publishPostByID recorded the "published" event (#324), for the bulk publish too.
	c.JSON(http.StatusOK, PublishResponse{
		VersionID:                version.VersionID,
		VersionNo:                version.VersionNo,
		CancelledScheduledUpdate: version.CancelledScheduledUpdate,
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
