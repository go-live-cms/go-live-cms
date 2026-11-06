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
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// Block comments (#192) through the real router and handlers against the test
// database (skipped without one): who may read, comment, resolve, edit and delete for
// every role, the CRUD itself, the trash, the activity events, and the nudge to the
// collab server after every write.
//
// The fixture: owner (a contributor) owns a draft and a published post; viewer is
// another contributor (view-only on the published post, nothing on the draft);
// collaborator is a contributor with an edit access grant (#321) on the published
// post; plus an editor and an admin.

type commentFixture struct {
	server *Server
	store  db.Store
	nudges *nudgeCounter

	owner, viewer, collaborator, editor, admin db.User
	draft, published                           db.Post
}

type nudgeCounter struct {
	mu    sync.Mutex
	paths []string
}

func (n *nudgeCounter) count(path string) int {
	n.mu.Lock()
	defer n.mu.Unlock()
	c := 0
	for _, p := range n.paths {
		if p == path {
			c++
		}
	}
	return c
}

func newCommentFixture(t *testing.T) commentFixture {
	t.Helper()
	store := authFlowStore(t)
	nudges := &nudgeCounter{}
	collab := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer "+testCollabInternalSecret {
			nudges.mu.Lock()
			nudges.paths = append(nudges.paths, r.URL.Path)
			nudges.mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(collab.Close)
	server := authFlowServer(t, store, func(c *util.Config) { c.CollabInternalURL = collab.URL })

	suffix := lettersOnly(uuid.NewString())[:12]
	f := commentFixture{server: server, store: store, nudges: nudges}
	f.owner = postReadUser(t, store, "cowner"+suffix, RoleContributor)
	f.viewer = postReadUser(t, store, "cviewer"+suffix, RoleContributor)
	f.collaborator = postReadUser(t, store, "ccollab"+suffix, RoleContributor)
	f.editor = postReadUser(t, store, "ceditor"+suffix, RoleEditor)
	f.admin = postReadUser(t, store, "cadmin"+suffix, RoleAdmin)
	f.draft = postReadPost(t, store, f.owner, "draft", "Comment draft "+suffix, "comment-draft-"+suffix)
	f.published = postReadPost(t, store, f.owner, "published", "Comment live "+suffix, "comment-live-"+suffix)
	require.NoError(t, store.GrantPostCollaborator(context.Background(), db.GrantPostCollaboratorParams{
		PostID: f.published.ID, UserID: f.collaborator.ID, GrantedBy: sql.NullInt64{Int64: f.owner.ID, Valid: true},
	}))
	return f
}

func (f commentFixture) do(t *testing.T, caller *db.User, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	request := httptest.NewRequest(method, path, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if caller != nil {
		addAuthorization(t, request, f.server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	f.server.router.ServeHTTP(recorder, request)
	return recorder
}

func decodeComments(t *testing.T, recorder *httptest.ResponseRecorder) CommentsResponse {
	t.Helper()
	var rsp CommentsResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp), recorder.Body.String())
	return rsp
}

// startThread starts a thread as caller and returns it (thread id, first comment id).
func (f commentFixture) startThread(t *testing.T, caller db.User, post db.Post, body string) (int64, int64) {
	t.Helper()
	rec := f.do(t, &caller, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comments", post.ID), commentJSON{"block_id": "blk-comment-" + uuid.NewString()[:8], "body": body})
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rsp := decodeComments(t, rec)
	require.NotZero(t, rsp.ThreadID)
	require.NotZero(t, rsp.CommentID)
	return rsp.ThreadID, rsp.CommentID
}

type commentJSON = map[string]any

func (f commentFixture) threadOf(t *testing.T, caller db.User, post db.Post, id int64) (CommentThreadResponse, bool) {
	t.Helper()
	rec := f.do(t, &caller, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/comments", post.ID), nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	for _, th := range decodeComments(t, rec).Threads {
		if th.ID == id {
			return th, true
		}
	}
	return CommentThreadResponse{}, false
}

func TestPostComments_ReadAndCommentFollowReadAccess(t *testing.T) {
	f := newCommentFixture(t)
	type tc struct {
		name   string
		caller *db.User
		post   db.Post
		want   int
	}
	cases := []tc{
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
			list := f.do(t, c.caller, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/comments", c.post.ID), nil)
			require.Equal(t, c.want, list.Code, list.Body.String())
			create := f.do(t, c.caller, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comments", c.post.ID), commentJSON{"block_id": "blk-matrix-000001", "body": "A note"})
			want := c.want
			if want == http.StatusOK {
				want = http.StatusCreated
			}
			require.Equal(t, want, create.Code, create.Body.String())
			if c.want == http.StatusOK {
				require.True(t, decodeComments(t, list).CanComment)
			}
		})
	}

	t.Run("a missing post is 404", func(t *testing.T) {
		require.Equal(t, http.StatusNotFound, f.do(t, &f.viewer, http.MethodGet, "/api/v1/posts/999999999/comments", nil).Code)
	})
}

func TestPostComments_ThreadLifecycle(t *testing.T) {
	f := newCommentFixture(t)
	path := func(format string, args ...any) string { return fmt.Sprintf(format, args...) }

	threadID, firstID := f.startThread(t, f.editor, f.published, "  Cite a source here?\nThanks  ")
	require.Equal(t, 1, f.nudges.count(path("/internal/documents/post-%d/comments", f.published.ID)))

	th, ok := f.threadOf(t, f.viewer, f.published, threadID)
	require.True(t, ok)
	require.Len(t, th.Comments, 1)
	require.Equal(t, "Cite a source here?\nThanks", th.Comments[0].Body, "trimmed, line breaks kept")
	require.Equal(t, f.editor.ID, th.CreatedBy.ID)
	require.Nil(t, th.ResolvedAt)
	require.False(t, th.Comments[0].CanEdit, "only the author edits")
	require.False(t, th.Comments[0].CanDelete)
	require.False(t, th.CanResolve, "a view-only contributor doesn't resolve someone else's thread")

	// Reply as the view-only contributor.
	reply := f.do(t, &f.viewer, http.MethodPost, path("/api/v1/posts/%d/comment-threads/%d/replies", f.published.ID, threadID), commentJSON{"body": "Added one"})
	require.Equal(t, http.StatusCreated, reply.Code, reply.Body.String())
	replyID := decodeComments(t, reply).CommentID

	// Edit: author only, admins included.
	require.Equal(t, http.StatusForbidden, f.do(t, &f.admin, http.MethodPut, path("/api/v1/posts/%d/comments/%d", f.published.ID, firstID), commentJSON{"body": "x"}).Code)
	edit := f.do(t, &f.editor, http.MethodPut, path("/api/v1/posts/%d/comments/%d", f.published.ID, firstID), commentJSON{"body": "Cite a source, please"})
	require.Equal(t, http.StatusOK, edit.Code, edit.Body.String())
	th, _ = f.threadOf(t, f.editor, f.published, threadID)
	require.Equal(t, "Cite a source, please", th.Comments[0].Body)
	require.NotNil(t, th.Comments[0].EditedAt)
	require.Equal(t, []string{"Cite a source, please", "Added one"}, []string{th.Comments[0].Body, th.Comments[1].Body})

	// Resolve: the view-only contributor can't; the owner (who edits the working copy) can.
	require.Equal(t, http.StatusForbidden, f.do(t, &f.viewer, http.MethodPost, path("/api/v1/posts/%d/comment-threads/%d/resolve", f.published.ID, threadID), nil).Code)
	resolve := f.do(t, &f.owner, http.MethodPost, path("/api/v1/posts/%d/comment-threads/%d/resolve", f.published.ID, threadID), nil)
	require.Equal(t, http.StatusOK, resolve.Code, resolve.Body.String())
	th, _ = f.threadOf(t, f.owner, f.published, threadID)
	require.NotNil(t, th.ResolvedAt)
	require.Equal(t, f.owner.ID, th.ResolvedBy.ID)
	// Idempotent: resolving again keeps who and when.
	again := f.do(t, &f.editor, http.MethodPost, path("/api/v1/posts/%d/comment-threads/%d/resolve", f.published.ID, threadID), nil)
	require.Equal(t, http.StatusOK, again.Code)
	th2, _ := f.threadOf(t, f.owner, f.published, threadID)
	require.Equal(t, f.owner.ID, th2.ResolvedBy.ID)
	require.Equal(t, th.ResolvedAt.Unix(), th2.ResolvedAt.Unix())

	unresolve := f.do(t, &f.collaborator, http.MethodPost, path("/api/v1/posts/%d/comment-threads/%d/unresolve", f.published.ID, threadID), nil)
	require.Equal(t, http.StatusOK, unresolve.Code, unresolve.Body.String())
	th, _ = f.threadOf(t, f.owner, f.published, threadID)
	require.Nil(t, th.ResolvedAt)
	require.Nil(t, th.ResolvedBy)

	// Delete: another contributor can't; the author can; the thread stays while a reply lives.
	require.Equal(t, http.StatusForbidden, f.do(t, &f.viewer, http.MethodDelete, path("/api/v1/posts/%d/comments/%d", f.published.ID, firstID), nil).Code)
	del := f.do(t, &f.editor, http.MethodDelete, path("/api/v1/posts/%d/comments/%d", f.published.ID, firstID), nil)
	require.Equal(t, http.StatusOK, del.Code, del.Body.String())
	th, ok = f.threadOf(t, f.editor, f.published, threadID)
	require.True(t, ok)
	require.True(t, th.Comments[0].Deleted)
	require.Empty(t, th.Comments[0].Body)
	require.False(t, th.Comments[0].CanDelete)
	// Deleting it again, or editing it, is 409.
	require.Equal(t, http.StatusConflict, f.do(t, &f.editor, http.MethodDelete, path("/api/v1/posts/%d/comments/%d", f.published.ID, firstID), nil).Code)
	require.Equal(t, http.StatusConflict, f.do(t, &f.editor, http.MethodPut, path("/api/v1/posts/%d/comments/%d", f.published.ID, firstID), commentJSON{"body": "back"}).Code)

	// An editor (moderator) deletes someone else's comment: the last live one, so the thread goes.
	modDel := f.do(t, &f.editor, http.MethodDelete, path("/api/v1/posts/%d/comments/%d", f.published.ID, replyID), nil)
	require.Equal(t, http.StatusOK, modDel.Code, modDel.Body.String())
	_, ok = f.threadOf(t, f.editor, f.published, threadID)
	require.False(t, ok, "a thread with no live comment is deleted")
	require.Equal(t, http.StatusNotFound, f.do(t, &f.viewer, http.MethodPost, path("/api/v1/posts/%d/comment-threads/%d/replies", f.published.ID, threadID), commentJSON{"body": "late"}).Code)

	// Every write nudged the collab server (create, reply, edit, resolve, unresolve, two deletes; the
	// second resolve changed nothing and nudged nobody).
	require.Equal(t, 7, f.nudges.count(path("/internal/documents/post-%d/comments", f.published.ID)))

	// The activity log: commented (twice), resolved, reopened, two deletions. Ids only.
	events, err := f.store.ListActivity(context.Background(), db.ListActivityParams{
		ObjectType: sql.NullString{String: db.ActivityObjectPost, Valid: true},
		ObjectID:   sql.NullInt64{Int64: f.published.ID, Valid: true},
		IsAdmin:    true, IsModerator: true, RowLimit: 50,
	})
	require.NoError(t, err)
	verbs := []string{}
	for _, e := range events {
		verbs = append(verbs, e.Verb)
		require.NotContains(t, string(e.Payload), "source", "no comment text in the log")
	}
	require.ElementsMatch(t, []string{
		db.ActivityCommented, db.ActivityCommented, db.ActivityCommentResolved, db.ActivityCommentReopened,
		db.ActivityCommentDeleted, db.ActivityCommentDeleted,
	}, verbs)
}

func TestPostComments_ResolveRules(t *testing.T) {
	f := newCommentFixture(t)
	resolve := func(caller db.User, post db.Post, threadID int64) int {
		return f.do(t, &caller, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comment-threads/%d/resolve", post.ID, threadID), nil).Code
	}
	unresolve := func(caller db.User, post db.Post, threadID int64) {
		require.Equal(t, http.StatusOK, f.do(t, &f.admin, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comment-threads/%d/unresolve", post.ID, threadID), nil).Code)
	}
	byEditor, _ := f.startThread(t, f.editor, f.published, "From the editor")
	byViewer, _ := f.startThread(t, f.viewer, f.published, "From the viewer")
	onDraft, _ := f.startThread(t, f.editor, f.draft, "On the draft")

	for _, c := range []struct {
		name   string
		caller db.User
		post   db.Post
		thread int64
		want   int
	}{
		{"admin", f.admin, f.published, byEditor, http.StatusOK},
		{"editor", f.editor, f.published, byViewer, http.StatusOK},
		{"owner (edits the working copy)", f.owner, f.published, byEditor, http.StatusOK},
		{"granted collaborator", f.collaborator, f.published, byEditor, http.StatusOK},
		{"view-only contributor, someone else's thread", f.viewer, f.published, byEditor, http.StatusForbidden},
		{"view-only contributor, their own thread", f.viewer, f.published, byViewer, http.StatusOK},
		{"contributor owner on their draft", f.owner, f.draft, onDraft, http.StatusOK},
		{"another contributor on a draft", f.viewer, f.draft, onDraft, http.StatusForbidden},
	} {
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, resolve(c.caller, c.post, c.thread))
			if c.want == http.StatusOK {
				unresolve(c.caller, c.post, c.thread)
			}
		})
	}

	t.Run("a thread of another post is 404", func(t *testing.T) {
		require.Equal(t, http.StatusNotFound, resolve(f.admin, f.published, onDraft))
		require.Equal(t, http.StatusNotFound, f.do(t, &f.admin, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comment-threads/%d/replies", f.published.ID, onDraft), commentJSON{"body": "x"}).Code)
	})

	t.Run("the response says who may resolve", func(t *testing.T) {
		th, _ := f.threadOf(t, f.viewer, f.published, byEditor)
		require.False(t, th.CanResolve)
		th, _ = f.threadOf(t, f.viewer, f.published, byViewer)
		require.True(t, th.CanResolve)
		th, _ = f.threadOf(t, f.collaborator, f.published, byEditor)
		require.True(t, th.CanResolve)
	})
}

func TestPostComments_Validation(t *testing.T) {
	f := newCommentFixture(t)
	create := func(body any) *httptest.ResponseRecorder {
		return f.do(t, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comments", f.draft.ID), body)
	}
	for name, body := range map[string]any{
		"blank body":         commentJSON{"block_id": "blk-valid-000001", "body": "   \n "},
		"long body":          commentJSON{"block_id": "blk-valid-000001", "body": strings.Repeat("a", commentBodyMax+1)},
		"NUL in body":        commentJSON{"block_id": "blk-valid-000001", "body": "a\x00b"},
		"short block id":     commentJSON{"block_id": "short", "body": "x"},
		"block id w/ space":  commentJSON{"block_id": "blk with spaces", "body": "x"},
		"missing block id":   commentJSON{"body": "x"},
		"unknown field":      commentJSON{"block_id": "blk-valid-000001", "body": "x", "thread": 1},
		"missing body field": commentJSON{"block_id": "blk-valid-000001"},
	} {
		t.Run(name, func(t *testing.T) {
			rec := create(body)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
		})
	}
	t.Run("the longest body and an emoji body pass", func(t *testing.T) {
		require.Equal(t, http.StatusCreated, create(commentJSON{"block_id": "blk-valid-000001", "body": strings.Repeat("😀", commentBodyMax)}).Code)
	})
	t.Run("bad ids", func(t *testing.T) {
		require.Equal(t, http.StatusBadRequest, f.do(t, &f.editor, http.MethodGet, "/api/v1/posts/abc/comments", nil).Code)
		require.Equal(t, http.StatusBadRequest, f.do(t, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/comments/0", f.draft.ID), commentJSON{"body": "x"}).Code)
		require.Equal(t, http.StatusBadRequest, f.do(t, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comment-threads/x/resolve", f.draft.ID), nil).Code)
		require.Equal(t, http.StatusNotFound, f.do(t, &f.editor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d/comments/999999999", f.draft.ID), nil).Code)
	})
}

func TestPostComments_TrashedPostIsReadOnly(t *testing.T) {
	f := newCommentFixture(t)
	threadID, commentID := f.startThread(t, f.owner, f.draft, "Before the trash")
	_, err := f.store.TrashPost(context.Background(), f.draft.ID)
	require.NoError(t, err)

	list := f.do(t, &f.owner, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/comments", f.draft.ID), nil)
	require.Equal(t, http.StatusOK, list.Code)
	rsp := decodeComments(t, list)
	require.False(t, rsp.CanComment)
	require.Len(t, rsp.Threads, 1)
	require.False(t, rsp.Threads[0].CanResolve)
	require.False(t, rsp.Threads[0].Comments[0].CanEdit)

	for _, req := range []struct{ method, path string }{
		{http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comments", f.draft.ID)},
		{http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comment-threads/%d/replies", f.draft.ID, threadID)},
		{http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comment-threads/%d/resolve", f.draft.ID, threadID)},
		{http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/comments/%d", f.draft.ID, commentID)},
		{http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d/comments/%d", f.draft.ID, commentID)},
	} {
		for _, caller := range []db.User{f.owner, f.admin} {
			rec := f.do(t, &caller, req.method, req.path, commentJSON{"block_id": "blk-valid-000001", "body": "x"})
			if req.method == http.MethodPost && strings.HasSuffix(req.path, "/resolve") {
				rec = f.do(t, &caller, req.method, req.path, nil)
			}
			require.Equal(t, http.StatusConflict, rec.Code, "%s %s as %s: %s", req.method, req.path, caller.Role, rec.Body.String())
			require.Contains(t, rec.Body.String(), "post_trashed")
		}
	}
}

func TestPostComments_NotPublicAndNotCopied(t *testing.T) {
	f := newCommentFixture(t)
	f.startThread(t, f.editor, f.published, "Internal note "+f.published.Slug)

	// No /public route serves them, and the published post's public reads don't carry them.
	for _, path := range []string{
		fmt.Sprintf("/public/posts/%d", f.published.ID),
		fmt.Sprintf("/public/posts/%d/blocks", f.published.ID),
	} {
		rec := f.do(t, nil, http.MethodGet, path, nil)
		require.NotContains(t, rec.Body.String(), "Internal note", path)
	}
	for _, route := range f.server.router.Routes() {
		if strings.HasPrefix(route.Path, "/public") {
			require.NotContains(t, route.Path, "comment", route.Path)
		}
	}

	// A duplicate starts with no threads (its block ids are new anyway).
	dup := f.do(t, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/duplicate", f.published.ID), nil)
	require.Equal(t, http.StatusCreated, dup.Code, dup.Body.String())
	var copied struct {
		Post struct {
			ID int64 `json:"id"`
		} `json:"post"`
	}
	require.NoError(t, json.Unmarshal(dup.Body.Bytes(), &copied))
	require.NotZero(t, copied.Post.ID)
	list := f.do(t, &f.editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/comments", copied.Post.ID), nil)
	require.Equal(t, http.StatusOK, list.Code)
	require.Empty(t, decodeComments(t, list).Threads)
}

func TestDeletePostCommentTx_RacingLastDeletes(t *testing.T) {
	f := newCommentFixture(t)
	threadID, first := f.startThread(t, f.editor, f.published, "one")
	rec := f.do(t, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/comment-threads/%d/replies", f.published.ID, threadID), commentJSON{"body": "two"})
	require.Equal(t, http.StatusCreated, rec.Code)
	second := decodeComments(t, rec).CommentID

	// Both deletes at once: the thread lock serializes them, so the thread can't be left
	// behind with no live comment.
	var wg sync.WaitGroup
	results := make([]db.DeletePostCommentTxResult, 2)
	errs := make([]error, 2)
	for i, id := range []int64{first, second} {
		wg.Add(1)
		go func(i int, id int64) {
			defer wg.Done()
			results[i], errs[i] = f.store.DeletePostCommentTx(context.Background(), id, threadID)
		}(i, id)
	}
	wg.Wait()
	require.NoError(t, errs[0])
	require.NoError(t, errs[1])
	require.True(t, results[0].ThreadDeleted != results[1].ThreadDeleted, "exactly one delete removes the thread")
	_, err := f.store.GetPostCommentThread(context.Background(), threadID)
	require.ErrorIs(t, err, sql.ErrNoRows)

	_, err = f.store.DeletePostCommentTx(context.Background(), first, threadID)
	require.ErrorIs(t, err, sql.ErrNoRows, "the thread is gone")
}
