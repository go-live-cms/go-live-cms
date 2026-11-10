// Package api: the markup of custom HTML blocks (#428)
//
// The block in the document holds only a snippet id; the markup is a post_html_snippets
// row written here, by admins only. An editor's or contributor's client can move or delete
// the block through the collab server but has no way to add or change markup: the
// sanitizer drops anything but the id from the block (post_blocks_sanitize.go).
//
// Reading is open to whoever may read the post: the locked preview shows editors and
// contributors the markup, already sanitized. Publish copies it into the published
// document (db.PublishPostTx), so versions and the public page never come here.
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/go-live-cms/go-live-cms/customhtml"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// SaveHTMLSnippetRequest is POST and PUT's body. A pointer so a missing html is refused
// instead of clearing the snippet; `""` clears it.
type SaveHTMLSnippetRequest struct {
	HTML *string `json:"html" binding:"required,max_bytes=102400"`
}

// HTMLSnippetResponse is a snippet as the editor reads it. HTML is the sanitized markup,
// never what was sent.
type HTMLSnippetResponse struct {
	ID   string `json:"id"`
	HTML string `json:"html"`
}

// listPostHTMLSnippets handles GET /posts/:id/html-snippets (canReadPost).
func (server *Server) listPostHTMLSnippets(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	if !server.authorizePost(c, postID, canReadPost) {
		return
	}
	rows, err := server.store.ListPostHTMLSnippets(c, postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the post's custom HTML"})
		return
	}
	snippets := make([]HTMLSnippetResponse, len(rows))
	for i, row := range rows {
		snippets[i] = HTMLSnippetResponse{ID: row.SnippetID, HTML: row.Html}
	}
	c.JSON(http.StatusOK, gin.H{"snippets": snippets})
}

// htmlSnippetWrite is what both write handlers need: the post they may write to, and the
// sanitized markup. Admins only (the route). A trashed post is refused (409), like every
// write to one.
func (server *Server) htmlSnippetWrite(c *gin.Context) (postID int64, html string, ok bool) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return 0, "", false
	}
	var req SaveHTMLSnippetRequest
	if !bindJSON(c, &req) {
		return 0, "", false
	}
	post, err := server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return 0, "", false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return 0, "", false
	}
	caller, found := server.callerUser(c)
	if !found || !server.checkPost(c, caller, post, canEditPostDetails) {
		return 0, "", false
	}
	return postID, customhtml.Sanitize(*req.HTML), true
}

// createPostHTMLSnippet handles POST /posts/:id/html-snippets {html}: the markup of a new
// block. The id is the server's, so a client can't choose one. 201 {snippet}.
func (server *Server) createPostHTMLSnippet(c *gin.Context) {
	postID, html, ok := server.htmlSnippetWrite(c)
	if !ok {
		return
	}
	row, err := server.store.CreatePostHTMLSnippet(c, db.CreatePostHTMLSnippetParams{
		PostID:    postID,
		SnippetID: uuid.NewString(),
		Html:      html,
	})
	if err != nil {
		server.requestLog(c).Warn("saving custom html failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the custom HTML"})
		return
	}
	server.recordHTMLEdited(c, postID)
	c.JSON(http.StatusCreated, gin.H{"snippet": HTMLSnippetResponse{ID: row.SnippetID, HTML: row.Html}})
}

// updatePostHTMLSnippet handles PUT /posts/:id/html-snippets/:snippet_id {html}. A
// snippet of another post is a 404, like one that doesn't exist. 200 {snippet}.
func (server *Server) updatePostHTMLSnippet(c *gin.Context) {
	postID, html, ok := server.htmlSnippetWrite(c)
	if !ok {
		return
	}
	snippetID := c.Param("snippet_id")
	if !customhtml.ValidSnippetID(snippetID) {
		c.JSON(http.StatusNotFound, gin.H{"error": "snippet not found"})
		return
	}
	row, err := server.store.UpdatePostHTMLSnippet(c, db.UpdatePostHTMLSnippetParams{
		PostID:    postID,
		SnippetID: snippetID,
		Html:      html,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "snippet not found"})
			return
		}
		server.requestLog(c).Warn("saving custom html failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the custom HTML"})
		return
	}
	server.recordHTMLEdited(c, postID)
	c.JSON(http.StatusOK, gin.H{"snippet": HTMLSnippetResponse{ID: row.SnippetID, HTML: row.Html}})
}

// recordHTMLEdited is throttled like the settings saves: the block saves as an admin types.
func (server *Server) recordHTMLEdited(c *gin.Context, postID int64) {
	server.recordRequestActivity(c, activityEvent{Verb: db.ActivityHTMLEdited, ObjectType: db.ActivityObjectPost, ObjectID: postID, Throttled: true})
}
