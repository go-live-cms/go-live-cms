package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The query loop's reads (#489, docs/design/theme-builder.md 4.3) against the test database
// (skipped without one): whatever filters a query block asks for, GET /public/posts/type/:type
// answers only published posts of a public, active type, and filters on what the site shows (the
// published terms, byline and title), never the working copy. The database is shared across
// runs, so the test lists posts of a post type of its own.

func TestPublicQueryNeverReturnsWhatTheSiteDoesntShow(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	ctx := context.Background()
	ana := scheduleUser(t, store, RoleEditor)
	ben := scheduleUser(t, store, RoleEditor)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	public := createQueryTestType(t, store, "glq"+suffix, true)
	private := createQueryTestType(t, store, "glqp"+suffix, false)
	category, err := store.GetTaxonomyType(ctx, "category")
	require.NoError(t, err)
	guides := createQueryTestTerm(t, store, category.ID, "Guides "+suffix)
	news := createQueryTestTerm(t, store, category.ID, "News "+suffix)

	alpha := queryTestPost(t, store, public, ana, "Alpha "+suffix, guides.ID)
	bravo := queryTestPost(t, store, public, ana, "Bravo "+suffix, news.ID)
	charlie := queryTestPost(t, store, public, ben, "Charlie "+suffix, 0)
	delta := queryTestPost(t, store, public, ben, "Delta "+suffix, 0)
	for _, post := range []db.Post{alpha, bravo, charlie, delta} {
		publishForTest(t, store, post, ana)
	}
	// Changed after publishing, so only the working copy has it: Charlie's working title sorts
	// first and it is in Guides, Delta credits Ana. None of it is on the site.
	_, err = conn.Exec(`UPDATE posts SET title = $1 WHERE id = $2`, "Aardvark "+suffix, charlie.ID)
	require.NoError(t, err)
	require.NoError(t, store.LinkPostTerm(ctx, db.LinkPostTermParams{PostID: charlie.ID, TaxonomyTermID: guides.ID}))
	_, err = store.SetPostAuthorsTx(ctx, db.SetPostAuthorsTxParams{PostID: delta.ID, AuthorIDs: []int64{ana.ID}})
	require.NoError(t, err)

	// Never on the site: a draft, a published post moved to the trash, a post of a private type.
	draft := queryTestPost(t, store, public, ana, "Draft "+suffix, guides.ID)
	trashed := queryTestPost(t, store, public, ana, "Trashed "+suffix, guides.ID)
	publishForTest(t, store, trashed, ana)
	_, err = store.TrashPost(ctx, trashed.ID)
	require.NoError(t, err)
	hidden := queryTestPost(t, store, private, ana, "Private "+suffix, guides.ID)
	publishForTest(t, store, hidden, ana)

	base := "/public/posts/type/" + public.Name
	ids := func(t *testing.T, query string) ([]int64, pageInfo) {
		t.Helper()
		recorder := trashCall(t, server, nil, http.MethodGet, base+query, nil)
		require.Equal(t, http.StatusOK, recorder.Code, "%s: %s", query, recorder.Body.String())
		for _, word := range []string{"Draft " + suffix, "Trashed " + suffix, "Private " + suffix, "Aardvark " + suffix} {
			require.NotContains(t, recorder.Body.String(), word, query)
		}
		var body struct {
			Posts []struct {
				ID int64 `json:"id"`
			} `json:"posts"`
			Pagination pageInfo `json:"pagination"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		out := []int64{}
		for _, post := range body.Posts {
			out = append(out, post.ID)
		}
		return out, body.Pagination
	}

	all := []string{
		"", "?per_page=24", "?order_by=title", "?order=asc", "?order_by=title&order=asc",
		fmt.Sprintf("?terms=%d", guides.ID), fmt.Sprintf("?terms=%d,%d", guides.ID, news.ID),
		fmt.Sprintf("?author_id=%d", ana.ID), fmt.Sprintf("?author_id=%d&terms=%d", ana.ID, guides.ID),
	}
	for _, query := range all {
		got, _ := ids(t, query)
		for _, never := range []int64{draft.ID, trashed.ID, hidden.ID} {
			require.NotContains(t, got, never, query)
		}
	}

	t.Run("newest first by default", func(t *testing.T) {
		got, page := ids(t, "")
		require.Equal(t, []int64{delta.ID, charlie.ID, bravo.ID, alpha.ID}, got)
		require.Equal(t, int64(4), page.Total)
	})
	t.Run("by the published title, A to Z", func(t *testing.T) {
		got, _ := ids(t, "?order_by=title&order=asc")
		require.Equal(t, []int64{alpha.ID, bravo.ID, charlie.ID, delta.ID}, got)
	})
	t.Run("one of the published terms, never a term added since", func(t *testing.T) {
		got, page := ids(t, fmt.Sprintf("?terms=%d", guides.ID))
		require.Equal(t, []int64{alpha.ID}, got)
		require.Equal(t, int64(1), page.Total, "the count takes the filter too")
		got, _ = ids(t, fmt.Sprintf("?terms=%d,%d", news.ID, guides.ID))
		require.Equal(t, []int64{bravo.ID, alpha.ID}, got)
	})
	t.Run("credited in the published byline, never the working one", func(t *testing.T) {
		got, page := ids(t, fmt.Sprintf("?author_id=%d", ana.ID))
		require.Equal(t, []int64{bravo.ID, alpha.ID}, got)
		require.Equal(t, int64(2), page.Total)
		got, _ = ids(t, fmt.Sprintf("?author_id=%d", ben.ID))
		require.Equal(t, []int64{delta.ID, charlie.ID}, got)
	})
	t.Run("a page size of the query's own, capped at 24", func(t *testing.T) {
		got, page := ids(t, "?per_page=2&page=2")
		require.Equal(t, []int64{bravo.ID, alpha.ID}, got)
		require.Equal(t, pageInfo{Page: 2, PerPage: 2, Total: 4, TotalPages: 2}, page)
		_, page = ids(t, "?per_page=500")
		require.Equal(t, int32(24), page.PerPage)
	})
	t.Run("a private type isn't served at all", func(t *testing.T) {
		recorder := trashCall(t, server, nil, http.MethodGet, "/public/posts/type/"+private.Name+"?per_page=3", nil)
		require.Equal(t, http.StatusNotFound, recorder.Code, recorder.Body.String())
	})
}

func createQueryTestType(t *testing.T, store db.Store, name string, public bool) db.PostType {
	t.Helper()
	pt, err := store.CreatePostType(context.Background(), db.CreatePostTypeParams{
		Name: name, Label: "Query test " + name, Public: public, HasArchive: true,
		Supports: json.RawMessage(`[]`), IsActive: true, RegisteredBy: "test",
	})
	require.NoError(t, err)
	return pt
}

func createQueryTestTerm(t *testing.T, store db.Store, taxonomyTypeID int64, name string) db.TaxonomyTerm {
	t.Helper()
	term, err := store.CreateTaxonomyTerm(context.Background(), db.CreateTaxonomyTermParams{
		Name: name, Slug: strings.ToLower(strings.ReplaceAll(name, " ", "-")), TaxonomyTypeID: taxonomyTypeID,
	})
	require.NoError(t, err)
	return term
}

// queryTestPost is a draft of type pt owned by and credited to owner, in termID's category when
// it isn't 0.
func queryTestPost(t *testing.T, store db.Store, pt db.PostType, owner db.User, title string, termID int64) db.Post {
	t.Helper()
	slug := "glq-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	result, err := store.CreatePostTx(context.Background(), db.CreatePostTxParams{
		CreatePostsParams: db.CreatePostsParams{
			Title: title, Description: "About " + title, UserID: owner.ID, Username: owner.Username,
			Url: "https://example.test/" + slug, PostType: pt.Name, PostStatus: "draft", Slug: slug,
			BlockDoc: json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`),
		},
		AuthorIDs: []int64{owner.ID},
	})
	require.NoError(t, err)
	if termID != 0 {
		require.NoError(t, store.LinkPostTerm(context.Background(), db.LinkPostTermParams{PostID: result.Post.ID, TaxonomyTermID: termID}))
	}
	return result.Post
}
