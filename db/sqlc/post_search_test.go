package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// Full-text search (#145): the post_search index its triggers keep (000024) and
// the queries in post_search.sql. The shared test DB holds other posts, so every
// test searches for a word only its own posts contain.

// searchWord is a word no other post contains (letters only, so the parser
// keeps it one token).
func searchWord(t *testing.T) string {
	digits := fmt.Sprint(time.Now().UnixNano())
	var b strings.Builder
	b.WriteString("zq")
	for _, d := range digits {
		b.WriteRune('a' + (d - '0'))
	}
	return b.String()
}

// searchDoc is a Block Spec v1 doc with one paragraph per text.
func searchDoc(texts ...string) json.RawMessage {
	order := []string{}
	blocks := map[string]interface{}{}
	for i, text := range texts {
		id := fmt.Sprintf("b%d", i)
		order = append(order, id)
		blocks[id] = map[string]interface{}{"id": id, "type": "paragraph", "version": 1, "attrs": map[string]interface{}{"text": text}}
	}
	doc, _ := json.Marshal(map[string]interface{}{"doc_version": 1, "blocks_order": order, "blocks": blocks})
	return doc
}

type searchPostSpec struct {
	title, description, postType, status string
	body                                 json.RawMessage // working copy
	createdAt                            time.Time
}

func createSearchPost(t *testing.T, owner User, spec searchPostSpec) Post {
	ctx := context.Background()
	slug := fmt.Sprintf("search-%d", time.Now().UnixNano())
	if spec.postType == "" {
		spec.postType = "post"
	}
	if spec.status == "" {
		spec.status = "draft"
	}
	if spec.body == nil {
		spec.body = json.RawMessage(`{}`)
	}
	post, err := testQueries.CreatePosts(ctx, CreatePostsParams{
		Title:       spec.title,
		Description: spec.description,
		UserID:      owner.ID,
		Username:    owner.Username,
		Url:         "https://example.com/" + slug,
		PostType:    spec.postType,
		PostStatus:  spec.status,
		Slug:        slug,
		BlockDoc:    spec.body,
	})
	require.NoError(t, err)
	if !spec.createdAt.IsZero() {
		_, err = testQueries.db.ExecContext(ctx, `UPDATE posts SET created_at = $2 WHERE id = $1`, post.ID, spec.createdAt)
		require.NoError(t, err)
		post.CreatedAt = spec.createdAt
	}
	return post
}

// publishSearchPost publishes the working copy the way publishPost does: a
// post_versions row and the snapshot on the post.
func publishSearchPost(t *testing.T, post Post, doc json.RawMessage) {
	ctx := context.Background()
	next, err := testQueries.GetNextVersionNoForPost(ctx, post.ID)
	require.NoError(t, err)
	version, err := testQueries.InsertPostVersion(ctx, InsertPostVersionParams{
		PostID: post.ID, VersionNo: next, BlockDoc: doc,
	})
	require.NoError(t, err)
	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID:                 post.ID,
		PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: doc, Valid: true},
	}))
}

func publicSearchIDs(t *testing.T, query, postType string) []int64 {
	rows, err := testQueries.SearchPublicPosts(context.Background(), SearchPublicPostsParams{
		Query: query, PostType: postType, LimitCount: 50,
	})
	require.NoError(t, err)
	ids := []int64{}
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func TestSearchPublicPostsRanksByWeightThenRecency(t *testing.T) {
	owner := createRandomUser(t)
	word := searchWord(t)
	now := time.Now()

	// Oldest first: weight must beat recency.
	inTitle := createSearchPost(t, owner, searchPostSpec{title: "About " + word, createdAt: now.Add(-72 * time.Hour)})
	publishSearchPost(t, inTitle, searchDoc("nothing here"))
	inDescription := createSearchPost(t, owner, searchPostSpec{title: "Second", description: "On " + word, createdAt: now.Add(-48 * time.Hour)})
	publishSearchPost(t, inDescription, searchDoc("nothing here"))
	inBodyOld := createSearchPost(t, owner, searchPostSpec{title: "Third", createdAt: now.Add(-24 * time.Hour)})
	publishSearchPost(t, inBodyOld, searchDoc("the body mentions "+word+" once"))
	inBodyNew := createSearchPost(t, owner, searchPostSpec{title: "Fourth", createdAt: now})
	publishSearchPost(t, inBodyNew, searchDoc("the body mentions "+word+" once"))

	require.Equal(t, []int64{inTitle.ID, inDescription.ID, inBodyNew.ID, inBodyOld.ID}, publicSearchIDs(t, word, ""))
}

func TestSearchPublicPostsTermNamesAreWeightedLikeDescriptions(t *testing.T) {
	owner := createRandomUser(t)
	word := searchWord(t)
	taxonomy := createTestTaxonomyType(t, "srch", "Search", false)
	term := createTestTaxonomyTerm(t, taxonomy.ID)

	tagged := createSearchPost(t, owner, searchPostSpec{title: "Tagged"})
	publishSearchPost(t, tagged, searchDoc("plain"))
	inBody := createSearchPost(t, owner, searchPostSpec{title: "Body"})
	publishSearchPost(t, inBody, searchDoc(word))
	require.Equal(t, []int64{inBody.ID}, publicSearchIDs(t, word, ""))

	// Renaming the term and linking it both reach the index (triggers).
	_, err := testQueries.db.ExecContext(context.Background(), `UPDATE taxonomy_terms SET name = $2 WHERE id = $1`, term.ID, "Topic "+word)
	require.NoError(t, err)
	tagPost(t, tagged, term)
	require.Equal(t, []int64{tagged.ID, inBody.ID}, publicSearchIDs(t, word, ""))

	// A private taxonomy's terms don't make a post findable.
	_, err = testQueries.db.ExecContext(context.Background(), `UPDATE taxonomy_types SET public = false WHERE id = $1`, taxonomy.ID)
	require.NoError(t, err)
	require.Equal(t, []int64{inBody.ID}, publicSearchIDs(t, word, ""))

	// Unlinking removes it again.
	_, err = testQueries.db.ExecContext(context.Background(), `UPDATE taxonomy_types SET public = true WHERE id = $1`, taxonomy.ID)
	require.NoError(t, err)
	require.Equal(t, []int64{tagged.ID, inBody.ID}, publicSearchIDs(t, word, ""))
	require.NoError(t, testQueries.RemovePostFromTaxonomyTerm(context.Background(), RemovePostFromTaxonomyTermParams{PostID: tagged.ID, TaxonomyTermID: term.ID}))
	require.Equal(t, []int64{inBody.ID}, publicSearchIDs(t, word, ""))
}

func TestSearchPublicPostsOnlyPublishedSnapshots(t *testing.T) {
	ctx := context.Background()
	owner := createRandomUser(t)
	word := searchWord(t)

	// A draft whose title and working copy both match: never public.
	createSearchPost(t, owner, searchPostSpec{title: word, body: searchDoc(word)})
	// A published post whose working copy (unpublished edits) matches but whose
	// published snapshot doesn't: the working copy is never indexed.
	edited := createSearchPost(t, owner, searchPostSpec{title: "Edited", body: searchDoc(word)})
	publishSearchPost(t, edited, searchDoc("old published text"))
	// Published, and it matches.
	published := createSearchPost(t, owner, searchPostSpec{title: "Live"})
	publishSearchPost(t, published, searchDoc("published "+word))
	// Archived posts keep their snapshot but aren't public.
	archived := createSearchPost(t, owner, searchPostSpec{title: "Archived " + word})
	publishSearchPost(t, archived, searchDoc("x"))
	_, err := testQueries.db.ExecContext(ctx, `UPDATE posts SET post_status = 'archived' WHERE id = $1`, archived.ID)
	require.NoError(t, err)

	require.Equal(t, []int64{published.ID}, publicSearchIDs(t, word, ""))
	counts, err := testQueries.CountPublicSearchResults(ctx, word)
	require.NoError(t, err)
	require.Equal(t, []CountPublicSearchResultsRow{{PostType: "post", Total: 1}}, counts)

	// Unpublishing takes it out of the results.
	_, err = testQueries.UnpublishPost(ctx, published.ID)
	require.NoError(t, err)
	require.Empty(t, publicSearchIDs(t, word, ""))
	require.NotContains(t, publicSearchIDs(t, "published", ""), published.ID)
}

func TestSearchPublicPostsTypesAndCounts(t *testing.T) {
	ctx := context.Background()
	owner := createRandomUser(t)
	word := searchWord(t)

	post := createSearchPost(t, owner, searchPostSpec{title: "Post " + word})
	publishSearchPost(t, post, searchDoc("x"))
	page := createSearchPost(t, owner, searchPostSpec{title: "Page " + word, postType: "page"})
	publishSearchPost(t, page, searchDoc("x"))
	// Other public types aren't part of the search.
	other := createAuthorPostType(t, true, true)
	custom := createSearchPost(t, owner, searchPostSpec{title: "Custom " + word, postType: other})
	publishSearchPost(t, custom, searchDoc("x"))

	require.ElementsMatch(t, []int64{post.ID, page.ID}, publicSearchIDs(t, word, ""))
	require.Equal(t, []int64{post.ID}, publicSearchIDs(t, word, "post"))
	require.Equal(t, []int64{page.ID}, publicSearchIDs(t, word, "page"))

	counts, err := testQueries.CountPublicSearchResults(ctx, word)
	require.NoError(t, err)
	require.ElementsMatch(t, []CountPublicSearchResultsRow{{PostType: "post", Total: 1}, {PostType: "page", Total: 1}}, counts)
}

func TestSearchPublicPostsHighlights(t *testing.T) {
	owner := createRandomUser(t)
	word := searchWord(t)
	post := createSearchPost(t, owner, searchPostSpec{title: "<b>" + word + "</b> & more", description: "A summary"})
	publishSearchPost(t, post, searchDoc("Intro text.", "The "+word+" part forged."))

	rows, err := testQueries.SearchPublicPosts(context.Background(), SearchPublicPostsParams{Query: word, LimitCount: 10})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	// The whole title, tags kept as text (the API escapes them), the match marked.
	require.Equal(t, "<b>"+word+"</b> & more", rows[0].TitleHighlight)
	// A sentinel stored in the post is removed before ts_headline adds its own.
	require.Contains(t, rows[0].ExcerptHighlight, ""+word+"")
	require.Equal(t, 1, strings.Count(rows[0].ExcerptHighlight, ""))
	require.NotContains(t, rows[0].ExcerptHighlight, "forged")
}

func TestSearchQueriesAcceptAnyInput(t *testing.T) {
	ctx := context.Background()
	for _, query := range []string{"&|!(", "!", "a & b | (c", `"unclosed`, "<script>alert(1)</script>", "-", "or", "foo:*", "'; DROP TABLE posts; --"} {
		_, err := testQueries.SearchPublicPosts(ctx, SearchPublicPostsParams{Query: query, LimitCount: 10})
		require.NoError(t, err, query)
		_, err = testQueries.CountPublicSearchResults(ctx, query)
		require.NoError(t, err, query)
		_, err = testQueries.SearchPostsWithMeta(ctx, SearchPostsWithMetaParams{Query: query, LimitCount: 10})
		require.NoError(t, err, query)
		_, err = testQueries.CountSearchPosts(ctx, CountSearchPostsParams{Query: query})
		require.NoError(t, err, query)
	}
}

func TestSearchPostsWithMetaIncludesDraftsWithListFilters(t *testing.T) {
	ctx := context.Background()
	owner := createRandomUser(t)
	other := createRandomUser(t)
	word := searchWord(t)

	draft := createSearchPost(t, owner, searchPostSpec{title: "Draft " + word})
	othersDraft := createSearchPost(t, other, searchPostSpec{title: "Other " + word})
	published := createSearchPost(t, owner, searchPostSpec{title: "Live " + word})
	publishSearchPost(t, published, searchDoc("x"))
	// The working copy of a draft is never indexed.
	createSearchPost(t, owner, searchPostSpec{title: "Unrelated", body: searchDoc(word)})

	search := func(status string, userID int64) []int64 {
		rows, err := testQueries.SearchPostsWithMeta(ctx, SearchPostsWithMetaParams{
			Query: word, PostStatus: status, UserID: userID, LimitCount: 50,
		})
		require.NoError(t, err)
		total, err := testQueries.CountSearchPosts(ctx, CountSearchPostsParams{Query: word, PostStatus: status, UserID: userID})
		require.NoError(t, err)
		require.EqualValues(t, len(rows), total)
		ids := []int64{}
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		return ids
	}

	require.ElementsMatch(t, []int64{draft.ID, othersDraft.ID, published.ID}, search("draft,published", 0))
	require.ElementsMatch(t, []int64{draft.ID, othersDraft.ID}, search("draft", 0))
	require.ElementsMatch(t, []int64{draft.ID, published.ID}, search("", owner.ID))
	require.Equal(t, []int64{published.ID}, search("published", owner.ID))
}

func TestPostSearchBackfill(t *testing.T) {
	ctx := context.Background()
	owner := createRandomUser(t)
	word := searchWord(t)
	post := createSearchPost(t, owner, searchPostSpec{title: "Backfilled"})
	publishSearchPost(t, post, searchDoc("text with "+word))

	// A post from before the migration: no post_search row.
	_, err := testQueries.db.ExecContext(ctx, `DELETE FROM post_search WHERE post_id = $1`, post.ID)
	require.NoError(t, err)
	require.Empty(t, publicSearchIDs(t, word, ""))

	// The migration's backfill statement.
	_, err = testQueries.db.ExecContext(ctx, `SELECT golive_refresh_post_search(ARRAY(SELECT id FROM posts))`)
	require.NoError(t, err)
	require.Equal(t, []int64{post.ID}, publicSearchIDs(t, word, ""))

	var body string
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT body_text FROM post_search WHERE post_id = $1`, post.ID).Scan(&body))
	require.Equal(t, "text with "+word, body)
}

func TestBlockDocText(t *testing.T) {
	ctx := context.Background()
	doc := `{"doc_version":1,"blocks_order":["h","l","img","q","code"],"blocks":{
		"h":{"type":"heading","attrs":{"text":"Title"}},
		"l":{"type":"bullet_list","children":["i1","i2"],"attrs":{}},
		"i1":{"type":"list_item","attrs":{"text":"one"}},
		"i2":{"type":"list_item","attrs":{"text":"two"},"children":["n"]},
		"n":{"type":"bullet_list","children":["n1"]},
		"n1":{"type":"list_item","attrs":{"text":"nested"}},
		"img":{"type":"image","attrs":{"caption":[{"type":"text","text":"A "},{"type":"text","text":"cat","marks":[{"type":"bold"}]}]}},
		"q":{"type":"blockquote","attrs":{"text":"Quoted","cite":"Someone"}},
		"code":{"type":"code_block","attrs":{"code":"x := 1"}},
		"orphan":{"type":"paragraph","attrs":{"text":"not in the doc"}}
	}}`
	var text string
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT golive_block_doc_text($1::jsonb)`, doc).Scan(&text))
	require.Equal(t, "Title\none\ntwo\nnested\nA cat\nQuoted\nSomeone\nx := 1", text)

	for _, malformed := range []string{`{}`, `5`, `null`, `[]`, `{"blocks_order":[1,{"x":2}],"blocks":[]}`, `{"blocks_order":["a"],"blocks":{"a":{"type":"paragraph","attrs":{"text":7}}}}`,
		`{"blocks_order":["a"],"blocks":{"a":{"type":"bullet_list","children":["a"]}}}`} {
		require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT golive_block_doc_text($1::jsonb)`, malformed).Scan(&text), malformed)
		require.Equal(t, "", text, malformed)
	}
}

func TestSearchPublicPostsExcerptEdges(t *testing.T) {
	owner := createRandomUser(t)
	word := searchWord(t)
	short := createSearchPost(t, owner, searchPostSpec{title: "Short", description: "All of it."})
	publishSearchPost(t, short, searchDoc("A short body about "+word+"."))
	long := createSearchPost(t, owner, searchPostSpec{title: "Long"})
	filler := strings.Repeat("filler words go here and on ", 20)
	publishSearchPost(t, long, searchDoc("An opening sentence nobody repeats. "+filler+"then "+word+" appears "+filler+"and a closing line."))

	rows, err := testQueries.SearchPublicPosts(context.Background(), SearchPublicPostsParams{Query: word, LimitCount: 10})
	require.NoError(t, err)
	byID := map[int64]SearchPublicPostsRow{}
	for _, row := range rows {
		byID[row.ID] = row
	}
	// The whole text fits: no cut at either end, the final period notwithstanding.
	require.True(t, byID[short.ID].ExcerptAtStart)
	require.True(t, byID[short.ID].ExcerptAtEnd)
	// A fragment from the middle of a long body: cut at both ends.
	require.Contains(t, byID[long.ID].ExcerptHighlight, word)
	require.False(t, byID[long.ID].ExcerptAtStart)
	require.False(t, byID[long.ID].ExcerptAtEnd)
}

// A title edit and a term link on one post in concurrent transactions: whichever
// commits last, the index has both (golive_refresh_post_search locks the post).
func TestPostSearchConcurrentEditsKeepBothChanges(t *testing.T) {
	ctx := context.Background()
	conn, ok := testQueries.db.(*sql.DB)
	require.True(t, ok)
	owner := createRandomUser(t)
	titleWord, termWord := searchWord(t), searchWord(t)
	taxonomy := createTestTaxonomyType(t, "race", "Race", false)
	term := createTestTaxonomyTerm(t, taxonomy.ID)
	_, err := conn.ExecContext(ctx, `UPDATE taxonomy_terms SET name = $2 WHERE id = $1`, term.ID, termWord)
	require.NoError(t, err)
	post := createSearchPost(t, owner, searchPostSpec{title: "Before"})

	// Transaction A renames the post and holds its row lock.
	txA, err := conn.BeginTx(ctx, nil)
	require.NoError(t, err)
	_, err = txA.ExecContext(ctx, `UPDATE posts SET title = $2 WHERE id = $1`, post.ID, "After "+titleWord)
	require.NoError(t, err)

	// Transaction B links the term meanwhile; its rebuild waits for A's lock.
	done := make(chan error, 1)
	go func() {
		txB, err := conn.BeginTx(ctx, nil)
		if err != nil {
			done <- err
			return
		}
		if _, err := txB.ExecContext(ctx, `INSERT INTO post_taxonomy_relationships (post_id, taxonomy_term_id) VALUES ($1, $2)`, post.ID, term.ID); err != nil {
			_ = txB.Rollback()
			done <- err
			return
		}
		done <- txB.Commit()
	}()
	select {
	case err := <-done:
		t.Fatalf("B finished while A held the post: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	require.NoError(t, txA.Commit())
	require.NoError(t, <-done)

	var matchesTitle, matchesTerm bool
	require.NoError(t, conn.QueryRowContext(ctx,
		`SELECT document @@ to_tsquery('simple', $2), document @@ to_tsquery('simple', $3) FROM post_search WHERE post_id = $1`,
		post.ID, titleWord, termWord).Scan(&matchesTitle, &matchesTerm))
	require.True(t, matchesTitle, "the title edit was lost")
	require.True(t, matchesTerm, "the term link was lost")
}
