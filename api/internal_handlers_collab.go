package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// collabStoreBodyLimit caps PUT /internal/posts/:id/collab. The body carries
// the full Yjs state (base64, so 4/3 of its size, and it keeps deleted-item
// metadata) next to the derived block_doc, which keeps its own
// blockDocBodyLimit.
const collabStoreBodyLimit int64 = 16 << 20 // 16 MiB

// postCollabResponse is GET /internal/posts/:id/collab.
type postCollabResponse struct {
	BlockDoc      json.RawMessage `json:"block_doc"`
	BlockRevision int64           `json:"block_revision"`
	// YdocState (base64 in JSON) and Epoch are omitted when there is no
	// stored state, or when it is stale (see getInternalPostCollab).
	YdocState []byte `json:"ydoc_state,omitempty"`
	Epoch     string `json:"epoch,omitempty"`
}

// storePostCollabRequest is PUT /internal/posts/:id/collab.
type storePostCollabRequest struct {
	// State is the full Yjs document (Y.encodeStateAsUpdate), base64.
	State []byte `json:"state" binding:"required"`
	// Epoch is the epoch the document was seeded under (a UUID).
	Epoch string `json:"epoch" binding:"required,max=64"`
	// BlockDoc is the Block Spec v1 doc derived from State. Omitted (or
	// null) stores State only and keeps the last block_doc: the server sends
	// that when its derived doc failed validation.
	BlockDoc *BlockDocV1 `json:"block_doc"`
	// LastEditorID is the user whose edit triggered this store (optional).
	LastEditorID *int64 `json:"last_editor_id" binding:"omitempty,min=1"`
	// BaseRevision is the block_revision the server loaded or last stored;
	// the store is refused (409) if block_doc changed since. Optional with a
	// block_doc, required without one (the state is recorded against it).
	BaseRevision *int64 `json:"base_revision" binding:"required_without=BlockDoc,omitempty,min=1"`
}

// getInternalPostCollab serves the collab server's onLoadDocument (#206 /
// #280): the post's working copy plus the Yjs state it last stored.
//
// Revision guard: the state is returned only if it was stored against the
// post's current block_revision. Otherwise something wrote block_doc around
// the collab server (a y-websocket autosave before a cutover, a rollback),
// the state no longer matches it, and the server must reseed from block_doc
// under a new epoch. Omitting it makes that the only thing the server can do.
//
// Available under either COLLAB_BACKEND (it only reads).
//
// Path parameters:
//   - id: Post's database primary key
//
// Authentication: Shared secret (requireInternalSecret), no user token.
//
// Returns:
//   - 200 OK: { "block_doc": {...}, "block_revision": 3, "ydoc_state"?: "<base64>", "epoch"?: "<uuid>" }
//   - 400 Bad Request: Invalid post ID
//   - 401 Unauthorized: Missing or wrong shared secret
//   - 404 Not Found: The post does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getInternalPostCollab(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || postID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	row, err := server.store.GetPostCollab(c.Request.Context(), postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post collab state"})
		return
	}

	resp := postCollabResponse{BlockDoc: row.BlockDoc, BlockRevision: row.BlockRevision}
	hasState := row.YdocState != nil && row.YdocEpoch.Valid && row.YdocBlockRevision.Valid
	switch {
	case hasState && row.YdocBlockRevision.Int64 == row.BlockRevision:
		resp.YdocState = row.YdocState
		resp.Epoch = row.YdocEpoch.UUID.String()
	case hasState:
		server.requestLog(c).Info("collab state is stale, server reseeds from block_doc",
			"post_id", postID, "state_block_revision", row.YdocBlockRevision.Int64, "block_revision", row.BlockRevision)
	}
	c.JSON(http.StatusOK, resp)
}

// putInternalPostCollab is the collab server's onStoreDocument (#206 /
// #280). In one transaction (StorePostCollabTx) it writes block_doc with
// block_revision+1, syncs the content media links (unpublished posts only),
// and stores the Yjs state against the new revision.
//
// block_doc gets the same structural check, sanitizing and limits as PUT
// /posts/:id/blocks (prepareForStore), on top of the server's own Zod
// validation. Only allowed under COLLAB_BACKEND=hocuspocus: under
// y-websocket the editor's REST autosave owns block_doc, and two writers
// would overwrite each other.
//
// Path parameters:
//   - id: Post's database primary key
//
// Request body: see storePostCollabRequest. At most collabStoreBodyLimit.
//
// Authentication: Shared secret (requireInternalSecret), no user token.
//
// Returns:
//   - 200 OK: { "block_revision": 4, "epoch": "<uuid>" }
//   - 400 Bad Request: Invalid ID, body, epoch or block document, or no
//     base_revision on a state-only store
//   - 401 Unauthorized: Missing or wrong shared secret
//   - 404 Not Found: The post does not exist
//   - 409 Conflict: Not under Hocuspocus, or base_revision is behind
//   - 413 Request Entity Too Large: Body or block_doc over its limit
//   - 500 Internal Server Error: Database failure
func (server *Server) putInternalPostCollab(c *gin.Context) {
	if !server.config.UsesHocuspocus() {
		c.JSON(http.StatusConflict, gin.H{"error": "COLLAB_BACKEND is not hocuspocus"})
		return
	}

	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || postID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, collabStoreBodyLimit)
	var req storePostCollabRequest
	if !bindJSON(c, &req) {
		return
	}
	if len(req.State) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "state is required", "fields": gin.H{"state": "is required"}})
		return
	}
	epoch, err := uuid.Parse(req.Epoch)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "epoch must be a UUID", "fields": gin.H{"epoch": "must be a UUID"}})
		return
	}

	arg := db.StorePostCollabTxParams{
		PostID: postID,
		State:  req.State,
		Epoch:  epoch,
	}
	if req.LastEditorID != nil {
		arg.LastEditorID = sql.NullInt64{Int64: *req.LastEditorID, Valid: true}
	}
	if req.BaseRevision != nil {
		arg.BaseRevision = sql.NullInt64{Int64: *req.BaseRevision, Valid: true}
	}
	if req.BlockDoc != nil {
		if err := req.BlockDoc.prepareForStore(); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		blockDoc, err := json.Marshal(req.BlockDoc)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to marshal block document"})
			return
		}
		// The same cap PUT /posts/:id/blocks has on its whole body.
		if int64(len(blockDoc)) > blockDocBodyLimit {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "block_doc is too large"})
			return
		}
		arg.BlockDoc = blockDoc
		arg.MediaIDs = req.BlockDoc.extractMediaIDsFromBlocks()
	}

	result, err := server.store.StorePostCollabTx(c.Request.Context(), arg)
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		case errors.Is(err, db.ErrCollabRevisionConflict):
			c.JSON(http.StatusConflict, gin.H{"error": "revision conflict"})
		case errors.Is(err, db.ErrCollabBaseRevisionRequired): // binding already refuses it
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			server.requestLog(c).Error("collab store failed", "post_id", postID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store post collab state"})
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{"block_revision": result.BlockRevision, "epoch": epoch.String()})
}
