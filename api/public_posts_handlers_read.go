package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// publishedStatus is the only status the public lists show.
const publishedStatus = "published"

// getPublicPostsByType handles GET /public/posts/type/:type?page=N (#349): one
// page of a public post type's published posts, newest first, posts_per_page
// at a time, with the total for numbered pages (pagination.go). A type that
// isn't registered, active and public is a 404, like a page past the end.
func (server *Server) getPublicPostsByType(c *gin.Context) {
	postType := c.Param("type")
	req, ok := server.publicPageRequest(c)
	if !ok {
		return
	}

	ctx := c.Request.Context()
	pt, err := server.store.GetPostType(ctx, postType)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post type"})
		return
	}
	if !pt.IsActive || !pt.Public {
		c.JSON(http.StatusNotFound, gin.H{"error": "post type not found"})
		return
	}

	// The count takes the page query's filters, so total and the rows agree.
	total, err := server.store.CountFilteredPosts(ctx, db.CountFilteredPostsParams{
		PostType:   postType,
		PostStatus: publishedStatus,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count posts"})
		return
	}
	info := newPageInfo(req, total)
	if info.outOfRange() {
		c.JSON(http.StatusNotFound, gin.H{"error": "page out of range"})
		return
	}

	posts, err := server.store.ListPostsWithMeta(ctx, db.ListPostsWithMetaParams{
		PostType:      postType,
		PostStatus:    publishedStatus,
		SortColumn:    "created_at",
		SortDirection: sortDesc,
		OffsetCount:   req.offset(),
		LimitCount:    req.PerPage,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts"})
		return
	}

	items := make([]PostWithMetaResponse, len(posts))
	for i, post := range posts {
		items[i] = toPostWithMetaResponse(post)
	}
	c.JSON(http.StatusOK, gin.H{"posts": items, "pagination": info})
}
