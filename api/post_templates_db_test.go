package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// End to end against the test database (skipped without one, like
// post_reads_auth_test.go). An editor saves a post with a category, a featured
// image and an inline image as a template, with its settings. Saving it adds
// nothing to any list, count, search or /public read. A contributor starts a
// draft from it: the content with every block id new, the category and the
// featured image, no Yjs state, themselves as owner and byline. Then rename,
// a duplicate name, and delete, which leaves that post alone.
func TestPostTemplatesDB(t *testing.T) {
	f := newPostReadFixture(t)
	ctx := context.Background()
	v := loadDuplicateVectors(t)
	marker := "tpl" + lettersOnly(uuid.NewString())[:16]

	newMedia := func(name string) db.Medium {
		media, err := f.store.CreateMedia(ctx, db.CreateMediaParams{
			Name: name, MediaPath: f.server.config.UploadPath + "/" + name + ".jpg", UserID: f.editor.ID, MimeType: "image/jpeg",
		})
		require.NoError(t, err)
		return media
	}
	hero, inline := newMedia("hero-"+marker), newMedia("inline-"+marker)

	sourceDoc := strings.ReplaceAll(string(v.Source), `"mediaId": 42`, fmt.Sprintf(`"mediaId": %d`, inline.ID))
	require.Contains(t, sourceDoc, fmt.Sprintf(`"mediaId": %d`, inline.ID))
	created, err := f.store.CreatePostTx(ctx, db.CreatePostTxParams{
		CreatePostsParams: db.CreatePostsParams{
			Title: "Source " + marker, Slug: "source-" + marker, Description: "Excerpt " + marker,
			UserID: f.editor.ID, Username: f.editor.Username, Url: "https://example.test/" + marker,
			PostType: "post", PostStatus: "published", BlockDoc: json.RawMessage(sourceDoc),
		},
		AuthorIDs: []int64{f.editor.ID},
	})
	require.NoError(t, err)
	source := created.Post

	category, err := f.store.GetTaxonomyType(ctx, "category")
	require.NoError(t, err)
	term, err := f.store.CreateTaxonomyTerm(ctx, db.CreateTaxonomyTermParams{Name: "News " + marker, Slug: "news-" + marker, TaxonomyTypeID: category.ID})
	require.NoError(t, err)
	// Replaces the default category the new post got (#331).
	_, err = f.store.SetPostTermTx(ctx, db.SetPostTermTxParams{PostID: source.ID, TermID: term.ID})
	require.NoError(t, err)
	_, err = f.store.CreatePostMedia(ctx, db.CreatePostMediaParams{PostID: source.ID, MediaID: hero.ID, Order: 0})
	require.NoError(t, err)

	request := func(caller *db.User, method, path string, body any) (int, string) {
		recorder := templateRequest(t, f.server, caller, method, path, body)
		return recorder.Code, recorder.Body.String()
	}

	// Reads scoped to this test's own users, term and marker, so other packages'
	// tests writing posts at the same time can't change them.
	reads := []struct {
		caller *db.User
		path   string
	}{
		{&f.editor, "/api/v1/posts?author_id=" + fmt.Sprint(f.editor.ID)},
		{&f.editor, "/api/v1/posts?with_meta=true&author_id=" + fmt.Sprint(f.editor.ID)},
		{&f.editor, "/api/v1/posts/counts?user_id=" + fmt.Sprint(f.editor.ID)},
		{&f.editor, "/api/v1/posts/type/post?author_id=" + fmt.Sprint(f.editor.ID)},
		{&f.editor, fmt.Sprintf("/api/v1/posts/user/%d", f.editor.ID)},
		{&f.editor, "/api/v1/posts/search?q=" + marker},
		{&f.editor, fmt.Sprintf("/api/v1/media/%d/posts", hero.ID)},
		{&f.editor, fmt.Sprintf("/api/v1/media/%d/posts", inline.ID)},
		{nil, "/api/v1/public/search?q=" + marker},
		{nil, "/api/v1/public/taxonomies/category/terms/" + term.Slug + "/posts"},
	}
	snapshot := func() []string {
		out := make([]string, len(reads))
		for i, r := range reads {
			code, body := request(r.caller, http.MethodGet, r.path, nil)
			out[i] = fmt.Sprintf("%d %s", code, body)
		}
		return out
	}
	before := snapshot()

	// An editor saves it as a template, with its settings.
	name := "Weekly " + marker
	code, body := request(&f.editor, http.MethodPost, "/api/v1/post-templates", gin.H{"post_id": source.ID, "name": name, "with_settings": true})
	require.Equal(t, http.StatusCreated, code, body)
	var saved struct {
		Template PostTemplateResponse `json:"template"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &saved))
	tpl := saved.Template
	require.Equal(t, name, tpl.Name)
	require.Equal(t, "post", tpl.PostType)
	require.Equal(t, []PostTemplateTerm{{ID: term.ID, Name: term.Name}}, tpl.Terms)
	require.Equal(t, hero.ID, *tpl.FeaturedImageID)
	require.Equal(t, f.editor.ID, *tpl.CreatedByID)

	// Not a post: no list, count, search or public read changed, and none names it.
	after := snapshot()
	for i := range reads {
		require.Equal(t, before[i], after[i], reads[i].path)
		require.NotContains(t, after[i], name, reads[i].path)
	}

	// Without settings: no category, no image.
	code, body = request(&f.editor, http.MethodPost, "/api/v1/post-templates", gin.H{"post_id": source.ID, "name": "Bare " + marker})
	require.Equal(t, http.StatusCreated, code, body)
	require.Contains(t, body, `"terms":[]`)
	require.Contains(t, body, `"featured_image_id":null`)

	// The same name in another case is taken for this type.
	code, body = request(&f.editor, http.MethodPost, "/api/v1/post-templates", gin.H{"post_id": source.ID, "name": strings.ToUpper(name)})
	require.Equal(t, http.StatusConflict, code, body)

	// A contributor may list and use templates, not save them.
	code, body = request(&f.owner, http.MethodGet, "/api/v1/post-templates?type=post", nil)
	require.Equal(t, http.StatusOK, code, body)
	require.Contains(t, body, name)
	code, _ = request(&f.owner, http.MethodPost, "/api/v1/post-templates", gin.H{"post_id": source.ID, "name": "Mine " + marker})
	require.Equal(t, http.StatusForbidden, code)
	code, body = request(&f.owner, http.MethodGet, "/api/v1/post-templates?type=page", nil)
	require.Equal(t, http.StatusOK, code)
	require.NotContains(t, body, name, "templates are per post type")

	code, body = request(&f.owner, http.MethodPost, fmt.Sprintf("/api/v1/post-templates/%d/posts", tpl.ID), nil)
	require.Equal(t, http.StatusCreated, code, body)
	var made struct {
		Post PostResponse `json:"post"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &made))

	post, err := f.store.GetPost(ctx, made.Post.ID)
	require.NoError(t, err)
	require.Equal(t, name, post.Title)
	require.Equal(t, "post", post.PostType)
	require.Equal(t, "draft", post.PostStatus)
	require.Equal(t, f.owner.ID, post.UserID)
	require.Equal(t, "weekly-"+marker, post.Slug)
	requireRegeneratedFrom(t, json.RawMessage(sourceDoc), post.BlockDoc)

	collab, err := f.store.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.Empty(t, collab.YdocState, "no Yjs state: the collab server seeds it from block_doc")

	terms, err := f.store.GetPostTaxonomyTerms(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, terms, 1)
	require.Equal(t, term.ID, terms[0].ID)

	links, err := f.store.GetMediaByPostWithOrder(ctx, post.ID)
	require.NoError(t, err)
	orders := map[int64]int32{}
	for _, link := range links {
		orders[link.ID] = link.MediaOrder
	}
	require.Equal(t, int32(0), orders[hero.ID], "the featured image")
	require.Contains(t, orders, inline.ID, "the content image's link")
	require.Greater(t, orders[inline.ID], int32(0))
	for key, want := range map[string]string{"_thumbnail_id": fmt.Sprint(hero.ID), "_thumbnail_url": publicMediaPath(f.server.config.UploadPath, hero.MediaPath)} {
		meta, err := f.store.GetPostMetaByKey(ctx, db.GetPostMetaByKeyParams{PostID: post.ID, MetaKey: key})
		require.NoError(t, err)
		require.Equal(t, want, meta.MetaValue.String, key)
	}

	code, body = request(&f.owner, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/authors", post.ID), nil)
	require.Equal(t, http.StatusOK, code, body)
	require.Contains(t, body, fmt.Sprintf(`"id":%d`, f.owner.ID))
	require.NotContains(t, body, fmt.Sprintf(`"id":%d`, f.editor.ID), "the template's author isn't credited")

	// A second post from it: its own slug and ids.
	code, body = request(&f.editor, http.MethodPost, fmt.Sprintf("/api/v1/post-templates/%d/posts", tpl.ID), nil)
	require.Equal(t, http.StatusCreated, code, body)
	var second struct {
		Post PostResponse `json:"post"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &second))
	require.Equal(t, "weekly-"+marker+"-2", second.Post.Slug)
	other, err := f.store.GetPost(ctx, second.Post.ID)
	require.NoError(t, err)
	for _, id := range requireRegeneratedFrom(t, json.RawMessage(sourceDoc), post.BlockDoc) {
		require.NotContains(t, string(other.BlockDoc), id)
	}

	// Rename (editors only), then delete.
	code, _ = request(&f.owner, http.MethodPut, fmt.Sprintf("/api/v1/post-templates/%d", tpl.ID), gin.H{"name": "Renamed " + marker})
	require.Equal(t, http.StatusForbidden, code)
	code, body = request(&f.editor, http.MethodPut, fmt.Sprintf("/api/v1/post-templates/%d", tpl.ID), gin.H{"name": "Renamed " + marker})
	require.Equal(t, http.StatusOK, code, body)
	require.Contains(t, body, "Renamed "+marker)
	code, _ = request(&f.owner, http.MethodDelete, fmt.Sprintf("/api/v1/post-templates/%d", tpl.ID), nil)
	require.Equal(t, http.StatusForbidden, code)
	code, _ = request(&f.editor, http.MethodDelete, fmt.Sprintf("/api/v1/post-templates/%d", tpl.ID), nil)
	require.Equal(t, http.StatusNoContent, code)
	code, _ = request(&f.editor, http.MethodDelete, fmt.Sprintf("/api/v1/post-templates/%d", tpl.ID), nil)
	require.Equal(t, http.StatusNotFound, code)
	code, _ = request(&f.editor, http.MethodPost, fmt.Sprintf("/api/v1/post-templates/%d/posts", tpl.ID), nil)
	require.Equal(t, http.StatusNotFound, code)
	code, body = request(&f.editor, http.MethodGet, "/api/v1/post-templates?type=post", nil)
	require.Equal(t, http.StatusOK, code)
	require.NotContains(t, body, "Renamed "+marker)

	kept, err := f.store.GetPost(ctx, post.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(post.BlockDoc), string(kept.BlockDoc), "a post made from it keeps its content")
}

// The transactions on their own: a template whose featured image was deleted
// gives a post without one, and a failing step rolls the whole post back.
func TestCreatePostFromTemplateTxDB(t *testing.T) {
	f := newPostReadFixture(t)
	ctx := context.Background()
	marker := "tpx" + lettersOnly(uuid.NewString())[:16]

	media, err := f.store.CreateMedia(ctx, db.CreateMediaParams{Name: marker, MediaPath: "/x/" + marker + ".jpg", UserID: f.editor.ID, MimeType: "image/jpeg"})
	require.NoError(t, err)
	source := postReadPost(t, f.store, f.editor, "draft", "Src "+marker, "src-"+marker)
	_, err = f.store.CreatePostMedia(ctx, db.CreatePostMediaParams{PostID: source.ID, MediaID: media.ID, Order: 0})
	require.NoError(t, err)
	tpl, err := f.store.CreatePostTemplateTx(ctx, db.CreatePostTemplateTxParams{
		SourcePostID: source.ID, PostType: "post", Name: marker, BlockDoc: json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`),
		WithSettings: true, CreatedBy: f.editor.ID,
	})
	require.NoError(t, err)
	require.True(t, tpl.FeaturedMediaID.Valid)

	params := func(slug string) db.CreatePostFromTemplateTxParams {
		return db.CreatePostFromTemplateTxParams{
			TemplateID: tpl.ID,
			CreatePostsParams: db.CreatePostsParams{
				Title: marker, UserID: f.owner.ID, Username: f.owner.Username, Url: "/post/" + slug, PostType: "post",
				PostStatus: "draft", Slug: slug, BlockDoc: tpl.BlockDoc,
			},
		}
	}

	// The image is deleted: the template keeps its content, and a post made
	// from it has no featured image.
	require.NoError(t, f.store.DeleteMediaTx(ctx, db.DeleteMediaTxParams{MediaID: media.ID, UserID: f.editor.ID, AnyOwner: true}))
	tpl, err = f.store.GetPostTemplate(ctx, tpl.ID)
	require.NoError(t, err)
	require.False(t, tpl.FeaturedMediaID.Valid)
	post, err := f.store.CreatePostFromTemplateTx(ctx, params(marker+"-a"))
	require.NoError(t, err)
	links, err := f.store.GetMediaByPostWithOrder(ctx, post.ID)
	require.NoError(t, err)
	require.Empty(t, links)
	_, err = f.store.GetPostMetaByKey(ctx, db.GetPostMetaByKeyParams{PostID: post.ID, MetaKey: "_thumbnail_id"})
	require.Error(t, err)

	// A template deleted meanwhile: no post.
	_, err = f.store.DeletePostTemplate(ctx, tpl.ID)
	require.NoError(t, err)
	_, err = f.store.CreatePostFromTemplateTx(ctx, params(marker+"-b"))
	require.ErrorIs(t, err, sql.ErrNoRows)
	exists, err := f.store.CheckSlugExists(ctx, db.CheckSlugExistsParams{Slug: marker + "-b"})
	require.NoError(t, err)
	require.False(t, exists)
}
