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

// siteTemplateCollabResponse is GET /internal/site-templates/:id/collab: the #280
// contract (postCollabResponse) plus `doc_kind`, the template's kind ("template" or
// "part"), so the collab server validates each store with that kind's rules
// (validateBlockDoc(doc, { kind }), design 4.2 and 7.2).
type siteTemplateCollabResponse struct {
	DocKind       string          `json:"doc_kind"`
	BlockDoc      json.RawMessage `json:"block_doc"`
	BlockRevision int64           `json:"block_revision"`
	YdocState     []byte          `json:"ydoc_state,omitempty"`
	Epoch         string          `json:"epoch,omitempty"`
}

// storeSiteTemplateCollabRequest is PUT /internal/site-templates/:id/collab: the
// post's request without block_edits (a template has no per-block attribution, design
// 7.2: the block change tracker is off for templates in v1).
type storeSiteTemplateCollabRequest struct {
	State        []byte      `json:"state" binding:"required"`
	Epoch        string      `json:"epoch" binding:"required,max=64"`
	BlockDoc     *BlockDocV1 `json:"block_doc"`
	LastEditorID *int64      `json:"last_editor_id" binding:"omitempty,min=1"`
	BaseRevision *int64      `json:"base_revision" binding:"required_without=BlockDoc,omitempty,min=1"`
}

func siteTemplateIDParam(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid template ID"})
		return 0, false
	}
	return id, true
}

// getInternalSiteTemplateCollab serves the collab server's onLoadDocument for
// template-<id> (#490): the working copy plus the Yjs state it last stored, with the
// same revision guard as getInternalPostCollab (rule 12): the state is returned only if
// it was stored against the template's current block_revision; otherwise something
// wrote block_doc around the collab server and it must reseed under a new epoch.
//
// Path parameters:
//   - id: The template's (or part's) site_templates id
//
// Authentication: Shared secret (requireInternalSecret), no user token.
//
// Returns:
//   - 200 OK: { "doc_kind": "template"|"part", "block_doc": {...}, "block_revision": 3, "ydoc_state"?: "<base64>", "epoch"?: "<uuid>" }
//   - 400 Bad Request: Invalid ID
//   - 401 Unauthorized: Missing or wrong shared secret
//   - 404 Not Found: The template does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getInternalSiteTemplateCollab(c *gin.Context) {
	id, ok := siteTemplateIDParam(c)
	if !ok {
		return
	}
	row, err := server.store.GetSiteTemplateCollab(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get template collab state"})
		return
	}

	resp := siteTemplateCollabResponse{DocKind: row.Kind, BlockDoc: row.BlockDoc, BlockRevision: row.BlockRevision}
	hasState := row.YdocState != nil && row.YdocEpoch.Valid && row.YdocBlockRevision.Valid
	switch {
	case hasState && row.YdocBlockRevision.Int64 == row.BlockRevision:
		resp.YdocState = row.YdocState
		resp.Epoch = row.YdocEpoch.UUID.String()
	case hasState:
		server.requestLog(c).Info("collab state is stale, server reseeds from block_doc",
			"template_id", id, "state_block_revision", row.YdocBlockRevision.Int64, "block_revision", row.BlockRevision)
	}
	c.JSON(http.StatusOK, resp)
}

// putInternalSiteTemplateCollab is the collab server's onStoreDocument for
// template-<id> (#490): StoreSiteTemplateCollabTx writes block_doc with
// block_revision+1 and stores the Yjs state against the new revision, in one
// transaction. block_doc gets prepareForStoreAs with the row's kind (the sanitizer,
// limits, nesting and theme block checks of prepareForStore, plus where site blocks
// may sit: no template_part in a part), on top of the collab server's own validation
// with the same rules. This is the only writer of an existing template's block_doc.
//
// Path parameters:
//   - id: The template's (or part's) site_templates id
//
// Request body: see storeSiteTemplateCollabRequest. At most collabStoreBodyLimit.
//
// Authentication: Shared secret (requireInternalSecret), no user token.
//
// Returns:
//   - 200 OK: { "block_revision": 4, "epoch": "<uuid>" }
//   - 400 Bad Request: Invalid ID, body, epoch or block document (for its kind), or no
//     base_revision on a state-only store
//   - 401 Unauthorized: Missing or wrong shared secret
//   - 404 Not Found: The template does not exist
//   - 409 Conflict: base_revision is behind
//   - 413 Request Entity Too Large: Body or block_doc over its limit
//   - 500 Internal Server Error: Database failure
func (server *Server) putInternalSiteTemplateCollab(c *gin.Context) {
	id, ok := siteTemplateIDParam(c)
	if !ok {
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, collabStoreBodyLimit)
	var req storeSiteTemplateCollabRequest
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

	arg := db.StoreSiteTemplateCollabTxParams{TemplateID: id, State: req.State, Epoch: epoch}
	if req.LastEditorID != nil {
		arg.LastEditorID = sql.NullInt64{Int64: *req.LastEditorID, Valid: true}
		arg.EditActivityWindow = server.activityEditWindow
	}
	if req.BaseRevision != nil {
		arg.BaseRevision = sql.NullInt64{Int64: *req.BaseRevision, Valid: true}
	}
	if req.BlockDoc != nil {
		// The kind decides the rules (a part may not hold a template_part). It can't
		// change after creation, so reading it before the transaction is safe.
		template, err := server.store.GetSiteTemplate(c.Request.Context(), id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get template"})
			return
		}
		if err := req.BlockDoc.prepareForStoreAs(server.themeBlocks, blockDocKind(template.Kind)); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		blockDoc, err := json.Marshal(req.BlockDoc)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to marshal block document"})
			return
		}
		if int64(len(blockDoc)) > blockDocBodyLimit {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "block_doc is too large"})
			return
		}
		arg.BlockDoc = blockDoc
		// "Used in" (#496): the working copy's media blocks, synced in the transaction.
		if uses := req.BlockDoc.contentMediaUses(); len(uses) > 0 {
			arg.ContentMedia = uses
		}
	}

	result, err := server.store.StoreSiteTemplateCollabTx(c.Request.Context(), arg)
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
		case errors.Is(err, db.ErrCollabRevisionConflict):
			c.JSON(http.StatusConflict, gin.H{"error": "revision conflict"})
		case errors.Is(err, db.ErrCollabBaseRevisionRequired): // binding already refuses it
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			server.requestLog(c).Error("collab store failed", "template_id", id, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store template collab state"})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"block_revision": result.BlockRevision, "epoch": epoch.String()})
}
