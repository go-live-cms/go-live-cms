package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Trash, filters and bulk actions (#327) against the test database (skipped
// without one, like auth_flow_test.go): the status filters, the public
// queries and the scheduler are only real there. The database is shared across
// runs, so every assertion is about this test's own posts.

// trashCall sends method path (with a JSON body when body isn't nil) as caller.
func trashCall(t *testing.T, server *Server, caller *db.User, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		data, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, path, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if caller != nil {
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// listIDs is GET path's post ids, in order, and meta.total.
func listIDs(t *testing.T, server *Server, caller *db.User, path string) ([]int64, int64) {
	t.Helper()
	recorder := trashCall(t, server, caller, http.MethodGet, path, nil)
	require.Equal(t, http.StatusOK, recorder.Code, "%s: %s", path, recorder.Body.String())
	var body struct {
		Posts []struct {
			ID int64 `json:"id"`
		} `json:"posts"`
		Meta struct {
			Total int64 `json:"total"`
		} `json:"meta"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	ids := make([]int64, 0, len(body.Posts))
	for _, p := range body.Posts {
		ids = append(ids, p.ID)
	}
	return ids, body.Meta.Total
}

// publishForTest publishes post through the store (a real snapshot), as the
// Publish button's transaction does after the flush.
func publishForTest(t *testing.T, store db.Store, post db.Post, by db.User) db.Post {
	t.Helper()
	_, err := store.PublishPostTx(context.Background(), db.PublishPostTxParams{
		PostID:    post.ID,
		CreatedBy: sql.NullInt64{Int64: by.ID, Valid: true},
	})
	require.NoError(t, err)
	return reloadPost(t, store, post.ID)
}

// TestTrashHidesPostEverywhere: a published post with a menu link, trashed,
// is gone from every /public endpoint (post, slug, blocks, authors, adjacent,
// related, the lists, search, the author archive, menus) and from the admin's
// lists except the Trash tab; restoring puts it back as it was.
func TestTrashHidesPostEverywhere(t *testing.T) {
	_, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	ctx := context.Background()

	word := scheduleWord()
	post := publishForTest(t, store, scheduleDraft(t, store, editor, word), editor)
	neighbour := publishForTest(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor)

	location := "trash" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	menu, err := store.SaveMenuTx(ctx, db.SaveMenuTxParams{Name: "Trash test", Location: sql.NullString{String: location, Valid: true}})
	require.NoError(t, err)
	_, err = store.ReplaceMenuItemsTx(ctx, db.ReplaceMenuItemsTxParams{MenuID: menu.ID, Items: []db.MenuItemInput{
		{ParentIndex: -1, ItemType: "post", Label: "Menu link " + word, PostID: sql.NullInt64{Int64: post.ID, Valid: true}},
	}})
	require.NoError(t, err)

	publicPaths := []string{
		fmt.Sprintf("/public/posts/%d", post.ID),
		"/public/posts/slug/" + post.Slug,
		fmt.Sprintf("/public/posts/%d/blocks", post.ID),
	}
	listPaths := []string{
		"/public/posts?type=post&limit=100",
		"/public/posts/type/post",
		"/public/search?q=" + word,
		"/public/authors/" + editor.Username + "/posts",
		fmt.Sprintf("/public/posts/%d/authors", post.ID),
		fmt.Sprintf("/public/posts/%d/adjacent", neighbour.ID),
		fmt.Sprintf("/public/posts/%d/related", neighbour.ID),
		"/public/menus/" + location,
	}

	// Before: it is on the site (so the checks below aren't vacuous).
	for _, path := range publicPaths {
		recorder := trashCall(t, server, nil, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, recorder.Code, "%s: %s", path, recorder.Body.String())
	}
	require.Contains(t, trashCall(t, server, nil, http.MethodGet, "/public/search?q="+word, nil).Body.String(), word)
	require.Contains(t, trashCall(t, server, nil, http.MethodGet, "/public/menus/"+location, nil).Body.String(), word)

	recorder := trashCall(t, server, &editor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var trashed struct {
		Post PostResponse `json:"post"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &trashed))
	require.Equal(t, "trash", trashed.Post.PostStatus)
	require.Equal(t, "published", trashed.Post.TrashedFromStatus)
	require.NotNil(t, trashed.Post.DeletedAt)

	for _, path := range publicPaths {
		recorder := trashCall(t, server, nil, http.MethodGet, path, nil)
		require.Equal(t, http.StatusNotFound, recorder.Code, "%s: %s", path, recorder.Body.String())
	}
	for _, path := range listPaths {
		recorder := trashCall(t, server, nil, http.MethodGet, path, nil)
		require.Less(t, recorder.Code, http.StatusInternalServerError, "%s: %s", path, recorder.Body.String())
		// The search echoes the query; everything else must not mention the post.
		body := recorder.Body.String()
		if strings.HasPrefix(path, "/public/search") {
			var search struct {
				Results []json.RawMessage `json:"results"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &search))
			require.Empty(t, search.Results, path)
			continue
		}
		require.NotContains(t, body, word, path)
		require.NotContains(t, body, post.Slug, path)
	}

	// The admin: gone from All (no status) and its old tab, there in Trash.
	ids, _ := listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts?with_meta=true&author_id=%d&limit=100", editor.ID))
	require.NotContains(t, ids, post.ID)
	ids, _ = listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts?status=published&author_id=%d&limit=100", editor.ID))
	require.NotContains(t, ids, post.ID)
	ids, total := listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts?with_meta=true&status=trash&author_id=%d", editor.ID))
	require.Equal(t, []int64{post.ID}, ids)
	require.Equal(t, int64(1), total)
	ids, _ = listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts/search?q=%s&status=trash", word))
	require.Equal(t, []int64{post.ID}, ids)

	// Nobody edits it while it's there.
	recorder = trashCall(t, server, &editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), map[string]any{"title": "Renamed in the trash"})
	require.Equal(t, http.StatusConflict, recorder.Code, recorder.Body.String())
	recorder = trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil)
	require.Equal(t, http.StatusConflict, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), codePostTrashed)
	recorder = trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/unpublish", post.ID), nil)
	require.Equal(t, http.StatusNotFound, recorder.Code, recorder.Body.String())
	recorder = trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/duplicate", post.ID), nil)
	require.Equal(t, http.StatusConflict, recorder.Code, recorder.Body.String())
	// The other write routes too, moderators included (they skip the owner rule, not the trash).
	for _, w := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/meta", post.ID), map[string]any{"meta_key": "note", "meta_value": "x"}},
		{http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/featured-image", post.ID), map[string]any{"media_id": 1}},
		{http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/media", post.ID), map[string]any{"media_id": 1, "order": 1}},
		{http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d/media/1", post.ID), nil},
		{http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/seo", post.ID), map[string]any{"seo_title": "", "seo_description": "", "noindex": false, "canonical_url": ""}},
		{http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/versions/1/restore-settings", post.ID), nil},
	} {
		recorder = trashCall(t, server, &editor, w.method, w.path, w.body)
		require.Equal(t, http.StatusConflict, recorder.Code, "%s %s: %s", w.method, w.path, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), codePostTrashed, w.path)
	}

	recorder = trashCall(t, server, &editor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
	require.Equal(t, http.StatusConflict, recorder.Code, "trashing twice: %s", recorder.Body.String())
	require.Equal(t, "trash", reloadPost(t, store, post.ID).PostStatus)

	// Restore: published again, same snapshot, back on the site and in the menu.
	recorder = trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/restore", post.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	restored := reloadPost(t, store, post.ID)
	require.Equal(t, "published", restored.PostStatus)
	require.False(t, restored.DeletedAt.Valid)
	require.False(t, restored.TrashedFromStatus.Valid)
	require.Equal(t, post.PublishedVersionID, restored.PublishedVersionID)
	for _, path := range publicPaths {
		recorder := trashCall(t, server, nil, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, recorder.Code, "%s after restore: %s", path, recorder.Body.String())
	}
	require.Contains(t, trashCall(t, server, nil, http.MethodGet, "/public/menus/"+location, nil).Body.String(), word)
	recorder = trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/restore", post.ID), nil)
	require.Equal(t, http.StatusConflict, recorder.Code, "restoring twice: %s", recorder.Body.String())
}

// TestTrashStopsTheScheduler: a due scheduled post in the trash is never
// published; restored after its time it comes back as a draft, and a trashed
// post scheduled for later is scheduled again by a restore, at its time.
func TestTrashStopsTheScheduler(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)
	ctx := context.Background()

	due := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
	laterAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	later := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, laterAt)

	for _, post := range []db.Post{due, later} {
		recorder := trashCall(t, server, &editor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		got := reloadPost(t, store, post.ID)
		require.Equal(t, "trash", got.PostStatus)
		require.Equal(t, "scheduled", got.TrashedFromStatus.String)
		require.True(t, got.PublishAt.Valid, "a trashed scheduled post keeps its time")
	}

	server.publishDueScheduledPosts(ctx)
	require.Equal(t, "trash", reloadPost(t, store, due.ID).PostStatus)
	require.Zero(t, versionCount(t, conn, due.ID))
	require.Zero(t, collab.flushCount(due.ID))

	// A replica that claimed a post just before it was trashed publishes
	// nothing: the claim's fence wants the post still scheduled.
	fenced := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
	claim := claimFor(t, store, fenced.ID)
	_, err := store.TrashPost(ctx, fenced.ID)
	require.NoError(t, err)
	_, err = store.PublishScheduledPostTx(ctx, db.PublishScheduledPostTxParams{PostID: fenced.ID, Claim: claim.Claim.Time})
	require.ErrorIs(t, err, db.ErrScheduleChanged)
	require.Zero(t, versionCount(t, conn, fenced.ID))
	_, err = store.TrashPost(ctx, due.ID)
	require.ErrorIs(t, err, sql.ErrNoRows, "already in the trash")

	recorder := trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/restore", due.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	got := reloadPost(t, store, due.ID)
	require.Equal(t, "draft", got.PostStatus, "its time passed in the trash: a draft, never published at once")
	require.False(t, got.PublishAt.Valid)
	server.publishDueScheduledPosts(ctx)
	require.Zero(t, versionCount(t, conn, due.ID))

	recorder = trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/restore", later.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	got = reloadPost(t, store, later.ID)
	require.Equal(t, "scheduled", got.PostStatus)
	require.True(t, got.PublishAt.Time.Equal(laterAt), "%v vs %v", got.PublishAt.Time, laterAt)
	require.Equal(t, editor.ID, got.PublishScheduledBy.Int64)
	require.Zero(t, got.PublishAttempts)
}

// TestTrashEndsScheduledUpdate: a published post's pending update (#335) ends
// with the trash (000035's status trigger), so the scheduler never applies it,
// a replica that claimed it just before is fenced off, and a restore brings the
// post back as it was published, without the update.
func TestTrashEndsScheduledUpdate(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)
	ctx := context.Background()

	post := publishedPost(t, store, editor)
	live := publishedBody(t, store, post.ID)
	editWorkingCopy(t, conn, post.ID, scheduleWord())
	scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(-time.Minute))
	require.True(t, hasScheduledUpdate(t, conn, post.ID))

	recorder := trashCall(t, server, &editor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.False(t, hasScheduledUpdate(t, conn, post.ID), "the trash ends the pending update")

	server.applyDueScheduledUpdates(ctx)
	require.Equal(t, "trash", reloadPost(t, store, post.ID).PostStatus)
	require.Equal(t, 1, versionCount(t, conn, post.ID))

	// Claimed just before the trash: the claim's fence finds no update.
	fenced := publishedPost(t, store, editor)
	editWorkingCopy(t, conn, fenced.ID, scheduleWord())
	scheduleUpdateAt(t, store, fenced.ID, editor, time.Now().Add(-time.Minute))
	claim := claimUpdateFor(t, store, fenced.ID)
	_, err := store.TrashPost(ctx, fenced.ID)
	require.NoError(t, err)
	_, err = store.PublishScheduledUpdateTx(ctx, db.PublishScheduledUpdateTxParams{PostID: fenced.ID, Claim: claim.Claim.Time})
	require.ErrorIs(t, err, db.ErrScheduleChanged)
	require.Equal(t, 1, versionCount(t, conn, fenced.ID))

	recorder = trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/restore", post.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, "published", reloadPost(t, store, post.ID).PostStatus)
	require.Equal(t, live, publishedBody(t, store, post.ID), "restored as it was published")
	require.False(t, hasScheduledUpdate(t, conn, post.ID), "restore doesn't bring the update back")
	server.applyDueScheduledUpdates(ctx)
	require.Equal(t, 1, versionCount(t, conn, post.ID))
}

// TestPermanentDelete: only from the trash, only admins and editors, and the
// row and what hangs off it are gone.
func TestPermanentDelete(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	contributor := scheduleUser(t, store, RoleContributor)
	server := scheduleServer(t, store, newStubCollab(t, 0))

	post := scheduleDraft(t, store, contributor, scheduleWord())
	path := fmt.Sprintf("/api/v1/posts/%d/permanent", post.ID)

	recorder := trashCall(t, server, &editor, http.MethodDelete, path, nil)
	require.Equal(t, http.StatusConflict, recorder.Code, "not in the trash: %s", recorder.Body.String())

	// The owner may trash their draft, and restore it, but not delete it for good.
	recorder = trashCall(t, server, &contributor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	recorder = trashCall(t, server, &contributor, http.MethodDelete, path, nil)
	require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())

	recorder = trashCall(t, server, &editor, http.MethodDelete, path, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	_, err := store.GetPost(context.Background(), post.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)
	var bylines int
	require.NoError(t, conn.QueryRow(`SELECT count(*) FROM user_posts WHERE post_id = $1`, post.ID).Scan(&bylines))
	require.Zero(t, bylines)

	recorder = trashCall(t, server, &editor, http.MethodDelete, path, nil)
	require.Equal(t, http.StatusNotFound, recorder.Code, recorder.Body.String())
}

// TestPostListFiltersCombined: author (byline), category and tag filters
// together with the status tabs, sort, search and the counts.
func TestPostListFiltersCombined(t *testing.T) {
	_, store := scheduleTestDB(t)
	ctx := context.Background()
	editor := scheduleUser(t, store, RoleEditor)
	author := scheduleUser(t, store, RoleContributor)
	coauthor := scheduleUser(t, store, RoleContributor)
	server := scheduleServer(t, store, newStubCollab(t, 0))

	// A category and a tag: a post has one category (#331), and b has both terms.
	newTerm := func(name, taxonomy string) db.TaxonomyTerm {
		type_, err := store.GetTaxonomyType(ctx, taxonomy)
		require.NoError(t, err)
		suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
		term, err := store.CreateTaxonomyTerm(ctx, db.CreateTaxonomyTermParams{Name: name + suffix, Slug: name + "-" + suffix, TaxonomyTypeID: type_.ID})
		require.NoError(t, err)
		return term
	}
	guides, news := newTerm("Guides", "category"), newTerm("News", "tag")

	word := scheduleWord()
	mk := func(title string, owner db.User, coauthors []db.User, terms ...db.TaxonomyTerm) db.Post {
		post := scheduleDraft(t, store, owner, word)
		_, err := store.UpdatePost(ctx, db.UpdatePostParams{ID: post.ID, Title: title + " " + word, Description: post.Description,
			UserID: post.UserID, Username: post.Username, Url: post.Url, PostType: post.PostType, PostStatus: post.PostStatus})
		require.NoError(t, err)
		for i, co := range coauthors {
			_, err := store.CreateUserPost(ctx, db.CreateUserPostParams{PostID: post.ID, UserID: co.ID, Order: int32(i + 1)})
			require.NoError(t, err)
		}
		for _, term := range terms {
			// The category replaces the default one the draft started with (#331).
			_, err := store.SetPostTermTx(ctx, db.SetPostTermTxParams{PostID: post.ID, TermID: term.ID})
			require.NoError(t, err)
		}
		return reloadPost(t, store, post.ID)
	}
	// author owns b and c; coauthor is credited on c and owns d.
	a := mk("Alpha", editor, nil, guides)
	b := mk("Bravo", author, nil, guides, news)
	c := mk("Charlie", author, []db.User{coauthor}, guides)
	d := mk("Delta", coauthor, nil, news)
	b = publishForTest(t, store, b, editor)
	_, err := store.TrashPost(ctx, d.ID)
	require.NoError(t, err)

	q := func(params string) []int64 {
		ids, total := listIDs(t, server, &editor, "/api/v1/posts?with_meta=true&limit=100&sort=title&order=asc&"+params)
		require.Equal(t, int64(len(ids)), total, params)
		return ids
	}
	require.Equal(t, []int64{a.ID, b.ID, c.ID}, q(fmt.Sprintf("terms=%d", guides.ID)))
	require.Equal(t, []int64{b.ID}, q(fmt.Sprintf("terms=%d,%d", guides.ID, news.ID)), "every term given")
	require.Equal(t, []int64{b.ID, c.ID}, q(fmt.Sprintf("author_id=%d", author.ID)))
	require.Equal(t, []int64{c.ID}, q(fmt.Sprintf("author_id=%d", coauthor.ID)), "a credited coauthor; d is in the trash")
	require.Equal(t, []int64{d.ID}, q(fmt.Sprintf("author_id=%d&status=trash", coauthor.ID)))
	require.Equal(t, []int64{c.ID}, q(fmt.Sprintf("author_id=%d&terms=%d&status=draft", author.ID, guides.ID)))
	require.Equal(t, []int64{b.ID}, q(fmt.Sprintf("author_id=%d&terms=%d&status=published", author.ID, guides.ID)))
	ids, _ := listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts?with_meta=true&author_id=%d&sort=title&order=desc", author.ID))
	require.Equal(t, []int64{c.ID, b.ID}, ids, "sort still applies")
	ids, _ = listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts/type/post?with_meta=true&terms=%d&sort=title&order=asc&limit=100", news.ID))
	require.Equal(t, []int64{b.ID}, ids)

	// Search: the index (a whole word) and part of a title or a slug, with the filters.
	ids, _ = listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts/search?q=%s&author_id=%d", word, author.ID))
	require.ElementsMatch(t, []int64{b.ID, c.ID}, ids)
	ids, _ = listIDs(t, server, &editor, fmt.Sprintf("/api/v1/posts/search?q=harli&terms=%d", guides.ID))
	require.Equal(t, []int64{c.ID}, ids, "part of a word in the title")
	ids, _ = listIDs(t, server, &editor, "/api/v1/posts/search?q="+c.Slug[len(c.Slug)-10:])
	require.Equal(t, []int64{c.ID}, ids, "part of the slug")

	// A contributor still sees only their own posts and published ones.
	ids, total := listIDs(t, server, &coauthor, fmt.Sprintf("/api/v1/posts?with_meta=true&terms=%d", guides.ID))
	require.ElementsMatch(t, []int64{b.ID}, ids)
	require.Equal(t, int64(1), total)

	// Counts: per status for the author's posts, trash included.
	recorder := trashCall(t, server, &editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/counts?user_id=%d", coauthor.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var counts struct {
		Counts map[string]int64 `json:"counts"`
		Total  int64            `json:"total"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &counts))
	require.Equal(t, map[string]int64{"trash": 1}, counts.Counts)
	recorder = trashCall(t, server, &editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/counts?user_id=%d", author.ID), nil)
	counts.Counts = nil
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &counts))
	require.Equal(t, map[string]int64{"draft": 1, "published": 1}, counts.Counts)

	recorder = trashCall(t, server, &editor, http.MethodGet, "/api/v1/posts?author_id=me", nil)
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	recorder = trashCall(t, server, &editor, http.MethodGet, "/api/v1/posts?terms=1,2,3,4,5,6,7,8,9,10,11", nil)
	require.Equal(t, http.StatusBadRequest, recorder.Code)
}

type bulkAnswer struct {
	Action    string           `json:"action"`
	Results   []BulkPostResult `json:"results"`
	Succeeded int              `json:"succeeded"`
	Failed    int              `json:"failed"`
}

func bulkCall(t *testing.T, server *Server, caller *db.User, action string, ids ...int64) bulkAnswer {
	t.Helper()
	recorder := trashCall(t, server, caller, http.MethodPost, "/api/v1/posts/bulk", map[string]any{"action": action, "ids": ids})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var answer bulkAnswer
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &answer))
	return answer
}

func bulkOutcomes(answer bulkAnswer) map[int64]string {
	out := map[int64]string{}
	for _, r := range answer.Results {
		if r.OK {
			out[r.ID] = "ok:" + r.PostStatus
		} else {
			out[r.ID] = fmt.Sprintf("%d:%s", r.Status, r.Code)
		}
	}
	return out
}

// postActivity lists a post's activity events (#324) as "verb by actor", oldest
// first.
func postActivity(t *testing.T, conn *sql.DB, postID int64) []string {
	t.Helper()
	rows, err := conn.Query(`SELECT verb, COALESCE(actor_id, 0) FROM activity WHERE object_type = 'post' AND object_id = $1 ORDER BY id`, postID)
	require.NoError(t, err)
	defer rows.Close()
	var events []string
	for rows.Next() {
		var verb string
		var actor int64
		require.NoError(t, rows.Scan(&verb, &actor))
		events = append(events, fmt.Sprintf("%s by %d", verb, actor))
	}
	require.NoError(t, rows.Err())
	return events
}

// TestBulkActionsMixedPermissions: each post is checked on its own, and one
// failure doesn't stop the others.
func TestBulkActionsMixedPermissions(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	contributor := scheduleUser(t, store, RoleContributor)
	other := scheduleUser(t, store, RoleContributor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)

	ownDraft := scheduleDraft(t, store, contributor, scheduleWord())
	ownPublished := publishForTest(t, store, scheduleDraft(t, store, contributor, scheduleWord()), editor)
	othersDraft := scheduleDraft(t, store, other, scheduleWord())
	missing := othersDraft.ID + 1_000_000

	// Trash as a contributor: their draft yes; their published post and someone
	// else's draft no; a missing post 404. Duplicates count once.
	answer := bulkCall(t, server, &contributor, "trash", ownDraft.ID, ownPublished.ID, othersDraft.ID, missing, ownDraft.ID)
	require.Equal(t, "trash", answer.Action)
	require.Len(t, answer.Results, 4)
	require.Equal(t, map[int64]string{
		ownDraft.ID:     "ok:trash",
		ownPublished.ID: "403:forbidden",
		othersDraft.ID:  "403:forbidden",
		missing:         "404:not_found",
	}, bulkOutcomes(answer))
	require.Equal(t, 1, answer.Succeeded)
	require.Equal(t, 3, answer.Failed)
	require.Equal(t, ownDraft.ID, answer.Results[0].ID, "in the order given")
	require.Equal(t, "published", reloadPost(t, store, ownPublished.ID).PostStatus)
	// The collab server was asked to re-check the trashed post's open editors (after
	// the response, in the background).
	require.Eventually(t, func() bool { return collab.recheckCount(ownDraft.ID) == 1 }, 5*time.Second, 20*time.Millisecond)
	require.Zero(t, collab.recheckCount(ownPublished.ID))

	// Publish needs the editor role, per item.
	answer = bulkCall(t, server, &contributor, "publish", ownDraft.ID, othersDraft.ID)
	require.Equal(t, map[int64]string{ownDraft.ID: "403:forbidden", othersDraft.ID: "403:forbidden"}, bulkOutcomes(answer))

	// An editor trashes the contributor's published post; restoring it would
	// publish it again, so the contributor may restore only their draft.
	answer = bulkCall(t, server, &editor, "trash", ownPublished.ID)
	require.Equal(t, map[int64]string{ownPublished.ID: "ok:trash"}, bulkOutcomes(answer))
	answer = bulkCall(t, server, &contributor, "restore", ownDraft.ID, ownPublished.ID, othersDraft.ID)
	require.Equal(t, map[int64]string{
		ownDraft.ID:     "ok:draft",
		ownPublished.ID: "403:forbidden",
		othersDraft.ID:  "403:forbidden",
	}, bulkOutcomes(answer))

	// Publish as an editor: the same path as one post (flush, then the
	// transaction); the trashed one is refused.
	answer = bulkCall(t, server, &editor, "publish", ownDraft.ID, ownPublished.ID, othersDraft.ID)
	require.Equal(t, map[int64]string{
		ownDraft.ID:     "ok:published",
		ownPublished.ID: "409:post_trashed",
		othersDraft.ID:  "ok:published",
	}, bulkOutcomes(answer))
	require.Equal(t, 1, collab.flushCount(ownDraft.ID))
	require.Equal(t, 1, versionCount(t, conn, ownDraft.ID))
	require.Equal(t, "published", reloadPost(t, store, othersDraft.ID).PostStatus)

	// Permanent delete: editors, trashed posts only.
	answer = bulkCall(t, server, &contributor, "delete", ownPublished.ID)
	require.Equal(t, map[int64]string{ownPublished.ID: "403:forbidden"}, bulkOutcomes(answer))
	answer = bulkCall(t, server, &editor, "delete", ownPublished.ID, ownDraft.ID)
	require.Equal(t, map[int64]string{ownPublished.ID: "ok:", ownDraft.ID: "409:not_in_trash"}, bulkOutcomes(answer))
	_, err := store.GetPost(context.Background(), ownPublished.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)

	// The activity log (#324) has what each post went through, by whom; the
	// refused actions left nothing.
	require.Equal(t, []string{
		fmt.Sprintf("trashed by %d", contributor.ID),
		fmt.Sprintf("restored by %d", contributor.ID),
		fmt.Sprintf("published by %d", editor.ID),
	}, postActivity(t, conn, ownDraft.ID))
	require.Equal(t, []string{
		fmt.Sprintf("trashed by %d", editor.ID),
		fmt.Sprintf("deleted by %d", editor.ID),
	}, postActivity(t, conn, ownPublished.ID))
	require.Equal(t, []string{fmt.Sprintf("published by %d", editor.ID)}, postActivity(t, conn, othersDraft.ID))

	// The request itself is validated.
	for _, body := range []map[string]any{
		{"action": "trash", "ids": []int64{}},
		{"action": "archive", "ids": []int64{ownDraft.ID}},
		{"action": "trash"},
		{"action": "trash", "ids": make([]int64, maxBulkPosts+1)},
	} {
		recorder := trashCall(t, server, &editor, http.MethodPost, "/api/v1/posts/bulk", body)
		require.Equal(t, http.StatusBadRequest, recorder.Code, "%v: %s", body, recorder.Body.String())
	}
	recorder := trashCall(t, server, nil, http.MethodPost, "/api/v1/posts/bulk", map[string]any{"action": "trash", "ids": []int64{ownDraft.ID}})
	require.Equal(t, http.StatusUnauthorized, recorder.Code)
}

// recheckCount is how many times the API asked for post-<id>'s connections to
// be re-checked (POST /internal/documents/post-<id>/recheck, #327).
func (stub *stubCollab) recheckCount(postID int64) int {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return stub.flushes[fmt.Sprintf("post-%d/recheck", postID)]
}

// TestPostBylineAuthors: the Author filter's options (GET /posts/authors) are the
// people credited on posts of the type that the caller may read.
func TestPostBylineAuthors(t *testing.T) {
	_, store := scheduleTestDB(t)
	ctx := context.Background()
	editor := scheduleUser(t, store, RoleEditor)
	author := scheduleUser(t, store, RoleContributor)
	coauthor := scheduleUser(t, store, RoleContributor)
	server := scheduleServer(t, store, newStubCollab(t, 0))

	// A type of its own, so the shared database's other posts don't matter.
	typeName := "bt" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	_, err := store.CreatePostType(ctx, db.CreatePostTypeParams{Name: typeName, Label: "Byline test", Supports: json.RawMessage(`[]`), IsActive: true, RegisteredBy: "test"})
	require.NoError(t, err)
	mk := func(owner db.User, status string, credited ...db.User) {
		slug := typeName + "-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:8]
		ids := []int64{owner.ID}
		for _, u := range credited {
			ids = append(ids, u.ID)
		}
		_, err := store.CreatePostTx(ctx, db.CreatePostTxParams{
			CreatePostsParams: db.CreatePostsParams{Title: "Byline " + slug, Slug: slug, BlockDoc: json.RawMessage(`{}`), UserID: owner.ID,
				Username: owner.Username, Url: "https://example.test/" + slug, PostType: typeName, PostStatus: status},
			AuthorIDs: ids,
		})
		require.NoError(t, err)
	}
	mk(author, "draft", coauthor)
	mk(coauthor, "published")
	mk(editor, "draft")

	authorsOf := func(caller *db.User) []int64 {
		recorder := trashCall(t, server, caller, http.MethodGet, "/api/v1/posts/authors?type="+typeName, nil)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var body struct {
			Authors []PostAuthorResponse `json:"authors"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		ids := []int64{}
		for _, a := range body.Authors {
			ids = append(ids, a.ID)
		}
		return ids
	}
	require.ElementsMatch(t, []int64{author.ID, coauthor.ID, editor.ID}, authorsOf(&editor))
	// A contributor: only bylines of posts they may read (their own and published ones).
	require.ElementsMatch(t, []int64{coauthor.ID}, authorsOf(&coauthor))
	require.ElementsMatch(t, []int64{author.ID, coauthor.ID}, authorsOf(&author))
	require.Equal(t, http.StatusUnauthorized, trashCall(t, server, nil, http.MethodGet, "/api/v1/posts/authors", nil).Code)
}
