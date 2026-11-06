// post_block_edits serves per-block "Last edited by" (#328; design:
// docs/design/block-map-yjs-schema.md, "#328: per-block 'Last edited by'").
//
// The rows (post_block_edits, 000049) are written only by the collab server's store,
// in StorePostCollabTx with the block_doc write they describe (internal_handlers_collab.go),
// so attribution changes only when a block's content does, and no client can write it.
// The editor reads them here once it opens a post; after that, the collab server's
// `stored` message carries the rows it has just stored.
//
// The public site never sees them: there's no /public route, and this one takes a
// token, a content role and canReadPost, like the post's working copy.
//
//	GET /posts/:id/block-edits   canReadPost
package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// BlockEditResponse is one block's last edit. User is null for a member removed since.
type BlockEditResponse struct {
	User     *PostAuthorResponse `json:"user"`
	EditedAt time.Time           `json:"edited_at"`
}

// listPostBlockEdits handles GET /posts/:id/block-edits (canReadPost):
// { "<block_id>": { "user": {id, username, full_name, avatar} | null, "edited_at": "…" } }.
// A block with no row was never edited since #328 shipped (or came from a duplicate or
// a template): the editor shows no line for it.
//
// Returns 200; 400 bad id; 401; 403 when the caller may not read the post; 404.
func (server *Server) listPostBlockEdits(c *gin.Context) {
	_, post, ok := server.loadPostForAccess(c, canReadPost)
	if !ok {
		return
	}
	rows, err := server.store.ListPostBlockEdits(c.Request.Context(), post.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read block edits"})
		return
	}
	rsp := make(map[string]BlockEditResponse, len(rows))
	for _, row := range rows {
		rsp[row.BlockID] = BlockEditResponse{
			User:     commentUser(row.UserID, row.Username, row.FullName, row.AvatarUrl),
			EditedAt: row.EditedAt,
		}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, rsp)
}
