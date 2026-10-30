// terms_public_handlers_read serves the public term archives (#348), under /public.
//
// A term has a page, /{taxonomy}/{slug} on the site, when its taxonomy type is
// public. The page lists the published posts (of public, active post types)
// tagged with the term or, for a hierarchical taxonomy, any term below it; the
// rule lives in db/query/terms_public.sql. An unknown taxonomy, a non-public one
// and an unknown slug all get the same 404.
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const publicTermsMaxLimit = 1000

// errTermNotFound is the one body every "no page" case answers.
var errTermNotFound = gin.H{"error": "term not found"}

// PublicTermResponse is a term archive's header: the term and its taxonomy.
type PublicTermResponse struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	Slug          string `json:"slug"`
	Description   string `json:"description"`
	Taxonomy      string `json:"taxonomy"`
	TaxonomyLabel string `json:"taxonomy_label"`
	Hierarchical  bool   `json:"hierarchical"`
}

// PublicTermListEntry is one term page in the sitemap listing.
type PublicTermListEntry struct {
	Taxonomy     string    `json:"taxonomy"`
	Slug         string    `json:"slug"`
	LastModified time.Time `json:"last_modified"`
}

func toPublicTermResponse(row db.GetPublicTermRow) PublicTermResponse {
	return PublicTermResponse{
		ID:            row.ID,
		Name:          row.Name,
		Slug:          row.Slug,
		Description:   row.Description.String,
		Taxonomy:      row.TaxonomyName,
		TaxonomyLabel: row.TaxonomyLabel,
		Hierarchical:  row.Hierarchical,
	}
}

// listPublicTermPosts handles GET /public/taxonomies/:taxonomy/terms/:slug/posts?page=N:
// {"term": PublicTermResponse, "posts": [...], "pagination": {...}}. One page of
// the term's published posts, newest first, posts_per_page at a time
// (pagination.go), rows in the shape of GET /posts?with_meta=true. Page 1 of a
// term with no posts is an empty list; a page past the end is a 404.
func (server *Server) listPublicTermPosts(c *gin.Context) {
	req, ok := server.publicPageRequest(c)
	if !ok {
		return
	}

	ctx := c.Request.Context()
	term, err := server.store.GetPublicTerm(ctx, db.GetPublicTermParams{
		Taxonomy: c.Param("taxonomy"),
		Slug:     c.Param("slug"),
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, errTermNotFound)
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get term"})
		return
	}

	// The count takes the page query's filters, so total and the rows agree.
	total, err := server.store.CountPublishedPostsByTerm(ctx, term.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count posts"})
		return
	}
	info := newPageInfo(req, total)
	if info.outOfRange() {
		c.JSON(http.StatusNotFound, gin.H{"error": "page out of range"})
		return
	}

	rows, err := server.store.ListPublishedPostsByTerm(ctx, db.ListPublishedPostsByTermParams{
		TermID:      term.ID,
		LimitCount:  req.PerPage,
		OffsetCount: req.offset(),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts"})
		return
	}

	posts := make([]PostWithMetaResponse, len(rows))
	for i, row := range rows {
		// Same columns as ListPostsWithMeta, so the row converts directly.
		posts[i] = toPostWithMetaResponse(db.ListPostsWithMetaRow(row))
	}
	c.JSON(http.StatusOK, gin.H{
		"term":       toPublicTermResponse(term),
		"posts":      posts,
		"pagination": info,
	})
}

// listPublicTerms handles GET /public/terms?limit=&offset=: every term page with
// a post and that post's newest change, for the sitemap.
func (server *Server) listPublicTerms(c *gin.Context) {
	limit, offset, ok := parseLimitOffset(c, publicTermsMaxLimit, publicTermsMaxLimit)
	if !ok {
		return
	}
	rows, err := server.store.ListPublicTerms(c.Request.Context(), db.ListPublicTermsParams{
		LimitCount:  int32(limit),
		OffsetCount: int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list terms"})
		return
	}
	terms := make([]PublicTermListEntry, len(rows))
	for i, row := range rows {
		terms[i] = PublicTermListEntry{
			Taxonomy:     row.TaxonomyName,
			Slug:         row.Slug,
			LastModified: row.LastModified,
		}
	}
	c.JSON(http.StatusOK, gin.H{"terms": terms})
}
