package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The front page and page templates (#336) against the real database (skipped
// without one, like auth_flow_test.go): / falls back to the latest posts whenever
// the front page isn't a published page, and a page's template is a post setting
// that waits for Update.
//
// settings is a singleton every test shares: only this file changes front_page_id,
// and it puts the old value back.
//
// No admin user here: PUT /settings is admins' only, but go test runs the db/sqlc
// package alongside this one against the same database, and its last-admin tests
// (TestChangeUserRoleTxConcurrentDemotions) count every admin. The front page is set
// through the store; the handler's rules run through checkFrontPage, and its role
// and request matrix is front_page_test.go's.

func createTestPage(t *testing.T, store db.Store, owner db.User, title, slug string) db.Post {
	t.Helper()
	result, err := store.CreatePostTx(context.Background(), db.CreatePostTxParams{
		CreatePostsParams: db.CreatePostsParams{
			Title:       title,
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
			Description: "About " + title,
			UserID:      owner.ID,
			Username:    owner.Username,
			Url:         "https://example.test/" + slug,
			PostType:    "page",
			PostStatus:  "draft",
		},
		AuthorIDs: []int64{owner.ID},
	})
	require.NoError(t, err)
	return result.Post
}

func TestFrontPageFallback(t *testing.T) {
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)
	ctx := context.Background()
	suffix := lettersOnly(uuid.NewString())[:12]
	owner := postReadUser(t, store, "frontowner"+suffix, RoleEditor)
	page := createTestPage(t, store, owner, "Home "+suffix, "home-"+suffix)

	before, err := store.GetSettings(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := store.UpdateSettings(context.Background(), db.UpdateSettingsParams{SetFrontPage: true, FrontPageID: before.FrontPageID})
		require.NoError(t, err)
	})

	// What PUT /settings does with the id: checkFrontPage, then the update.
	choose := func(id *int64) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPut, "/api/v1/settings", nil)
		if id != nil && !server.checkFrontPage(c, *id) {
			return recorder
		}
		params := db.UpdateSettingsParams{SetFrontPage: true}
		if id != nil {
			params.FrontPageID = sql.NullInt64{Int64: *id, Valid: true}
		}
		_, err := store.UpdateSettings(ctx, params)
		require.NoError(t, err)
		recorder.Code = http.StatusOK
		return recorder
	}
	front := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/public/front-page", nil))
		return recorder
	}
	requireFront := func(shown bool, when string) {
		t.Helper()
		recorder := front()
		if shown {
			require.Equal(t, http.StatusOK, recorder.Code, "%s: %s", when, recorder.Body.String())
			require.Contains(t, recorder.Body.String(), page.Title, when)
			return
		}
		require.Equal(t, http.StatusNotFound, recorder.Code, "%s: %s", when, recorder.Body.String())
		require.NotContains(t, recorder.Body.String(), suffix, when)
	}
	storedFrontPage := func() int64 {
		t.Helper()
		settings, err := store.GetSettings(ctx)
		require.NoError(t, err)
		return settings.FrontPageID.Int64
	}

	// Only a published page can be chosen.
	recorder := choose(&page.ID)
	require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), "invalid_front_page")

	_, err = store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: page.ID})
	require.NoError(t, err)
	recorder = choose(&page.ID)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, page.ID, storedFrontPage())
	requireFront(true, "published")

	// Unpublished: / shows the latest posts; the setting stays, so publishing
	// again brings the page back.
	_, err = store.UnpublishPost(ctx, page.ID)
	require.NoError(t, err)
	requireFront(false, "unpublished")
	require.Equal(t, page.ID, storedFrontPage())
	_, err = store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: page.ID})
	require.NoError(t, err)
	requireFront(true, "published again")

	// Trashed: the same, until it is restored.
	_, err = store.TrashPost(ctx, page.ID)
	require.NoError(t, err)
	requireFront(false, "trashed")
	_, err = store.RestorePostFromTrash(ctx, page.ID)
	require.NoError(t, err)
	requireFront(true, "restored from the trash")

	// null: the latest posts.
	require.Equal(t, http.StatusOK, choose(nil).Code)
	requireFront(false, "cleared")
	require.Equal(t, http.StatusOK, choose(&page.ID).Code)

	// Deleted for good: the setting is cleared with it.
	_, err = store.TrashPost(ctx, page.ID)
	require.NoError(t, err)
	require.NoError(t, store.DeleteTrashedPostTx(ctx, page.ID))
	settings, err := store.GetSettings(ctx)
	require.NoError(t, err)
	require.False(t, settings.FrontPageID.Valid)
	requireFront(false, "deleted")
}

// A template chosen on a published page reaches the site on Update (#358), the
// "changes not published" flag sees it, and restoring a version brings it back.
func TestPageTemplateWaitsForUpdate(t *testing.T) {
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)
	ctx := context.Background()
	suffix := lettersOnly(uuid.NewString())[:12]
	owner := postReadUser(t, store, "templates"+suffix, RoleEditor)
	page := createTestPage(t, store, owner, "Pricing "+suffix, "pricing-"+suffix)

	publicTemplate := func() string {
		t.Helper()
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/public/posts/%d", page.ID), nil))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var view publicPostView
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
		return view.Post.PageTemplate
	}
	changed := func() bool {
		t.Helper()
		state, err := store.GetPostSettingsState(ctx, page.ID)
		require.NoError(t, err)
		return state.Changed
	}

	_, err := store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: page.ID})
	require.NoError(t, err)
	require.Equal(t, "", publicTemplate())
	require.False(t, changed())

	_, err = store.UpdatePostPageTemplate(ctx, db.UpdatePostPageTemplateParams{ID: page.ID, PageTemplate: "fullwidth"})
	require.NoError(t, err)
	require.Equal(t, "", publicTemplate(), "the site keeps the published template until Update")
	require.True(t, changed())

	_, err = store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: page.ID})
	require.NoError(t, err)
	require.Equal(t, "fullwidth", publicTemplate())
	require.False(t, changed())

	// Version 1 had the default: restoring its settings puts it back in the working copy.
	recorder := settingsRequest(t, server, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/versions/1/restore-settings", page.ID), owner)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	restored, err := store.GetPost(ctx, page.ID)
	require.NoError(t, err)
	require.Equal(t, "", restored.PageTemplate)
	require.Equal(t, "fullwidth", publicTemplate())
	require.True(t, changed())

	// The column takes template names only.
	_, err = store.UpdatePostPageTemplate(ctx, db.UpdatePostPageTemplateParams{ID: page.ID, PageTemplate: "../post/default"})
	require.Error(t, err)
}
