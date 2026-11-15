package api

import (
	"errors"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// The filters a block template's query loop needs (#489, docs/design/theme-builder.md 4.3), on
// GET /public/posts/type/:type beside #349's ?page=. A query block's attrs are a closed
// vocabulary that maps one to one onto these (the web's src/lib/siteQueries.ts builds the
// request), so there is no query language and no SQL from attrs: the route reads what it
// always served (published posts of a public, active type, the published settings, terms and
// byline), so drafts, trashed posts and non-public types are excluded by construction.
//
//   - per_page: 1 or more, capped at 24 (publicQueryMaxPerPage); absent = posts_per_page.
//   - order_by: date (the default, created_at) or title (the published title).
//   - order: desc (the default) or asc.
//   - terms: a comma list of at most 10 term ids; a post has one of them in its published terms.
//   - author_id: a user credited in the post's published byline.
//
// Every value is part of the cache key (#185): the key is the whole sorted query string.

const (
	publicQueryMaxPerPage = 24
	publicQueryMaxTerms   = 10
)

var (
	errInvalidPerPage  = errors.New("invalid per_page parameter")
	errInvalidOrderBy  = errors.New("invalid order_by parameter: date or title")
	errInvalidOrder    = errors.New("invalid order parameter: asc or desc")
	errInvalidTerms    = errors.New("invalid terms parameter: at most 10 term ids, comma separated")
	errInvalidAuthorID = errors.New("invalid author_id parameter")
)

// publicPostsQuery is what a /public list request asked for beyond its page.
type publicPostsQuery struct {
	// PerPage is 0 when the request didn't say: the posts_per_page setting applies.
	PerPage       int32
	SortColumn    string
	SortDirection string
	TermIDs       []int64
	AuthorID      int64
}

// parsePublicPostsQuery reads the filters; any value it doesn't know is a 400, never ignored,
// so a typo can't widen a query.
func parsePublicPostsQuery(c *gin.Context) (publicPostsQuery, error) {
	query := publicPostsQuery{SortColumn: "created_at", SortDirection: sortDesc}
	if value, ok := c.GetQuery("per_page"); ok {
		n, err := strconv.ParseInt(value, 10, 32)
		if err != nil || n < 1 {
			return query, errInvalidPerPage
		}
		query.PerPage = int32(min(n, publicQueryMaxPerPage))
	}
	switch c.Query("order_by") {
	case "", "date":
	case "title":
		query.SortColumn = "published_title"
	default:
		return query, errInvalidOrderBy
	}
	switch c.Query("order") {
	case "", sortDesc:
	case sortAsc:
		query.SortDirection = sortAsc
	default:
		return query, errInvalidOrder
	}
	if value, ok := c.GetQuery("terms"); ok {
		ids, err := parseTermIDList(value)
		if err != nil {
			return query, err
		}
		query.TermIDs = ids
	}
	if value, ok := c.GetQuery("author_id"); ok {
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id < 1 {
			return query, errInvalidAuthorID
		}
		query.AuthorID = id
	}
	return query, nil
}

// parseTermIDList reads "3,5": positive ids, each once, at most publicQueryMaxTerms.
func parseTermIDList(value string) ([]int64, error) {
	seen := map[int64]bool{}
	ids := []int64{}
	for _, part := range strings.Split(value, ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err != nil || id < 1 {
			return nil, errInvalidTerms
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(ids) > publicQueryMaxTerms {
		return nil, errInvalidTerms
	}
	return ids, nil
}
