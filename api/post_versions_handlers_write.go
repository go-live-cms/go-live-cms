// Package api — Post publish-state write handlers: unpublish (#136)
//
// Publishing lives in post_blocks_handlers.go (publishPost). Restoring a version has
// no endpoint on purpose; see post_versions_handlers_read.go.
package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// unpublishPost handles POST /posts/:id/unpublish - back to draft, public snapshot removed.
// The working copy and the version history are untouched.
func (server *Server) unpublishPost(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	post, err := server.store.UnpublishPost(c, postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unpublish post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(post)})
}
