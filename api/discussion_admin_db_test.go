package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Discussion in the admin (#526, discussion_admin.go) against the test database: who
// may moderate, every status action and its verb, bulk actions answering per comment,
// Approve and reply, members' badges, commenters' pages with Block, Home's Needs
// attention and the activity feed. Each test asserts on its own rows only.

type moderationFixture struct {
	commentsFixture
	contributor db.User
}

func newModerationFixture(t *testing.T) moderationFixture {
	t.Helper()
	f := moderationFixture{commentsFixture: newCommentsFixture(t)}
	f.contributor = scheduleUser(t, f.store, RoleContributor)
	return f
}

func (f moderationFixture) call(t *testing.T, caller *db.User, method, path string, body any) (int, map[string]any) {
	t.Helper()
	recorder := trashCall(t, f.server, caller, method, path, body)
	var out map[string]any
	if recorder.Body.Len() > 0 {
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &out), recorder.Body.String())
	}
	return recorder.Code, out
}

func (f moderationFixture) queue(t *testing.T, caller *db.User, query string) ([]ModerationComment, discussionCounts) {
	t.Helper()
	recorder := trashCall(t, f.server, caller, http.MethodGet, "/api/v1/discussion/comments?"+query, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body struct {
		Comments []ModerationComment `json:"comments"`
		Counts   discussionCounts    `json:"counts"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return body.Comments, body.Counts
}

func (f moderationFixture) verbs(t *testing.T, objectType string, objectID int64) []string {
	t.Helper()
	rows, err := f.conn.Query(`SELECT verb FROM activity WHERE object_type = $1 AND object_id = $2 ORDER BY id`, objectType, objectID)
	require.NoError(t, err)
	defer rows.Close()
	var verbs []string
	for rows.Next() {
		var v string
		require.NoError(t, rows.Scan(&v))
		verbs = append(verbs, v)
	}
	return verbs
}

func commentIDs(comments []ModerationComment) []int64 {
	ids := make([]int64, len(comments))
	for i, c := range comments {
		ids[i] = c.ID
	}
	return ids
}

// Contributors have no Discussion (decision 3): 403 on every route; anonymous 401.
func TestDiscussionRoutesAreModeratorsOnly(t *testing.T) {
	f := newModerationFixture(t)
	post := f.publishedPost(t)
	comment := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)
	routes := []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/v1/discussion/comments", nil},
		{http.MethodGet, "/api/v1/discussion/counts", nil},
		{http.MethodGet, fmt.Sprintf("/api/v1/discussion/comments/%d/thread", comment.ID), nil},
		{http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", comment.ID), map[string]any{"action": "approve"}},
		{http.MethodPost, "/api/v1/discussion/comments/bulk", map[string]any{"action": "approve", "ids": []int64{comment.ID}}},
		{http.MethodDelete, fmt.Sprintf("/api/v1/discussion/comments/%d", comment.ID), nil},
		{http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d", comment.ID), map[string]any{"body": "Hello there"}},
		{http.MethodPost, fmt.Sprintf("/api/v1/discussion/posts/%d/comments", post.ID), map[string]any{"body": "Hello there"}},
		{http.MethodGet, "/api/v1/discussion/commenters?email=a@b.test", nil},
		{http.MethodGet, fmt.Sprintf("/api/v1/discussion/commenters/%d", comment.CommenterID.Int64), nil},
		{http.MethodPut, fmt.Sprintf("/api/v1/discussion/commenters/%d/block", comment.CommenterID.Int64), map[string]any{"blocked": true}},
	}
	for _, r := range routes {
		code, _ := f.call(t, &f.contributor, r.method, r.path, r.body)
		require.Equal(t, http.StatusForbidden, code, "%s %s", r.method, r.path)
		code, _ = f.call(t, nil, r.method, r.path, r.body)
		require.Equal(t, http.StatusUnauthorized, code, "%s %s", r.method, r.path)
	}
	require.Equal(t, db.ReaderCommentPending, f.reload(t, comment.ID).Status, "nothing a contributor sent applied")
	require.Equal(t, int64(0), f.reload(t, comment.ID).ModeratedBy.Int64)

	code, _ := f.call(t, &f.editor, http.MethodGet, "/api/v1/discussion/comments", nil)
	require.Equal(t, http.StatusOK, code)
	code, _ = f.call(t, &f.admin, http.MethodGet, "/api/v1/discussion/counts", nil)
	require.Equal(t, http.StatusOK, code)
}

// The queue: a status tab, newest first, the address for moderators, "New commenter",
// the post filter and counts that follow it, the search.
func TestDiscussionQueue(t *testing.T) {
	f := newModerationFixture(t)
	post := f.publishedPost(t)
	other := f.publishedPost(t)
	ana := f.commenter(t)
	first := f.comment(t, post, ana, nil, db.ReaderCommentPending)
	second := f.comment(t, post, ana, nil, db.ReaderCommentPending)
	elsewhere := f.comment(t, other, f.commenter(t), nil, db.ReaderCommentPending)
	approved := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentApproved)
	f.comment(t, post, ana, nil, db.ReaderCommentUnconfirmed)

	comments, counts := f.queue(t, &f.editor, fmt.Sprintf("status=pending&post_id=%d", post.ID))
	require.Equal(t, []int64{second.ID, first.ID}, commentIDs(comments), "newest first, unconfirmed never listed")
	require.Equal(t, discussionCounts{Pending: 2, Approved: 1}, counts, "the counts follow the filter")
	require.NotNil(t, comments[0].Commenter)
	require.Equal(t, ana.Email, comments[0].Commenter.Email, "moderators see the address in full (decision 6)")
	require.True(t, comments[0].Commenter.New, "nothing of Ana's is approved")
	require.Equal(t, post.ID, comments[0].Post.ID)
	require.Equal(t, postStatusPublished, comments[0].Post.Status)
	require.NotEmpty(t, comments[0].Post.URL)

	comments, _ = f.queue(t, &f.editor, fmt.Sprintf("status=approved&post_id=%d", post.ID))
	require.Equal(t, []int64{approved.ID}, commentIDs(comments))
	require.False(t, comments[0].Commenter.New)

	comments, counts = f.queue(t, &f.editor, fmt.Sprintf("status=pending&commenter_id=%d", ana.ID))
	require.Equal(t, []int64{second.ID, first.ID}, commentIDs(comments))
	require.Equal(t, int64(2), counts.Pending)

	// The search: part of the text, wildcards taken literally.
	word := first.Body[len(first.Body)-12:]
	comments, _ = f.queue(t, &f.editor, "status=pending&q="+word)
	require.Equal(t, []int64{first.ID}, commentIDs(comments))
	comments, _ = f.queue(t, &f.editor, fmt.Sprintf("status=pending&post_id=%d&q=%%25", post.ID))
	require.Empty(t, comments, "a % is a character, not a wildcard")

	// The other post is there without the filter.
	comments, _ = f.queue(t, &f.editor, "status=pending&limit=100")
	require.Contains(t, commentIDs(comments), elsewhere.ID)

	code, _ := f.call(t, &f.editor, http.MethodGet, "/api/v1/discussion/comments?status=unconfirmed", nil)
	require.Equal(t, http.StatusBadRequest, code)
}

// Each action moves the comment where 4.1 says, records its verb (15.2) and refuses a
// comment that isn't where it applies.
func TestDiscussionStatusActions(t *testing.T) {
	f := newModerationFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	ana := f.commenter(t)
	comment := f.comment(t, post, ana, nil, db.ReaderCommentPending)
	path := fmt.Sprintf("/api/v1/discussion/comments/%d/status", comment.ID)

	steps := []struct {
		action, status, verb string
	}{
		{"approve", db.ReaderCommentApproved, db.ActivityReaderCommentApproved},
		{"unapprove", db.ReaderCommentPending, db.ActivityReaderCommentUnapproved},
		{"spam", db.ReaderCommentSpam, db.ActivityReaderCommentSpammed},
		{"not_spam", db.ReaderCommentPending, db.ActivityReaderCommentNotSpam},
		{"trash", db.ReaderCommentTrash, db.ActivityReaderCommentTrashed},
		{"restore", db.ReaderCommentPending, db.ActivityReaderCommentRestored},
	}
	var want []string
	for _, step := range steps {
		code, body := f.call(t, &f.editor, http.MethodPut, path, map[string]any{"action": step.action})
		require.Equal(t, http.StatusOK, code, "%s: %v", step.action, body)
		require.Equal(t, step.status, body["comment"].(map[string]any)["status"], step.action)
		got := f.reload(t, comment.ID)
		require.Equal(t, step.status, got.Status, step.action)
		require.Equal(t, f.editor.ID, got.ModeratedBy.Int64, step.action)
		want = append(want, step.verb)
		require.Equal(t, want, f.verbs(t, db.ActivityObjectReaderComment, comment.ID), step.action)
		switch step.action {
		case "spam":
			require.Equal(t, db.ReaderCommentRouteModerator, got.HeldReason.String, "a moderator's mark is the moderator route (16.1)")
			commenter, err := f.store.GetCommenter(ctx, ana.ID)
			require.NoError(t, err)
			require.True(t, commenter.LastSpamAt.Valid, "a moderator's Spam holds the commenter (4.2)")
		case "not_spam":
			require.Equal(t, db.ReaderCommentHeldPreviousSpam, got.HeldReason.String, "never its old spam route (16.1)")
		case "approve":
			require.False(t, got.HeldReason.Valid)
			require.True(t, got.ApprovedAt.Valid)
		}
	}
	var payload json.RawMessage
	require.NoError(t, f.conn.QueryRow(`SELECT payload FROM activity WHERE object_type = 'reader_comment' AND object_id = $1 ORDER BY id DESC LIMIT 1`, comment.ID).Scan(&payload))
	require.JSONEq(t, fmt.Sprintf(`{"post_id":%d}`, post.ID), string(payload), "ids only")

	// Not where the action applies: 409, nothing recorded.
	for _, action := range []string{"unapprove", "not_spam", "restore"} {
		code, body := f.call(t, &f.editor, http.MethodPut, path, map[string]any{"action": action})
		require.Equal(t, http.StatusConflict, code, action)
		require.Equal(t, "comment_status_changed", body["code"])
	}
	require.Len(t, f.verbs(t, db.ActivityObjectReaderComment, comment.ID), len(steps))

	code, _ := f.call(t, &f.editor, http.MethodPut, path, map[string]any{"action": "publish"})
	require.Equal(t, http.StatusBadRequest, code)
	code, _ = f.call(t, &f.editor, http.MethodPut, "/api/v1/discussion/comments/999999999999/status", map[string]any{"action": "approve"})
	require.Equal(t, http.StatusNotFound, code)
	unconfirmed := f.comment(t, post, ana, nil, db.ReaderCommentUnconfirmed)
	code, _ = f.call(t, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", unconfirmed.ID), map[string]any{"action": "approve"})
	require.Equal(t, http.StatusNotFound, code, "unconfirmed comments aren't moderated")

	// Delete permanently: spam and trash only; with approved replies it's a tombstone.
	code, _ = f.call(t, &f.editor, http.MethodDelete, fmt.Sprintf("/api/v1/discussion/comments/%d", comment.ID), nil)
	require.Equal(t, http.StatusConflict, code, "pending isn't deleted permanently")
	root := f.comment(t, post, ana, nil, db.ReaderCommentApproved)
	f.comment(t, post, f.commenter(t), &root, db.ReaderCommentApproved)
	code, _ = f.call(t, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", root.ID), map[string]any{"action": "trash"})
	require.Equal(t, http.StatusOK, code)
	code, _ = f.call(t, &f.editor, http.MethodDelete, fmt.Sprintf("/api/v1/discussion/comments/%d", root.ID), nil)
	require.Equal(t, http.StatusNoContent, code)
	requireTombstone(t, f.reload(t, root.ID))
	require.NoError(t, f.conn.QueryRow(`SELECT payload FROM activity WHERE verb = $1 AND object_id = $2`, db.ActivityReaderCommentDeleted, root.ID).Scan(&payload))
	require.JSONEq(t, fmt.Sprintf(`{"post_id":%d,"status":"trash"}`, post.ID), string(payload))
	code, _ = f.call(t, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", root.ID), map[string]any{"action": "unapprove"})
	require.Equal(t, http.StatusConflict, code, "a tombstone isn't moderated")
}

// Bulk actions answer per comment, keep going past a failure, and record one event.
func TestDiscussionBulkActions(t *testing.T) {
	f := newModerationFixture(t)
	post := f.publishedPost(t)
	a := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)
	b := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)
	gone := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)
	_, err := f.store.DeleteReaderCommentTx(context.Background(), gone.ID)
	require.NoError(t, err)
	spam := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentSpam)

	recorder := trashCall(t, f.server, &f.editor, http.MethodPost, "/api/v1/discussion/comments/bulk",
		map[string]any{"action": "approve", "ids": []int64{a.ID, gone.ID, b.ID, a.ID, spam.ID}})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var answer struct {
		Results   []BulkReaderCommentResult `json:"results"`
		Succeeded int                       `json:"succeeded"`
		Failed    int                       `json:"failed"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &answer))
	require.Equal(t, 2, answer.Succeeded)
	require.Equal(t, 2, answer.Failed)
	require.Equal(t, []BulkReaderCommentResult{
		{ID: a.ID, OK: true, CommentStatus: db.ReaderCommentApproved},
		{ID: gone.ID, Status: http.StatusNotFound, Code: "comment_not_found", Error: "comment not found"},
		{ID: b.ID, OK: true, CommentStatus: db.ReaderCommentApproved},
		{ID: spam.ID, Status: http.StatusConflict, Code: "comment_status_changed", Error: "the comment isn't where this action applies any more"},
	}, answer.Results)
	require.Equal(t, db.ReaderCommentSpam, f.reload(t, spam.ID).Status)

	var payload json.RawMessage
	require.NoError(t, f.conn.QueryRow(`SELECT payload FROM activity WHERE verb = $1 AND object_id = $2 ORDER BY id DESC LIMIT 1`,
		db.ActivityReaderCommentsBulkModerated, post.ID).Scan(&payload))
	require.JSONEq(t, fmt.Sprintf(`{"action":"approve","count":2,"post_id":%d}`, post.ID), string(payload))

	recorder = trashCall(t, f.server, &f.editor, http.MethodPost, "/api/v1/discussion/comments/bulk",
		map[string]any{"action": "delete", "ids": []int64{spam.ID, a.ID}})
	require.Equal(t, http.StatusOK, recorder.Code)
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &answer))
	require.True(t, answer.Results[0].OK)
	require.False(t, answer.Results[1].OK, "an approved comment goes to the trash first")
	require.False(t, f.exists(t, spam.ID))
	require.True(t, f.exists(t, a.ID))

	recorder = trashCall(t, f.server, &f.editor, http.MethodPost, "/api/v1/discussion/comments/bulk", map[string]any{"action": "approve", "ids": []int64{}})
	require.Equal(t, http.StatusBadRequest, recorder.Code)
}

// Replying to a pending comment approves it first (4.4); a member's reply is approved,
// posted as them, with its badge: Author on the published byline, else Staff; a removed
// member's keeps the name and loses the badge (3.4). Members edit their own only.
func TestDiscussionMemberReplies(t *testing.T) {
	f := newModerationFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t) // the editor is on its published byline
	pending := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)
	path := fmt.Sprintf("/api/v1/discussion/posts/%d/comments", post.ID)

	code, body := f.call(t, &f.editor, http.MethodPost, path, map[string]any{"body": "Thanks, that helps.", "parent_id": pending.ID})
	require.Equal(t, http.StatusCreated, code, body)
	require.Equal(t, true, body["parent_approved"])
	reply := body["comment"].(map[string]any)
	require.Equal(t, db.ReaderCommentApproved, reply["status"])
	require.Equal(t, "author", reply["badge"])
	require.Equal(t, "Schedule Tester", reply["name"])
	replyID := int64(reply["id"].(float64))
	require.Equal(t, db.ReaderCommentApproved, f.reload(t, pending.ID).Status, "approved first")
	require.Equal(t, []string{db.ActivityReaderCommentApproved}, f.verbs(t, db.ActivityObjectReaderComment, pending.ID))
	require.Equal(t, []string{db.ActivityReaderCommentPosted}, f.verbs(t, db.ActivityObjectReaderComment, replyID))
	stored := f.reload(t, replyID)
	require.Equal(t, pending.ID, stored.RootID.Int64)
	require.Equal(t, f.editor.ID, stored.AuthorUserID.Int64)
	require.False(t, stored.CommenterID.Valid)

	// Another editor, not on the byline: Staff. Then removed: the name stays, no badge.
	staff := scheduleUser(t, f.store, RoleEditor)
	code, body = f.call(t, &staff, http.MethodPost, path, map[string]any{"body": "A top-level note from staff."})
	require.Equal(t, http.StatusCreated, code, body)
	staffComment := body["comment"].(map[string]any)
	require.Equal(t, "staff", staffComment["badge"])
	require.Equal(t, false, body["parent_approved"])
	staffID := int64(staffComment["id"].(float64))
	require.NoError(t, f.store.DeleteUser(ctx, staff.ID))
	code, body = f.call(t, &f.editor, http.MethodGet, fmt.Sprintf("/api/v1/discussion/comments/%d/thread", staffID), nil)
	require.Equal(t, http.StatusOK, code, body)
	removed := body["comment"].(map[string]any)
	require.Nil(t, removed["badge"], "a removed member's comment loses its badge")
	require.Equal(t, "Schedule Tester", removed["name"], "and keeps the name it was posted with")
	public := f.read(t, commentsPath(post, ""))
	require.Equal(t, http.StatusOK, public.Code)
	require.NotContains(t, public.Body.String(), `"badge":"staff"`)
	require.Contains(t, public.Body.String(), `"badge":"author"`)

	// Edit: one's own only.
	editPath := fmt.Sprintf("/api/v1/discussion/comments/%d", replyID)
	code, body = f.call(t, &f.admin, http.MethodPut, editPath, map[string]any{"body": "Edited by someone else"})
	require.Equal(t, http.StatusForbidden, code, body)
	require.Equal(t, "not_your_comment", body["code"])
	code, _ = f.call(t, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d", pending.ID), map[string]any{"body": "Words in a reader's mouth"})
	require.Equal(t, http.StatusForbidden, code, "moderators never edit a reader's text (decision 9)")
	code, body = f.call(t, &f.editor, http.MethodPut, editPath, map[string]any{"body": "Thanks, that helps a lot."})
	require.Equal(t, http.StatusOK, code, body)
	require.Equal(t, true, body["comment"].(map[string]any)["edited"])
	require.Equal(t, "Thanks, that helps a lot.", f.reload(t, replyID).Body)
	require.Equal(t, []string{db.ActivityReaderCommentPosted, db.ActivityReaderCommentEdited}, f.verbs(t, db.ActivityObjectReaderComment, replyID))

	// Refusals: a reply under spam, a text the rules refuse, comments off.
	spam := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentSpam)
	code, body = f.call(t, &f.editor, http.MethodPost, path, map[string]any{"body": "Under spam", "parent_id": spam.ID})
	require.Equal(t, http.StatusNotFound, code)
	require.Equal(t, "parent_not_found", body["code"])
	otherPost := f.publishedPost(t)
	code, _ = f.call(t, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/discussion/posts/%d/comments", otherPost.ID), map[string]any{"body": "Wrong post", "parent_id": pending.ID})
	require.Equal(t, http.StatusNotFound, code)
	code, body = f.call(t, &f.editor, http.MethodPost, path, map[string]any{"body": "x"})
	require.Equal(t, http.StatusBadRequest, code)
	require.Equal(t, readerCommentBodyTooShort, body["code"])
	f.settings(t, map[string]any{"comments_enabled": false})
	code, body = f.call(t, &f.editor, http.MethodPost, path, map[string]any{"body": "While off"})
	require.Equal(t, http.StatusConflict, code)
	require.Equal(t, "comments_off", body["code"])
}

// The drawer: the whole thread in every status, the commenter's summary.
func TestDiscussionThread(t *testing.T) {
	f := newModerationFixture(t)
	post := f.publishedPost(t)
	ana := f.commenter(t)
	root := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentApproved)
	held := f.comment(t, post, ana, &root, db.ReaderCommentPending)
	spam := f.comment(t, post, f.commenter(t), &held, db.ReaderCommentSpam)
	f.comment(t, post, ana, &root, db.ReaderCommentUnconfirmed)

	recorder := trashCall(t, f.server, &f.editor, http.MethodGet, fmt.Sprintf("/api/v1/discussion/comments/%d/thread", held.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body struct {
		Comment   ModerationComment   `json:"comment"`
		Thread    []ModerationComment `json:"thread"`
		Commenter *CommenterSummary   `json:"commenter"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, held.ID, body.Comment.ID)
	require.Equal(t, []int64{root.ID, held.ID, spam.ID}, commentIDs(body.Thread), "oldest first, never unconfirmed")
	require.Equal(t, "Ana Reader", body.Thread[2].ReplyingTo)
	require.NotNil(t, body.Commenter)
	require.Equal(t, ana.ID, body.Commenter.ID)
	require.Equal(t, int64(1), body.Commenter.Pending)
	require.Equal(t, int64(0), body.Commenter.Approved)
	// Every fixture comment shares one network hash: the others posted from it.
	require.GreaterOrEqual(t, body.Commenter.NetworkNeighbours, int64(2))
}

// A commenter's page, Find a commenter by the whole address, and Block with who and when.
func TestDiscussionCommenters(t *testing.T) {
	f := newModerationFixture(t)
	post := f.publishedPost(t)
	ana := f.commenter(t)
	f.comment(t, post, ana, nil, db.ReaderCommentApproved)
	f.comment(t, post, ana, nil, db.ReaderCommentSpam)

	logs := &bytes.Buffer{}
	f.server.logger = slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	require.NoError(t, f.server.setupRoutes())

	code, body := f.call(t, &f.editor, http.MethodGet, "/api/v1/discussion/commenters?email="+ana.Email, nil)
	require.Equal(t, http.StatusOK, code, body)
	require.Equal(t, float64(ana.ID), body["id"], "matched ignoring case")
	code, _ = f.call(t, &f.editor, http.MethodGet, "/api/v1/discussion/commenters?email="+ana.Email[:len(ana.Email)-2], nil)
	require.Equal(t, http.StatusNotFound, code, "the whole address only")
	code, _ = f.call(t, &f.editor, http.MethodGet, "/api/v1/discussion/commenters?email=reader", nil)
	require.Equal(t, http.StatusBadRequest, code)

	page := fmt.Sprintf("/api/v1/discussion/commenters/%d", ana.ID)
	recorder := trashCall(t, f.server, &f.editor, http.MethodGet, page, nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var view struct {
		Commenter CommenterSummary    `json:"commenter"`
		Comments  []ModerationComment `json:"comments"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
	require.Equal(t, ana.Email, view.Commenter.Email)
	require.Equal(t, int64(1), view.Commenter.Approved)
	require.Equal(t, int64(1), view.Commenter.Spam)
	require.Equal(t, int64(2), view.Commenter.NotifyCount)
	require.Equal(t, []string{"Ana Reader"}, view.Commenter.NamesUsed)
	require.Len(t, view.Comments, 2)
	require.Nil(t, view.Commenter.BlockedAt)

	code, body = f.call(t, &f.editor, http.MethodPut, page+"/block", map[string]any{"blocked": true})
	require.Equal(t, http.StatusOK, code, body)
	summary := body["commenter"].(map[string]any)
	require.NotNil(t, summary["blocked_at"])
	require.Equal(t, "Schedule Tester", summary["blocked_by"])
	code, _ = f.call(t, &f.editor, http.MethodPut, page+"/block", map[string]any{"blocked": false})
	require.Equal(t, http.StatusOK, code)
	commenter, err := f.store.GetCommenter(context.Background(), ana.ID)
	require.NoError(t, err)
	require.False(t, commenter.BlockedAt.Valid)
	require.False(t, commenter.BlockedBy.Valid)
	require.Equal(t, []string{db.ActivityCommenterBlocked, db.ActivityCommenterUnblocked}, f.verbs(t, db.ActivityObjectCommenter, ana.ID))
	var payload json.RawMessage
	require.NoError(t, f.conn.QueryRow(`SELECT payload FROM activity WHERE object_type = 'commenter' AND object_id = $1 ORDER BY id LIMIT 1`, ana.ID).Scan(&payload))
	require.JSONEq(t, `{"comment_count":2}`, string(payload))
	code, _ = f.call(t, &f.editor, http.MethodPut, page+"/block", map[string]any{})
	require.Equal(t, http.StatusBadRequest, code)
	code, _ = f.call(t, &f.editor, http.MethodGet, "/api/v1/discussion/commenters/999999999999", nil)
	require.Equal(t, http.StatusNotFound, code)

	// Addresses are answered, never logged (7.3).
	requireNoPersonalData(t, logs.String(), ana.Email)
}

// Home's Needs attention counts the queue for moderators only; the feed shows
// Discussion's events to moderators, titled by the post, never to contributors.
func TestDiscussionHomeAndFeed(t *testing.T) {
	f := newModerationFixture(t)
	post := f.publishedPost(t)
	comment := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)

	code, body := f.call(t, &f.editor, http.MethodGet, "/api/v1/home/needs-attention", nil)
	require.Equal(t, http.StatusOK, code, body)
	pending := body["comments_pending"].(map[string]any)
	require.GreaterOrEqual(t, pending["count"].(float64), float64(1))
	require.GreaterOrEqual(t, pending["post_count"].(float64), float64(1))
	require.NotNil(t, pending["oldest_at"])
	code, body = f.call(t, &f.contributor, http.MethodGet, "/api/v1/home/needs-attention", nil)
	require.Equal(t, http.StatusOK, code)
	require.Nil(t, body["comments_pending"], "contributors have no Discussion")

	code, _ = f.call(t, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", comment.ID), map[string]any{"action": "approve"})
	require.Equal(t, http.StatusOK, code)

	feed := func(caller *db.User) []ActivityResponse {
		recorder := trashCall(t, f.server, caller, http.MethodGet, "/api/v1/activity?limit=50", nil)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var out struct {
			Activity []ActivityResponse `json:"activity"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &out))
		return out.Activity
	}
	find := func(events []ActivityResponse) *ActivityResponse {
		for i, e := range events {
			if e.ObjectType == db.ActivityObjectReaderComment && e.ObjectID == comment.ID {
				return &events[i]
			}
		}
		return nil
	}
	event := find(feed(&f.editor))
	require.NotNil(t, event, "editors see Discussion's events")
	require.Equal(t, db.ActivityReaderCommentApproved, event.Verb)
	require.NotNil(t, event.Post)
	require.Equal(t, post.ID, event.Post.ID)
	require.Equal(t, post.Title, event.Post.Title)
	require.Nil(t, find(feed(&f.contributor)), "contributors don't")
}

// A status change that reaches readers purges the thread after its commit; one that
// doesn't (pending to spam) leaves the cached answer.
func TestDiscussionModerationPurges(t *testing.T) {
	f := newCachedComments(t)
	post := f.publishedPost(t)
	path := commentsPath(post, "")
	comment := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)
	other := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentPending)
	status := func(id int64, action string) {
		recorder := trashCall(t, f.server, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", id), map[string]any{"action": action})
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	}

	f.prime(t, path)
	status(comment.ID, "approve")
	cache, body := f.next(t, path)
	require.Equal(t, "MISS", cache)
	require.Contains(t, body, comment.Body)

	f.prime(t, path)
	status(other.ID, "spam")
	cache, _ = f.next(t, path)
	require.Equal(t, "HIT", cache, "a pending comment marked spam changes nothing public")

	f.prime(t, path)
	recorder := trashCall(t, f.server, &f.editor, http.MethodPost, "/api/v1/discussion/comments/bulk", map[string]any{"action": "trash", "ids": []int64{comment.ID}})
	require.Equal(t, http.StatusOK, recorder.Code)
	cache, body = f.next(t, path)
	require.Equal(t, "MISS", cache)
	require.NotContains(t, body, comment.Body)

	f.prime(t, path)
	recorder = trashCall(t, f.server, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/discussion/posts/%d/comments", post.ID), map[string]any{"body": "Staff says hello."})
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	cache, body = f.next(t, path)
	require.Equal(t, "MISS", cache)
	require.Contains(t, body, "Staff says hello.")
}

// The store's Approve and reply under a reply: the reply's root is its parent's root.
func TestMemberReplyToAReplyKeepsTheRoot(t *testing.T) {
	f := newModerationFixture(t)
	post := f.publishedPost(t)
	root := f.comment(t, post, f.commenter(t), nil, db.ReaderCommentApproved)
	child := f.comment(t, post, f.commenter(t), &root, db.ReaderCommentPending)
	result, err := f.store.CreateMemberReaderCommentTx(context.Background(), db.CreateMemberReaderCommentTxParams{
		PostID: post.ID, ParentID: sql.NullInt64{Int64: child.ID, Valid: true}, AuthorID: f.editor.ID, DisplayName: "Ed", Body: "Under a reply",
	})
	require.NoError(t, err)
	require.True(t, result.ParentApproved)
	require.Equal(t, root.ID, result.Comment.RootID.Int64)
	require.Equal(t, child.ID, result.Comment.ParentID.Int64)
}
