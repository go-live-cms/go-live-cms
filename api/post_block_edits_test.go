package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Per-block "Last edited by" (#328) through the real routers against the test database
// (skipped without one): the collab store writes it (internal PUT), GET
// /posts/:id/block-edits reads it with the post's read access, and it never reaches
// the public site.

// storeBlockEdits stores block_doc (paragraph blocks ids) with edits through the
// collab server's internal PUT and returns the post's new block revision.
func storeBlockEdits(t *testing.T, f commentFixture, post db.Post, base int64, ids []string, edits []map[string]any) int64 {
	t.Helper()
	blocks := map[string]any{}
	for _, id := range ids {
		blocks[id] = map[string]any{"type": "paragraph", "text": "Text of " + id}
	}
	body, err := json.Marshal(map[string]any{
		"state":         base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
		"epoch":         "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01",
		"block_doc":     map[string]any{"doc_version": 1, "blocks_order": ids, "blocks": blocks},
		"base_revision": base,
		"block_edits":   edits,
	})
	require.NoError(t, err)
	rec := internalCollabRequest(t, f.server, http.MethodPut, fmt.Sprintf("/internal/posts/%d/collab", post.ID), body, "Bearer "+testRoleLookupSecret)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var rsp struct {
		BlockRevision int64 `json:"block_revision"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rsp))
	return rsp.BlockRevision
}

func decodeBlockEdits(t *testing.T, body []byte) map[string]BlockEditResponse {
	t.Helper()
	var rsp map[string]BlockEditResponse
	require.NoError(t, json.Unmarshal(body, &rsp), string(body))
	return rsp
}

func TestPostBlockEdits_StoredAndRead(t *testing.T) {
	f := newCommentFixture(t)
	path := fmt.Sprintf("/api/v1/posts/%d/block-edits", f.published.ID)
	at := time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC)

	// Nothing stored yet: an empty object.
	rec := f.do(t, &f.editor, http.MethodGet, path, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{}`, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))

	revision := storeBlockEdits(t, f, f.published, f.published.BlockRevision, []string{"blk-edit-a01", "blk-edit-b01"}, []map[string]any{
		{"block_id": "blk-edit-a01", "user_id": f.editor.ID, "edited_at": at.Format(time.RFC3339)},
		{"block_id": "blk-edit-b01", "user_id": f.owner.ID, "edited_at": at.Add(time.Minute).Format(time.RFC3339)},
		// Not in the stored doc: left out, the store still goes through.
		{"block_id": "blk-edit-zzz", "user_id": f.owner.ID, "edited_at": at.Format(time.RFC3339)},
	})

	edits := decodeBlockEdits(t, f.do(t, &f.viewer, http.MethodGet, path, nil).Body.Bytes())
	require.Len(t, edits, 2)
	require.NotNil(t, edits["blk-edit-a01"].User)
	require.Equal(t, f.editor.ID, edits["blk-edit-a01"].User.ID)
	require.Equal(t, f.editor.FullName, edits["blk-edit-a01"].User.FullName)
	require.True(t, at.Equal(edits["blk-edit-a01"].EditedAt))
	require.Equal(t, f.owner.ID, edits["blk-edit-b01"].User.ID)

	// The next store deletes blk-edit-a01 and changes blk-edit-b01: the row of the
	// deleted block goes, and an unknown user is shown as nobody (a removed member).
	storeBlockEdits(t, f, f.published, revision, []string{"blk-edit-b01"}, []map[string]any{
		{"block_id": "blk-edit-b01", "user_id": 999999999, "edited_at": at.Add(time.Hour).Format(time.RFC3339)},
	})
	edits = decodeBlockEdits(t, f.do(t, &f.owner, http.MethodGet, path, nil).Body.Bytes())
	require.Len(t, edits, 1)
	require.Nil(t, edits["blk-edit-b01"].User)
	require.True(t, at.Add(time.Hour).Equal(edits["blk-edit-b01"].EditedAt))

	// Never on the public site: the published post's public reads don't carry it.
	for _, public := range []string{
		fmt.Sprintf("/public/posts/%d", f.published.ID),
		fmt.Sprintf("/public/posts/%d/blocks", f.published.ID),
	} {
		rec := f.do(t, nil, http.MethodGet, public, nil)
		require.NotContains(t, rec.Body.String(), "edited_at", public)
		require.NotContains(t, rec.Body.String(), "block_edits", public)
	}
}

// Reading follows canReadPost: the post's working copy rules.
func TestPostBlockEdits_ReadAccess(t *testing.T) {
	f := newCommentFixture(t)
	cases := []struct {
		name   string
		caller *db.User
		post   db.Post
		want   int
	}{
		{"anonymous", nil, f.published, http.StatusUnauthorized},
		{"admin on a draft", &f.admin, f.draft, http.StatusOK},
		{"editor on a draft", &f.editor, f.draft, http.StatusOK},
		{"owner on their draft", &f.owner, f.draft, http.StatusOK},
		{"another contributor on a draft", &f.viewer, f.draft, http.StatusForbidden},
		{"a granted contributor on a draft", &f.collaborator, f.draft, http.StatusForbidden},
		{"another contributor on a published post (view-only)", &f.viewer, f.published, http.StatusOK},
		{"a granted contributor on a published post", &f.collaborator, f.published, http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := f.do(t, c.caller, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/block-edits", c.post.ID), nil)
			require.Equal(t, c.want, rec.Code, rec.Body.String())
		})
	}
	t.Run("a missing post is 404", func(t *testing.T) {
		require.Equal(t, http.StatusNotFound, f.do(t, &f.editor, http.MethodGet, "/api/v1/posts/999999999/block-edits", nil).Code)
	})
	t.Run("a bad id is 400", func(t *testing.T) {
		require.Equal(t, http.StatusBadRequest, f.do(t, &f.editor, http.MethodGet, "/api/v1/posts/abc/block-edits", nil).Code)
	})
}
