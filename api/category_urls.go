package api

// Post URLs (#331): the web's postPath rule (web/src/lib/seo.ts), for menus and the
// automatic redirects. Structures (settings.post_url_structure):
//   - id:       /{type}/{id}
//   - slug:     /{type}/{slug}; the id for a post without one or with an all-digit
//     slug (the router would read it as an id)
//   - category: /{category-slug}/{slug} for posts of type "post" (their one category,
//     #331), the slug form for every other type and for a post without a category
//     or slug.

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	urlStructureID       = "id"
	urlStructureSlug     = "slug"
	urlStructureCategory = "category"
)

// postPathSegments are a post's two path segments, unescaped.
func postPathSegments(postType, slug string, id int64, structure, categorySlug string) (string, string) {
	useSlug := (structure == urlStructureSlug || structure == urlStructureCategory) && slug != "" && !allDigits(slug)
	if structure == urlStructureCategory && postType == "post" && categorySlug != "" && useSlug {
		return categorySlug, slug
	}
	if useSlug {
		return postType, slug
	}
	return postType, strconv.FormatInt(id, 10)
}

// postHref is a post's public path for a link (segments escaped).
func postHref(postType, slug string, id int64, structure, categorySlug string) string {
	first, second := postPathSegments(postType, slug, id, structure, categorySlug)
	return "/" + url.PathEscape(first) + "/" + url.PathEscape(second)
}

// postSitePath is the same path as a redirect stores it (unescaped, redirects.go).
func postSitePath(postType, slug string, id int64, structure, categorySlug string) string {
	first, second := postPathSegments(postType, slug, id, structure, categorySlug)
	return "/" + first + "/" + second
}

// termSitePath is a term archive's path (#348) as a redirect stores it.
func termSitePath(taxonomy, slug string) string {
	return "/" + taxonomy + "/" + slug
}

// postSlugRedirect is the redirect a slug change of a published post needs: its old
// public URL to the new one, under the site's URL structure. nil when the URL doesn't
// change (URLs by id) or the post has no public page before or after the update
// (newStatus: the status the same request sets; a post unpublished with its rename
// leaves both URLs 404).
func (server *Server) postSlugRedirect(ctx context.Context, post db.Post, newStatus, newSlug string, createdBy int64) (*db.AddRedirectParams, error) {
	if post.PostStatus != publishedStatus || !strings.EqualFold(newStatus, publishedStatus) || post.Slug == newSlug {
		return nil, nil
	}
	settings, err := server.store.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	structure := settings.PostUrlStructure
	categorySlug := ""
	if structure == urlStructureCategory && post.PostType == "post" {
		if categorySlug, err = server.store.GetPostCategorySlug(ctx, db.GetPostCategorySlugParams{PostID: post.ID, Published: true}); err != nil {
			return nil, err
		}
	}
	from := postSitePath(post.PostType, post.Slug, post.ID, structure, categorySlug)
	to := postSitePath(post.PostType, newSlug, post.ID, structure, categorySlug)
	if from == to {
		return nil, nil
	}
	return &db.AddRedirectParams{FromPath: from, ToPath: to, StatusCode: 301, Source: db.RedirectSourcePost, CreatedBy: createdBy}, nil
}

// checkOneCategory refuses (400 one_category) a term list with more than one category:
// a post has one (#331). A list without one is fine: posts get the default.
func (server *Server) checkOneCategory(c *gin.Context, termIDs []int64) bool {
	if len(termIDs) < 2 {
		return true
	}
	count, err := server.store.CountCategoryTerms(c.Request.Context(), termIDs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check categories"})
		return false
	}
	if count > 1 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  "a post has one category",
			"code":   "one_category",
			"fields": gin.H{"taxonomy_ids": "can include one category"},
		})
		return false
	}
	return true
}
