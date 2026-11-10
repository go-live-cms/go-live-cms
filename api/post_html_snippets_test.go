package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/customhtml"
	"github.com/go-live-cms/go-live-cms/customhtml/customhtmltest"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Custom HTML (#428) against the test database (skipped without one, like
// post_reads_auth_test.go): who may write markup, what a client's document can and can't
// carry, and where the markup goes on publish, duplicate, template and restore.

type htmlFixture struct {
	postReadFixture
	admin db.User
	conn  *sql.DB
}

func newHTMLFixture(t *testing.T) htmlFixture {
	t.Helper()
	f := htmlFixture{postReadFixture: newPostReadFixture(t)}
	f.admin = postReadUser(t, f.store, "admin"+lettersOnly(uuid.NewString())[:16], RoleAdmin)
	f.conn, _ = scheduleTestDB(t)
	return f
}

func (f htmlFixture) request(t *testing.T, caller *db.User, method, path string, body any) (int, string) {
	t.Helper()
	recorder := templateRequest(t, f.server, caller, method, path, body)
	return recorder.Code, recorder.Body.String()
}

func snippetsPath(postID int64) string {
	return fmt.Sprintf("/api/v1/posts/%d/html-snippets", postID)
}

// saveSnippet creates a snippet as the admin and returns its id.
func (f htmlFixture) saveSnippet(t *testing.T, postID int64, html string) string {
	t.Helper()
	code, body := f.request(t, &f.admin, http.MethodPost, snippetsPath(postID), gin.H{"html": html})
	require.Equal(t, http.StatusCreated, code, body)
	var out struct {
		Snippet HTMLSnippetResponse `json:"snippet"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	return out.Snippet.ID
}

// writeHTMLDoc stands in for the collab server's store: a working copy with one html
// block per id, after a paragraph.
func (f htmlFixture) writeHTMLDoc(t *testing.T, postID int64, ids ...string) {
	t.Helper()
	blocks := map[string]any{"para-000001": map[string]any{"id": "para-000001", "type": "paragraph", "version": 1, "attrs": map[string]any{"text": "Intro"}}}
	order := []string{"para-000001"}
	for i, id := range ids {
		blockID := fmt.Sprintf("html-00000%d", i)
		blocks[blockID] = map[string]any{"id": blockID, "type": "html", "version": 1, "attrs": map[string]any{"snippetId": id}}
		order = append(order, blockID)
	}
	body, err := json.Marshal(map[string]any{"doc_version": 1, "blocks_order": order, "blocks": blocks})
	require.NoError(t, err)
	_, err = f.conn.Exec(`UPDATE posts SET block_doc = $2 WHERE id = $1`, postID, body)
	require.NoError(t, err)
}

func (f htmlFixture) publish(t *testing.T, postID int64) {
	t.Helper()
	_, err := f.store.PublishPostTx(context.Background(), db.PublishPostTxParams{PostID: postID, ContentMedia: publishedContentMedia})
	require.NoError(t, err)
}

// publicHTMLAttrs is the attrs of a published html block, by block id.
func publicHTMLAttrs(t *testing.T, raw []byte, blockID string) map[string]any {
	t.Helper()
	var doc struct {
		Blocks map[string]struct {
			Attrs map[string]any `json:"attrs"`
		} `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc))
	return doc.Blocks[blockID].Attrs
}

func (f htmlFixture) publicDoc(t *testing.T, postID int64) []byte {
	t.Helper()
	code, body := f.request(t, nil, http.MethodGet, fmt.Sprintf("/public/posts/%d/blocks", postID), nil)
	require.Equal(t, http.StatusOK, code, body)
	var out struct {
		Doc json.RawMessage `json:"doc"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	return out.Doc
}

func (f htmlFixture) workingRows(t *testing.T, postID int64) map[string]string {
	t.Helper()
	rows, err := f.store.ListPostHTMLSnippets(context.Background(), postID)
	require.NoError(t, err)
	out := map[string]string{}
	for _, row := range rows {
		out[row.SnippetID] = row.Html
	}
	return out
}

func (f htmlFixture) hasChanges(t *testing.T, postID int64) bool {
	t.Helper()
	changed, err := f.store.GetPostHasUnpublishedChanges(context.Background(), postID)
	require.NoError(t, err)
	return changed
}

func TestHTMLSnippetsAuthorization(t *testing.T) {
	f := newHTMLFixture(t)
	path := snippetsPath(f.draft.ID)

	t.Run("nobody but an admin writes, the post's owner and an editor included", func(t *testing.T) {
		snippet := f.saveSnippet(t, f.draft.ID, "<p>From the admin</p>")
		for _, caller := range []*db.User{&f.editor, &f.owner, &f.other} {
			code, body := f.request(t, caller, http.MethodPost, path, gin.H{"html": "<b>mine</b>"})
			require.Equal(t, http.StatusForbidden, code, body)
			code, body = f.request(t, caller, http.MethodPut, path+"/"+snippet, gin.H{"html": "<b>mine</b>"})
			require.Equal(t, http.StatusForbidden, code, body)
		}
		require.Equal(t, map[string]string{snippet: "<p>From the admin</p>"}, f.workingRows(t, f.draft.ID))
	})

	t.Run("an anonymous request gets nothing", func(t *testing.T) {
		code, _ := f.request(t, nil, http.MethodGet, path, nil)
		require.Equal(t, http.StatusUnauthorized, code)
		code, _ = f.request(t, nil, http.MethodPost, path, gin.H{"html": "x"})
		require.Equal(t, http.StatusUnauthorized, code)
	})

	t.Run("reading follows canReadPost", func(t *testing.T) {
		code, body := f.request(t, &f.owner, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, code, body)
		require.Contains(t, body, "From the admin")
		code, _ = f.request(t, &f.editor, http.MethodGet, path, nil)
		require.Equal(t, http.StatusOK, code)
		code, _ = f.request(t, &f.other, http.MethodGet, path, nil)
		require.Equal(t, http.StatusForbidden, code, "another contributor's draft")
		code, _ = f.request(t, &f.other, http.MethodGet, snippetsPath(f.published.ID), nil)
		require.Equal(t, http.StatusOK, code, "a published post")
	})

	t.Run("an admin's write answers the sanitized markup, under a server-made id", func(t *testing.T) {
		code, body := f.request(t, &f.admin, http.MethodPost, path, gin.H{"html": `<p onclick="x()">Hi</p><script>alert(1)</script>`})
		require.Equal(t, http.StatusCreated, code, body)
		var out struct {
			Snippet HTMLSnippetResponse `json:"snippet"`
		}
		require.NoError(t, json.Unmarshal([]byte(body), &out))
		require.Equal(t, "<p>Hi</p>", out.Snippet.HTML)
		require.True(t, customhtml.ValidSnippetID(out.Snippet.ID))

		code, body = f.request(t, &f.admin, http.MethodPut, path+"/"+out.Snippet.ID, gin.H{"html": `<em onmouseover="x()">Two</em>`})
		require.Equal(t, http.StatusOK, code, body)
		require.JSONEq(t, fmt.Sprintf(`{"snippet":{"id":%q,"html":"<em>Two</em>"}}`, out.Snippet.ID), body)
	})

	t.Run("a body that's missing or too long is refused", func(t *testing.T) {
		code, _ := f.request(t, &f.admin, http.MethodPost, path, gin.H{})
		require.Equal(t, http.StatusBadRequest, code)
		// A struct tag can't name the constant, so both sides of the limit are pinned here.
		code, _ = f.request(t, &f.admin, http.MethodPost, path, gin.H{"html": strings.Repeat("x", customhtml.MaxHTMLBytes)})
		require.Equal(t, http.StatusCreated, code)
		code, _ = f.request(t, &f.admin, http.MethodPost, path, gin.H{"html": strings.Repeat("x", customhtml.MaxHTMLBytes+1)})
		require.Equal(t, http.StatusBadRequest, code)
		code, _ = f.request(t, &f.admin, http.MethodPost, path, gin.H{"html": "x", "post_id": 1})
		require.Equal(t, http.StatusBadRequest, code)
	})

	t.Run("missing post, bad ids, a trashed post", func(t *testing.T) {
		code, _ := f.request(t, &f.admin, http.MethodPost, snippetsPath(1<<40), gin.H{"html": "x"})
		require.Equal(t, http.StatusNotFound, code)
		code, _ = f.request(t, &f.admin, http.MethodPut, path+"/"+uuid.NewString(), gin.H{"html": "x"})
		require.Equal(t, http.StatusNotFound, code)
		code, _ = f.request(t, &f.admin, http.MethodPut, path+"/not-a-uuid", gin.H{"html": "x"})
		require.Equal(t, http.StatusNotFound, code)
		code, _ = f.request(t, &f.admin, http.MethodPost, "/api/v1/posts/abc/html-snippets", gin.H{"html": "x"})
		require.Equal(t, http.StatusBadRequest, code)

		trashed := postReadPost(t, f.store, f.owner, "draft", "Trashed "+uuid.NewString(), "trashed-"+uuid.NewString())
		_, err := f.conn.Exec(`UPDATE posts SET post_status = 'trash', deleted_at = now(), trashed_from_status = 'draft' WHERE id = $1`, trashed.ID)
		require.NoError(t, err)
		code, body := f.request(t, &f.admin, http.MethodPost, snippetsPath(trashed.ID), gin.H{"html": "x"})
		require.Equal(t, http.StatusConflict, code, body)
	})
}

// A snippet is only ever looked up with its own post.
func TestHTMLSnippetFromAnotherPost(t *testing.T) {
	f := newHTMLFixture(t)
	foreign := f.saveSnippet(t, f.published.ID, "<p>Belongs to another post</p>")

	t.Run("can't be written through this post", func(t *testing.T) {
		code, _ := f.request(t, &f.admin, http.MethodPut, snippetsPath(f.draft.ID)+"/"+foreign, gin.H{"html": "<p>overwritten</p>"})
		require.Equal(t, http.StatusNotFound, code)
		require.Equal(t, map[string]string{foreign: "<p>Belongs to another post</p>"}, f.workingRows(t, f.published.ID))
	})

	t.Run("publishes nothing", func(t *testing.T) {
		f.writeHTMLDoc(t, f.draft.ID, foreign)
		f.publish(t, f.draft.ID)
		attrs := publicHTMLAttrs(t, f.publicDoc(t, f.draft.ID), "html-000000")
		require.Equal(t, foreign, attrs["snippetId"])
		require.NotContains(t, attrs, "html")
	})

	t.Run("isn't in the post's own list", func(t *testing.T) {
		code, body := f.request(t, &f.admin, http.MethodGet, snippetsPath(f.draft.ID), nil)
		require.Equal(t, http.StatusOK, code)
		require.JSONEq(t, `{"snippets":[]}`, body)
	})

	t.Run("a duplicate doesn't get it", func(t *testing.T) {
		code, body := f.request(t, &f.admin, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/duplicate", f.draft.ID), nil)
		require.Equal(t, http.StatusCreated, code, body)
		copied := postIDOf(t, body)
		require.Empty(t, f.workingRows(t, copied))
		post := reloadPost(t, f.store, copied)
		require.NotContains(t, string(post.BlockDoc), foreign)
	})
}

func postIDOf(t *testing.T, body string) int64 {
	t.Helper()
	var out struct {
		Post struct {
			ID int64 `json:"id"`
		} `json:"post"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	require.NotZero(t, out.Post.ID)
	return out.Post.ID
}

// An editor's client can write any block into the Yjs doc. The collab server stores what
// it derives from there through PUT /internal/posts/:id/collab, so that is where a block
// with inline markup has to die; POST /posts is the other way in.
func TestHTMLBlockFromAClientCarriesNoMarkup(t *testing.T) {
	f := newHTMLFixture(t)
	snippet := uuid.NewString()
	blockDoc := map[string]any{
		"doc_version":  1,
		"blocks_order": []string{"html-client-1"},
		"blocks": map[string]any{
			"html-client-1": map[string]any{"id": "html-client-1", "type": "html", "version": 1, "attrs": map[string]any{
				"snippetId": snippet,
				"html":      `<img src=x onerror=alert(1)>`,
				"onclick":   "alert(1)",
				"pm":        map[string]any{"type": "html", "attrs": map[string]any{"html": "<script>alert(1)</script>"}},
			}},
		},
	}

	t.Run("the collab server's store", func(t *testing.T) {
		raw, err := json.Marshal(map[string]any{
			"state":         base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
			"epoch":         uuid.NewString(),
			"block_doc":     blockDoc,
			"base_revision": reloadPost(t, f.store, f.draft.ID).BlockRevision,
		})
		require.NoError(t, err)
		recorder := internalCollabRequest(t, f.server, http.MethodPut, fmt.Sprintf("/internal/posts/%d/collab", f.draft.ID), raw, "Bearer "+testRoleLookupSecret)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

		stored := string(reloadPost(t, f.store, f.draft.ID).BlockDoc)
		require.NotContains(t, stored, "onerror")
		require.NotContains(t, stored, "script")
		require.Equal(t, map[string]any{"snippetId": snippet}, publicHTMLAttrs(t, []byte(stored), "html-client-1"))
	})

	t.Run("a new post's body, sent by an editor", func(t *testing.T) {
		slug := "client-" + lettersOnly(uuid.NewString())[:16]
		code, body := f.request(t, &f.editor, http.MethodPost, "/api/v1/posts", gin.H{
			"title": "A client post", "slug": slug, "url": "https://example.test/" + slug, "author_ids": []int64{f.editor.ID},
			"post_type": "post", "post_status": "draft", "block_doc": blockDoc, "description": "D",
		})
		require.Equal(t, http.StatusCreated, code, body)
		stored := string(reloadPost(t, f.store, postIDOf(t, body)).BlockDoc)
		require.NotContains(t, stored, "onerror")
		require.Equal(t, map[string]any{"snippetId": snippet}, publicHTMLAttrs(t, []byte(stored), "html-client-1"))
	})

	t.Run("publishing that block shows nothing: the id is no snippet of the post", func(t *testing.T) {
		f.publish(t, f.draft.ID)
		attrs := publicHTMLAttrs(t, f.publicDoc(t, f.draft.ID), "html-client-1")
		require.NotContains(t, attrs, "html")
	})

	t.Run("a bad id is dropped", func(t *testing.T) {
		for _, bad := range []any{"not-a-uuid", 12, "../" + snippet} {
			doc := BlockDocV1{DocVersion: 1, BlocksOrder: []string{"html-client-1"}, Blocks: map[string]any{
				"html-client-1": map[string]any{"id": "html-client-1", "type": "html", "version": float64(1), "attrs": map[string]any{"snippetId": bad}},
			}}
			require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
			require.Empty(t, doc.Blocks["html-client-1"].(map[string]any)["attrs"])
		}
	})
}

// Every payload, through the write route and, stored raw behind the API's back, through
// publish.
func TestHTMLSanitizedOnWriteAndOnPublish(t *testing.T) {
	f := newHTMLFixture(t)
	check := func(t *testing.T, output string, payload customhtmltest.Payload) {
		t.Helper()
		lower := strings.ToLower(output)
		for _, bad := range payload.Forbidden {
			require.NotContains(t, lower, bad, "input %q gave %q", payload.Input, output)
		}
	}
	for _, payload := range customhtmltest.XSSPayloads {
		t.Run("write "+payload.Name, func(t *testing.T) {
			code, body := f.request(t, &f.admin, http.MethodPost, snippetsPath(f.draft.ID), gin.H{"html": payload.Input})
			require.Equal(t, http.StatusCreated, code, body)
			var out struct {
				Snippet HTMLSnippetResponse `json:"snippet"`
			}
			require.NoError(t, json.Unmarshal([]byte(body), &out))
			check(t, out.Snippet.HTML, payload)
			require.Equal(t, out.Snippet.HTML, f.workingRows(t, f.draft.ID)[out.Snippet.ID])
		})
		t.Run("publish "+payload.Name, func(t *testing.T) {
			if strings.ContainsRune(payload.Input, 0) {
				t.Skip("Postgres can't store a NUL byte, so no row can hold this one")
			}
			// Older rules, or an import: raw markup in the table.
			post := postReadPost(t, f.store, f.owner, "draft", "XSS "+uuid.NewString(), "xss-"+uuid.NewString())
			id := uuid.NewString()
			_, err := f.store.CreatePostHTMLSnippet(context.Background(), db.CreatePostHTMLSnippetParams{PostID: post.ID, SnippetID: id, Html: payload.Input})
			require.NoError(t, err)
			f.writeHTMLDoc(t, post.ID, id)
			f.publish(t, post.ID)

			published := publicHTMLAttrs(t, f.publicDoc(t, post.ID), "html-000000")
			html, _ := published["html"].(string)
			check(t, html, payload)
			// The row is rewritten too, so the working copy equals what went live.
			require.Equal(t, html, f.workingRows(t, post.ID)[id])
		})
	}
}

func TestHTMLPublish(t *testing.T) {
	f := newHTMLFixture(t)
	post := f.draft
	snippet := f.saveSnippet(t, post.ID, `<dl class="office-hours"><dt>Office hours</dt></dl>`)
	unused := f.saveSnippet(t, post.ID, `<p>Never shown</p>`)
	f.writeHTMLDoc(t, post.ID, snippet)

	f.publish(t, post.ID)
	markup := `<dl class="office-hours"><dt>Office hours</dt></dl>`

	t.Run("copies the markup into the version and the published document", func(t *testing.T) {
		version, err := f.store.GetPostVersion(context.Background(), db.GetPostVersionParams{PostID: post.ID, VersionNo: 1})
		require.NoError(t, err)
		require.Equal(t, markup, publicHTMLAttrs(t, version.BlockDoc, "html-000000")["html"])
		require.Equal(t, markup, publicHTMLAttrs(t, f.publicDoc(t, post.ID), "html-000000")["html"])
	})

	t.Run("the working copy stays markup-free", func(t *testing.T) {
		require.NotContains(t, string(reloadPost(t, f.store, post.ID).BlockDoc), "office-hours")
	})

	t.Run("only what was just published counts as published", func(t *testing.T) {
		require.False(t, f.hasChanges(t, post.ID), "the copied markup alone is no change")
		rows, err := f.store.ListPostHTMLSnippets(context.Background(), post.ID)
		require.NoError(t, err)
		for _, row := range rows {
			if row.SnippetID == unused {
				require.False(t, row.PublishedHtml.Valid)
			}
		}
	})

	t.Run("the public page doesn't read the working table", func(t *testing.T) {
		code, body := f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": "<p>Edited after publish</p>"})
		require.Equal(t, http.StatusOK, code, body)
		require.Equal(t, markup, publicHTMLAttrs(t, f.publicDoc(t, post.ID), "html-000000")["html"])

		_, err := f.conn.Exec(`DELETE FROM post_html_snippets WHERE post_id = $1`, post.ID)
		require.NoError(t, err)
		require.Equal(t, markup, publicHTMLAttrs(t, f.publicDoc(t, post.ID), "html-000000")["html"])

		_, err = f.store.CreatePostHTMLSnippet(context.Background(), db.CreatePostHTMLSnippetParams{PostID: post.ID, SnippetID: snippet, Html: "<p>Edited after publish</p>"})
		require.NoError(t, err)
		require.NoError(t, f.store.SetPostHTMLSnippetPublished(context.Background(), db.SetPostHTMLSnippetPublishedParams{
			PostID: post.ID, SnippetID: snippet, PublishedHtml: sql.NullString{String: markup, Valid: true},
		}))
	})

	t.Run("an admin's edit is a change waiting for Update", func(t *testing.T) {
		require.True(t, f.hasChanges(t, post.ID))
		state, err := f.store.GetPostSettingsState(context.Background(), post.ID)
		require.NoError(t, err)
		require.True(t, state.BlocksChanged)

		f.publish(t, post.ID)
		require.False(t, f.hasChanges(t, post.ID))
		require.Equal(t, "<p>Edited after publish</p>", publicHTMLAttrs(t, f.publicDoc(t, post.ID), "html-000000")["html"])
	})

	t.Run("markup written into a block published empty is a change", func(t *testing.T) {
		empty := f.saveSnippet(t, post.ID, "")
		f.writeHTMLDoc(t, post.ID, empty)
		f.publish(t, post.ID)
		require.False(t, f.hasChanges(t, post.ID))
		code, body := f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+empty, gin.H{"html": "<p>Now it has some</p>"})
		require.Equal(t, http.StatusOK, code, body)
		require.True(t, f.hasChanges(t, post.ID))
		f.writeHTMLDoc(t, post.ID, snippet)
		f.publish(t, post.ID)
	})

	t.Run("a snippet's block taken out of the document", func(t *testing.T) {
		f.writeHTMLDoc(t, post.ID)
		f.publish(t, post.ID)
		require.False(t, f.hasChanges(t, post.ID))
		code, body := f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": "<p>Orphan</p>"})
		require.Equal(t, http.StatusOK, code, body)
		require.False(t, f.hasChanges(t, post.ID), "a row the page doesn't use is no pending change")
	})
}

// A scheduled update freezes the markup with the body (#335): an admin's later edit isn't
// included, and shows as a change waiting for the next Update.
func TestHTMLScheduledUpdate(t *testing.T) {
	f := newHTMLFixture(t)
	post := f.draft
	snippet := f.saveSnippet(t, post.ID, "<p>One</p>")
	f.writeHTMLDoc(t, post.ID, snippet)
	f.publish(t, post.ID)

	code, body := f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": "<p>Two</p>"})
	require.Equal(t, http.StatusOK, code, body)
	require.True(t, f.hasChanges(t, post.ID))
	scheduleUpdateAt(t, f.store, post.ID, f.editor, time.Now().Add(-time.Second))

	code, body = f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": "<p>Three, after scheduling</p>"})
	require.Equal(t, http.StatusOK, code, body)

	claim := claimUpdateFor(t, f.store, post.ID)
	_, err := f.store.PublishScheduledUpdateTx(context.Background(), db.PublishScheduledUpdateTxParams{PostID: post.ID, Claim: claim.Claim.Time, ContentMedia: publishedContentMedia})
	require.NoError(t, err)

	require.Equal(t, "<p>Two</p>", publicHTMLAttrs(t, f.publicDoc(t, post.ID), "html-000000")["html"])
	require.Equal(t, "<p>Three, after scheduling</p>", f.workingRows(t, post.ID)[snippet])
	require.True(t, f.hasChanges(t, post.ID))
}

func TestHTMLDuplicate(t *testing.T) {
	f := newHTMLFixture(t)
	source := f.draft
	snippet := f.saveSnippet(t, source.ID, "<p>Source</p>")
	f.writeHTMLDoc(t, source.ID, snippet, snippet)

	// A contributor may duplicate their own post: the copy's rows are the server's.
	code, body := f.request(t, &f.owner, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/duplicate", source.ID), nil)
	require.Equal(t, http.StatusCreated, code, body)
	copied := postIDOf(t, body)

	rows := f.workingRows(t, copied)
	require.Len(t, rows, 1, "the same snippet twice is one copy")
	var newID string
	for id := range rows {
		newID = id
	}
	require.NotEqual(t, snippet, newID)
	require.Equal(t, "<p>Source</p>", rows[newID])

	doc := reloadPost(t, f.store, copied).BlockDoc
	require.NotContains(t, string(doc), snippet)
	require.Contains(t, string(doc), newID)
	require.NotContains(t, string(doc), "Source", "the markup stays out of the working copy")

	code, _ = f.request(t, &f.admin, http.MethodPut, snippetsPath(copied)+"/"+newID, gin.H{"html": "<p>Copy edited</p>"})
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, "<p>Source</p>", f.workingRows(t, source.ID)[snippet], "the source keeps its own")

	f.publish(t, copied)
	var parsed BlockDocV1
	require.NoError(t, json.Unmarshal(f.publicDoc(t, copied), &parsed))
	require.Len(t, parsed.BlocksOrder, 3)
	for _, id := range parsed.BlocksOrder[1:] {
		attrs := parsed.Blocks[id].(map[string]any)["attrs"].(map[string]any)
		require.Equal(t, "<p>Copy edited</p>", attrs["html"])
	}
}

func TestHTMLTemplate(t *testing.T) {
	f := newHTMLFixture(t)
	source := f.draft
	snippet := f.saveSnippet(t, source.ID, "<p>Template markup</p>")
	foreign := f.saveSnippet(t, f.published.ID, "<p>Other post</p>")
	f.writeHTMLDoc(t, source.ID, snippet, foreign)

	name := "Tpl " + lettersOnly(uuid.NewString())[:16]
	code, body := f.request(t, &f.editor, http.MethodPost, "/api/v1/post-templates", gin.H{"post_id": source.ID, "name": name})
	require.Equal(t, http.StatusCreated, code, body)
	var saved struct {
		Template PostTemplateResponse `json:"template"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &saved))

	stored, err := f.store.GetPostTemplate(context.Background(), saved.Template.ID)
	require.NoError(t, err)
	require.Equal(t, "<p>Template markup</p>", publicHTMLAttrs(t, stored.BlockDoc, "html-000000")["html"])
	require.NotContains(t, publicHTMLAttrs(t, stored.BlockDoc, "html-000001"), "html", "another post's snippet isn't in the snapshot")

	// The source can change or go: the template is a snapshot.
	code, _ = f.request(t, &f.admin, http.MethodPut, snippetsPath(source.ID)+"/"+snippet, gin.H{"html": "<p>Later</p>"})
	require.Equal(t, http.StatusOK, code)

	code, body = f.request(t, &f.owner, http.MethodPost, fmt.Sprintf("/api/v1/post-templates/%d/posts", saved.Template.ID), nil)
	require.Equal(t, http.StatusCreated, code, body)
	made := postIDOf(t, body)

	rows := f.workingRows(t, made)
	require.Len(t, rows, 1)
	var newID string
	for id := range rows {
		newID = id
	}
	require.NotEqual(t, snippet, newID)
	require.Equal(t, "<p>Template markup</p>", rows[newID])

	doc := reloadPost(t, f.store, made).BlockDoc
	require.NotContains(t, string(doc), "Template markup")
	require.NotContains(t, string(doc), foreign)
	require.Equal(t, newID, publicHTMLAttrs(t, doc, blockIDWithSnippet(t, doc))["snippetId"])
}

func blockIDWithSnippet(t *testing.T, raw []byte) string {
	t.Helper()
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal(raw, &doc))
	for id, block := range doc.Blocks {
		attrs, _ := block.(map[string]any)["attrs"].(map[string]any)
		if attrs["snippetId"] != nil {
			return id
		}
	}
	t.Fatal("no block has a snippet id")
	return ""
}

// Restoring a version puts back the markup that version was published with.
func TestHTMLRestore(t *testing.T) {
	f := newHTMLFixture(t)
	post := f.draft
	snippet := f.saveSnippet(t, post.ID, "<p>Version one</p>")
	f.writeHTMLDoc(t, post.ID, snippet)
	f.publish(t, post.ID)

	code, body := f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": "<p>Version two</p>"})
	require.Equal(t, http.StatusOK, code, body)
	f.publish(t, post.ID)

	restore := func(t *testing.T, caller *db.User, versionNo int) {
		t.Helper()
		code, body := f.request(t, caller, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/versions/%d/restore-settings", post.ID, versionNo), nil)
		require.Equal(t, http.StatusOK, code, body)
	}

	t.Run("versions keep what they were published with", func(t *testing.T) {
		one, err := f.store.GetPostVersion(context.Background(), db.GetPostVersionParams{PostID: post.ID, VersionNo: 1})
		require.NoError(t, err)
		require.Equal(t, "<p>Version one</p>", publicHTMLAttrs(t, one.BlockDoc, "html-000000")["html"])
		two, err := f.store.GetPostVersion(context.Background(), db.GetPostVersionParams{PostID: post.ID, VersionNo: 2})
		require.NoError(t, err)
		require.Equal(t, "<p>Version two</p>", publicHTMLAttrs(t, two.BlockDoc, "html-000000")["html"])
	})

	t.Run("a snippet edited since: the version's markup replaces the edit", func(t *testing.T) {
		code, body := f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": "<p>Later edit</p>"})
		require.Equal(t, http.StatusOK, code, body)
		restore(t, &f.editor, 1)
		require.Equal(t, map[string]string{snippet: "<p>Version one</p>"}, f.workingRows(t, post.ID))
		require.Equal(t, "<p>Version two</p>", publicHTMLAttrs(t, f.publicDoc(t, post.ID), "html-000000")["html"], "nothing changes on the site until Update")
		require.True(t, f.hasChanges(t, post.ID))
	})

	t.Run("a snippet deleted since: it comes back under its id", func(t *testing.T) {
		_, err := f.conn.Exec(`DELETE FROM post_html_snippets WHERE post_id = $1`, post.ID)
		require.NoError(t, err)
		restore(t, &f.editor, 2)
		require.Equal(t, map[string]string{snippet: "<p>Version two</p>"}, f.workingRows(t, post.ID))
	})

	t.Run("the markup is sanitized when it comes back", func(t *testing.T) {
		_, err := f.conn.Exec(`UPDATE post_versions SET block_doc = jsonb_set(block_doc, '{blocks,html-000000,attrs,html}', to_jsonb('<p onclick="x()">Old</p>'::text)) WHERE post_id = $1 AND version_no = 1`, post.ID)
		require.NoError(t, err)
		restore(t, &f.admin, 1)
		require.Equal(t, map[string]string{snippet: "<p>Old</p>"}, f.workingRows(t, post.ID))
	})

	t.Run("a version published empty empties the row, and makes none for an id it never had", func(t *testing.T) {
		foreign := uuid.NewString()
		f.writeHTMLDoc(t, post.ID, snippet, foreign)
		code, body := f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": ""})
		require.Equal(t, http.StatusOK, code, body)
		f.publish(t, post.ID)
		code, body = f.request(t, &f.admin, http.MethodPut, snippetsPath(post.ID)+"/"+snippet, gin.H{"html": "<p>Written later</p>"})
		require.Equal(t, http.StatusOK, code, body)

		restore(t, &f.editor, 3)
		require.Equal(t, map[string]string{snippet: ""}, f.workingRows(t, post.ID))
	})

	t.Run("a contributor can't restore", func(t *testing.T) {
		code, _ := f.request(t, &f.owner, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/versions/1/restore-settings", post.ID), nil)
		require.Equal(t, http.StatusForbidden, code)
	})
}

func TestHTMLActivity(t *testing.T) {
	f := newHTMLFixture(t)
	f.saveSnippet(t, f.draft.ID, "<p>x</p>")
	var verb string
	require.NoError(t, f.conn.QueryRow(`SELECT verb FROM activity WHERE object_type = 'post' AND object_id = $1 AND actor_id = $2 ORDER BY id DESC LIMIT 1`, f.draft.ID, f.admin.ID).Scan(&verb))
	require.Equal(t, db.ActivityHTMLEdited, verb)
}
