package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// #331 against the real database: a published post's or a term's slug change, a tag
// merge and a manual redirect answer the public lookup; categories in post URLs; the
// one-category rule and the default category through the routes.

func setURLStructure(t *testing.T, store db.Store, structure string) {
	t.Helper()
	ctx := context.Background()
	before, err := store.GetSettings(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := store.UpdateSettings(context.Background(), db.UpdateSettingsParams{
			PostUrlStructure: sql.NullString{String: before.PostUrlStructure, Valid: true},
		})
		require.NoError(t, err)
	})
	_, err = store.UpdateSettings(ctx, db.UpdateSettingsParams{PostUrlStructure: sql.NullString{String: structure, Valid: true}})
	require.NoError(t, err)
}

// publicRedirect is GET /public/redirects?path=: the target, or "" for a 404.
func publicRedirect(t *testing.T, server *Server, path string) string {
	t.Helper()
	recorder := doJSON(t, server, http.MethodGet, "/public/redirects?path="+url.QueryEscape(path), nil, nil)
	if recorder.Code == http.StatusNotFound {
		return ""
	}
	requireStatus(t, recorder, http.StatusOK)
	var body struct {
		ToPath string `json:"to_path"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return body.ToPath
}

func uniqueSuffix() string { return strings.ReplaceAll(uuid.NewString(), "-", "")[:12] }

func newCategoryDB(t *testing.T, store db.Store, name string) db.TaxonomyTerm {
	t.Helper()
	category, err := store.GetTaxonomyType(context.Background(), db.CategoryTaxonomy)
	require.NoError(t, err)
	term, err := store.CreateTaxonomyTerm(context.Background(), db.CreateTaxonomyTermParams{
		Name: name, Slug: strings.ToLower(name), TaxonomyTypeID: category.ID,
	})
	require.NoError(t, err)
	return term
}

func TestSlugChangesRedirectDB(t *testing.T) {
	_, store := scheduleTestDB(t)
	ctx := context.Background()
	admin := scheduleUser(t, store, RoleAdmin)
	editor := scheduleUser(t, store, RoleEditor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	setURLStructure(t, store, urlStructureSlug)
	s := uniqueSuffix()

	post := publishForTest(t, store, scheduleDraft(t, store, editor, "redirect"), editor)
	old := post.Slug

	// Slug URLs: /post/old → /post/new, recorded as the post's.
	requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), gin.H{"slug": "moved-" + s}), http.StatusOK)
	require.Equal(t, "/post/moved-"+s, publicRedirect(t, server, "/post/"+old))
	require.Equal(t, "/post/moved-"+s, publicRedirect(t, server, "/post/"+old+"/"), "a trailing slash is the same address")
	redirect, err := store.GetRedirectByFromPath(ctx, "/post/"+old)
	require.NoError(t, err)
	require.Equal(t, db.RedirectSourcePost, redirect.Source)
	require.Equal(t, editor.ID, redirect.CreatedBy.Int64)

	// A draft has no public URL: no redirect.
	draft := scheduleDraft(t, store, editor, "redirect")
	requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", draft.ID), gin.H{"slug": "draft-moved-" + s}), http.StatusOK)
	require.Empty(t, publicRedirect(t, server, "/post/"+draft.Slug))

	// Category URLs: the post's published category is the first segment.
	guides := newCategoryDB(t, store, "Guides"+s)
	requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/taxonomy-terms/%d", post.ID, guides.ID), nil), http.StatusOK)
	post = publishForTest(t, store, reloadPost(t, store, post.ID), editor)
	setURLStructure(t, store, urlStructureCategory)

	recorder := doJSON(t, server, http.MethodGet, fmt.Sprintf("/public/posts/%d", post.ID), nil, nil)
	requireStatus(t, recorder, http.StatusOK)
	var view struct {
		Post struct {
			CategorySlug string `json:"category_slug"`
		} `json:"post"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
	require.Equal(t, guides.Slug, view.Post.CategorySlug)

	recorder = doJSON(t, server, http.MethodGet, "/public/posts?type=post&limit=100&sort=id&order=desc", nil, nil)
	requireStatus(t, recorder, http.StatusOK)
	require.Contains(t, recorder.Body.String(), `"category_slug":"`+guides.Slug+`"`)

	requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), gin.H{"slug": "again-" + s}), http.StatusOK)
	require.Equal(t, "/"+guides.Slug+"/again-"+s, publicRedirect(t, server, "/"+guides.Slug+"/moved-"+s))

	// Renaming the category redirects its archive; the posts' old /old-category/slug
	// URLs are the web router's (it sends any /x/{post slug} to the post's URL).
	requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/taxonomy/terms/%d", guides.ID), gin.H{"slug": "tutorials-" + s}), http.StatusOK)
	require.Equal(t, "/category/tutorials-"+s, publicRedirect(t, server, "/category/"+guides.Slug))

	// A category slug can't be another route's first segment.
	recorder = as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/taxonomy/terms/%d", guides.ID), gin.H{"slug": "page"})
	requireErrorCode(t, recorder, http.StatusBadRequest, "slug_reserved")

	// Manual redirects, from the admin only; then chains collapse.
	requireStatus(t, as(t, server, editor, http.MethodPost, "/api/v1/redirects", gin.H{"from_path": "/x-" + s, "to_path": "/y"}), http.StatusForbidden)
	requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/redirects", gin.H{"from_path": "/launch-" + s, "to_path": "/post/" + old, "status_code": 302}), http.StatusCreated)
	require.Equal(t, "/post/moved-"+s, publicRedirect(t, server, "/launch-"+s), "a target that redirects is followed")
	requireErrorCode(t, as(t, server, admin, http.MethodPost, "/api/v1/redirects", gin.H{"from_path": "/launch-" + s, "to_path": "/z"}), http.StatusConflict, "redirect_exists")

	recorder = as(t, server, admin, http.MethodGet, "/api/v1/redirects?q="+url.QueryEscape("launch-"+s), nil)
	requireStatus(t, recorder, http.StatusOK)
	var list struct {
		Redirects []RedirectResponse `json:"redirects"`
		Total     int64              `json:"total"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &list))
	require.EqualValues(t, 1, list.Total)
	require.EqualValues(t, 302, list.Redirects[0].StatusCode)
	require.Equal(t, admin.Username, list.Redirects[0].CreatedBy.Username)
	requireStatus(t, as(t, server, admin, http.MethodDelete, fmt.Sprintf("/api/v1/redirects/%d", list.Redirects[0].ID), nil), http.StatusNoContent)
	require.Empty(t, publicRedirect(t, server, "/launch-"+s))
}

func TestCategoryRulesThroughRoutesDB(t *testing.T) {
	_, store := scheduleTestDB(t)
	ctx := context.Background()
	editor := scheduleUser(t, store, RoleEditor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	s := uniqueSuffix()
	category, err := store.GetTaxonomyType(ctx, db.CategoryTaxonomy)
	require.NoError(t, err)
	defaultID := category.DefaultTermID.Int64

	recorder := as(t, server, editor, http.MethodGet, "/api/v1/taxonomy/types/category", nil)
	requireStatus(t, recorder, http.StatusOK)
	require.Contains(t, recorder.Body.String(), fmt.Sprintf(`"default_term_id":%d`, defaultID))

	top, other := newCategoryDB(t, store, "Top"+s), newCategoryDB(t, store, "Other"+s)
	createTerm := func(body gin.H) *http.Response {
		return as(t, server, editor, http.MethodPost, "/api/v1/taxonomy/terms", body).Result()
	}
	require.Equal(t, http.StatusCreated, createTerm(gin.H{"name": "Child" + s, "taxonomy_type_id": category.ID, "parent_id": top.ID}).StatusCode)
	child, err := store.GetTaxonomyTermBySlug(ctx, strings.ToLower("child"+s))
	require.NoError(t, err)
	requireErrorCode(t, as(t, server, editor, http.MethodPost, "/api/v1/taxonomy/terms", gin.H{"name": "Grandchild" + s, "taxonomy_type_id": category.ID, "parent_id": child.ID}), http.StatusBadRequest, "nesting_too_deep")
	requireErrorCode(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/taxonomy/terms/%d", top.ID), gin.H{"parent_id": other.ID}), http.StatusBadRequest, "nesting_too_deep")

	// A new post: the default category; then one at a time.
	post := scheduleDraft(t, store, editor, "categories")
	categories := func() []int64 {
		ids := []int64{}
		terms, err := store.GetPostTaxonomyTerms(ctx, post.ID)
		require.NoError(t, err)
		for _, term := range terms {
			if term.TaxonomyTypeName == db.CategoryTaxonomy {
				ids = append(ids, term.ID)
			}
		}
		return ids
	}
	require.Equal(t, []int64{defaultID}, categories())
	recorder = as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/taxonomy-terms/%d", post.ID, top.ID), nil)
	requireStatus(t, recorder, http.StatusOK)
	require.Contains(t, recorder.Body.String(), fmt.Sprintf(`"replaced_term_ids":[%d]`, defaultID))
	requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/taxonomy-terms/%d", post.ID, other.ID), nil), http.StatusOK)
	require.Equal(t, []int64{other.ID}, categories())
	requireErrorCode(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), gin.H{"taxonomy_ids": []int64{top.ID, other.ID}}), http.StatusBadRequest, "one_category")
	recorder = as(t, server, editor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d/taxonomy-terms/%d", post.ID, other.ID), nil)
	requireStatus(t, recorder, http.StatusOK)
	require.Contains(t, recorder.Body.String(), fmt.Sprintf(`"default_term_id":%d`, defaultID))
	require.Equal(t, []int64{defaultID}, categories())

	// Deleting a category moves its posts to the default; the default stays.
	requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/taxonomy-terms/%d", post.ID, top.ID), nil), http.StatusOK)
	requireStatus(t, as(t, server, editor, http.MethodDelete, fmt.Sprintf("/api/v1/taxonomy/terms/%d?force=true", other.ID), nil), http.StatusOK)
	requireStatus(t, as(t, server, editor, http.MethodDelete, fmt.Sprintf("/api/v1/taxonomy/terms/%d?force=true", top.ID), nil), http.StatusOK)
	require.Equal(t, []int64{defaultID}, categories())
	requireErrorCode(t, as(t, server, editor, http.MethodDelete, fmt.Sprintf("/api/v1/taxonomy/terms/%d?force=true", defaultID), nil), http.StatusConflict, "default_term")
}

func TestMergeTagsDB(t *testing.T) {
	_, store := scheduleTestDB(t)
	ctx := context.Background()
	editor := scheduleUser(t, store, RoleEditor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	s := uniqueSuffix()
	tagType, err := store.GetTaxonomyType(ctx, "tag")
	require.NoError(t, err)
	newTag := func(name string) db.TaxonomyTerm {
		term, err := store.CreateTaxonomyTerm(ctx, db.CreateTaxonomyTermParams{Name: name + s, Slug: strings.ToLower(name) + "-" + s, TaxonomyTypeID: tagType.ID})
		require.NoError(t, err)
		return term
	}
	photos, images := newTag("Photos"), newTag("Images")
	post := scheduleDraft(t, store, editor, "merge")
	_, err = store.SetPostTermTx(ctx, db.SetPostTermTxParams{PostID: post.ID, TermID: photos.ID})
	require.NoError(t, err)
	post = publishForTest(t, store, post, editor)

	recorder := as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/taxonomy/terms/%d/merge", images.ID), gin.H{"source_ids": []int64{photos.ID}})
	requireStatus(t, recorder, http.StatusOK)
	require.Contains(t, recorder.Body.String(), `"moved_posts":1`)
	require.Equal(t, "/tag/"+images.Slug, publicRedirect(t, server, "/tag/"+photos.Slug))

	// The published post shows the kept tag at once.
	recorder = doJSON(t, server, http.MethodGet, fmt.Sprintf("/public/posts/%d", post.ID), nil, nil)
	requireStatus(t, recorder, http.StatusOK)
	require.Contains(t, recorder.Body.String(), `"slug":"`+images.Slug+`"`)
	require.NotContains(t, recorder.Body.String(), `"slug":"`+photos.Slug+`"`)
	state, err := store.GetPostSettingsState(ctx, post.ID)
	require.NoError(t, err)
	require.False(t, state.HasUnpublishedChanges)
}
