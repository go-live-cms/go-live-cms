package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"

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
	if !server.requirePublicPostType(c, postType) {
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
		// The site credits the published byline (#319).
		PublishedByline: true,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts"})
		return
	}

	items := make([]PostWithMetaResponse, len(posts))
	for i, post := range posts {
		items[i] = toPublicPostWithMetaResponse(post)
	}
	c.JSON(http.StatusOK, gin.H{"posts": items, "pagination": info})
}

// publicPostView is a published post as the public site shows it (#358): the
// published title and excerpt over the post row, the published body with its
// image media, and the published featured image, terms and SEO (#357).
type publicPostView struct {
	Post          PostResponse           `json:"post"`
	FeaturedImage *publicFeaturedImage   `json:"featured_image"`
	TaxonomyTerms []TaxonomyTermResponse `json:"taxonomy_terms"`
	SEO           publicPostSEO          `json:"seo"`
}

type publicFeaturedImage struct {
	ID  *int64 `json:"id"`
	URL string `json:"url"`
}

// getPublicPost handles GET /public/posts/:id: the post page's data in one call.
// Only a published post is a page; anything else is the same 404 as a missing post.
func (server *Server) getPublicPost(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	post, err := server.store.GetPost(c.Request.Context(), id)
	server.respondPublicPost(c, post, err)
}

// getPublicPostBySlug handles GET /public/posts/slug/:slug, the same for an
// address by slug.
func (server *Server) getPublicPostBySlug(c *gin.Context) {
	slug := c.Param("slug")
	if slug == "" || len(slug) > 255 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid slug"})
		return
	}
	post, err := server.store.GetPostBySlug(c.Request.Context(), slug)
	server.respondPublicPost(c, post, err)
}

func (server *Server) respondPublicPost(c *gin.Context, post db.Post, err error) {
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	// Drafts and archived posts have no page. A post marked published without a
	// body snapshot (its status set through PUT /posts/:id) still has one, as the
	// lists, RSS and the sitemap include it: with no published_blocks, as before.
	if post.PostStatus != publishedStatus {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}

	ctx := c.Request.Context()
	view, err := server.publicPostView(ctx, post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	c.JSON(http.StatusOK, view)
}

func (server *Server) publicPostView(ctx context.Context, post db.Post) (publicPostView, error) {
	resp := toPostResponse(post)
	resp.Title, resp.Description = publicTitleAndDescription(post.Title, post.Description, post.PublishedSettings)
	// The working SEO settings wait for Update: only the published ones (below) go out.
	resp.SEO = nil
	settings, published := decodePostSettings(post.PublishedSettings)
	// So does a page's template (#336).
	resp.PageTemplate = publishedPageTemplate(settings, post.PageTemplate)
	server.attachBlockMedia(ctx, resp.PublishedBlocks)
	view := publicPostView{Post: resp, TaxonomyTerms: []TaxonomyTermResponse{}}

	if published {
		seo, err := server.publicSEO(ctx, settings)
		if err != nil {
			return view, err
		}
		view.SEO = seo
		if image := settings.FeaturedImage; image != nil && image.URL != "" {
			// Rows set before #201 may hold the filesystem path.
			view.FeaturedImage = &publicFeaturedImage{ID: image.ID, URL: publicMediaPath(server.config.UploadPath, image.URL)}
		}
		terms, err := server.store.GetPublishedPostTaxonomyTerms(ctx, post.ID)
		if err != nil {
			return view, err
		}
		for _, term := range terms {
			view.TaxonomyTerms = append(view.TaxonomyTerms, toPostTaxonomyTermResponse(db.GetPostTaxonomyTermsRow(term)))
		}
		return view, nil
	}

	// No published settings: a post published some other way keeps showing its
	// live ones, as before #358.
	thumbnail, err := server.store.GetPostMetaByKey(ctx, db.GetPostMetaByKeyParams{PostID: post.ID, MetaKey: "_thumbnail_url"})
	switch {
	case err == nil && thumbnail.MetaValue.String != "":
		view.FeaturedImage = &publicFeaturedImage{URL: publicMediaPath(server.config.UploadPath, thumbnail.MetaValue.String)}
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return view, err
	}
	terms, err := server.store.GetPostTaxonomyTerms(ctx, post.ID)
	if err != nil {
		return view, err
	}
	for _, term := range terms {
		view.TaxonomyTerms = append(view.TaxonomyTerms, toPostTaxonomyTermResponse(term))
	}
	return view, nil
}

// listPublicPosts handles GET /public/posts?type=&sort=&order=&limit=&offset=:
// a public type's published posts with their published title and excerpt
// (#358), for the feeds and short lists (RSS, sitemap, "latest posts"). The
// same sort and paging rules as GET /posts; the type must be public and active.
func (server *Server) listPublicPosts(c *gin.Context) {
	postType := c.Query("type")
	if postType == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "type is required"})
		return
	}
	sorting, err := resolvePostSort(c.Query("sort"), c.Query("order"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	limit, err := strconv.ParseInt(c.DefaultQuery("limit", "10"), 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	limit = min(limit, 100)
	offset, err := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	ctx := c.Request.Context()
	if !server.requirePublicPostType(c, postType) {
		return
	}

	total, err := server.store.CountFilteredPosts(ctx, db.CountFilteredPostsParams{
		PostType:   postType,
		PostStatus: publishedStatus,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count posts"})
		return
	}
	rows, err := server.store.ListPosts(ctx, db.ListPostsParams{
		PostType:      postType,
		PostStatus:    publishedStatus,
		SortColumn:    sorting.Column,
		SortDirection: sorting.Direction,
		OffsetCount:   int32(offset),
		LimitCount:    int32(limit),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts"})
		return
	}

	posts := make([]publicListPost, len(rows))
	for i, row := range rows {
		posts[i].PostResponse = toPostResponseFromListRow(row)
		// The feeds don't render bodies; leave the snapshot out of the response.
		posts[i].PublishedBlocks = nil
		// The working copy's state is the admin's business (#326, #335).
		posts[i].HasUnpublishedChanges = false
		posts[i].UpdateAt = nil
		posts[i].Title, posts[i].Description = publicTitleAndDescription(row.Title, row.Description, row.PublishedSettings)
		settings, _ := decodePostSettings(row.PublishedSettings)
		posts[i].Noindex = publishedNoindex(settings)
		posts[i].PageTemplate = publishedPageTemplate(settings, row.PageTemplate)
	}
	c.JSON(http.StatusOK, gin.H{
		"posts": posts,
		"meta": gin.H{
			"total":  total,
			"limit":  limit,
			"offset": offset,
			"count":  len(posts),
			"sort":   sorting.Column,
			"order":  sorting.Direction,
			"type":   postType,
		},
	})
}

// publicListPost is a /public/posts row: the post plus its published "Hide from
// search engines" (#357), which leaves it out of the sitemap (and only that).
type publicListPost struct {
	PostResponse
	Noindex bool `json:"noindex"`
}

// requirePublicPostType answers 404 (or 500) itself unless the type is
// registered, active and public; ok is false when it did.
func (server *Server) requirePublicPostType(c *gin.Context, name string) bool {
	pt, err := server.store.GetPostType(c.Request.Context(), name)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post type not found"})
			return false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post type"})
		return false
	}
	if !pt.IsActive || !pt.Public {
		c.JSON(http.StatusNotFound, gin.H{"error": "post type not found"})
		return false
	}
	return true
}
