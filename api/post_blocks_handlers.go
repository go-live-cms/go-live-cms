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

// BlockDocResponse wraps the block document for API responses
type BlockDocResponse struct {
	Doc   BlockDocV1 `json:"doc"`
	Title *string    `json:"title,omitempty"` // Optional title to update alongside blocks
}

// PublishRequest represents the request to publish a version
type PublishRequest struct {
	Label   *string `json:"label"`
	Message *string `json:"message"`
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
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
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
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

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
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Deduplicate blocks_order to prevent duplicate rendering
	req.Doc.deduplicateBlocksOrder()

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

	// Update title if provided
	if req.Title != nil && *req.Title != "" {
		// Get current post to preserve other fields
		post, err := server.store.GetPost(c, postID)
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
				fmt.Printf("Warning: failed to update title: %v\n", err)
			}
		}
	}

	// Parse updated content for response
	var updatedDoc BlockDocV1
	if err := json.Unmarshal(result.Content, &updatedDoc); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse updated document"})
		return
	}

	// Set new revision header
	c.Header("X-Revision", fmt.Sprintf("%d", result.Revision))

	c.JSON(http.StatusOK, BlockDocResponse{Doc: updatedDoc})
}

// publishPost handles POST /posts/:id/publish - create published snapshot
func (server *Server) publishPost(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get user ID from auth context
	authPayload := getAuthPayload(c)
	userID := authPayload.UserID

	// Parse request body
	var req PublishRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		// Allow empty body
		req = PublishRequest{}
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

	c.JSON(http.StatusOK, PublishResponse{
		VersionID: version.ID,
		VersionNo: version.VersionNo,
	})
}

// getPublicPostBlocks handles GET /public/posts/:id/blocks - get published snapshot
func (server *Server) getPublicPostBlocks(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
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

	// Check if published content exists
	if !result.Valid {
		// Return empty Block Spec v1 document
		emptyDoc := BlockDocV1{
			DocVersion:  1,
			BlocksOrder: []string{},
			Blocks:      make(map[string]interface{}),
		}
		c.JSON(http.StatusOK, BlockDocResponse{Doc: emptyDoc})
		return
	}

	// Parse the JSONB content
	var blockDoc BlockDocV1
	if err := json.Unmarshal(result.RawMessage, &blockDoc); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse published document"})
		return
	}

	c.JSON(http.StatusOK, BlockDocResponse{Doc: blockDoc})
}
