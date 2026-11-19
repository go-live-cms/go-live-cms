package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The public thread reads (#523, discussion_public.go) against the test database (skipped
// without one): only approved comments, threaded per 6.2 with replying_to, placeholders
// for hidden comments that keep replies (6.4), pages and ?thread=, 404s, off, and no
// clock in the answer. discussion_purge_db_test.go checks the purges.

type commentsFixture struct {
	discussionFixture
	admin db.User
}

// newCommentsFixture turns comments on for the site (restored after the test).
func newCommentsFixture(t *testing.T) commentsFixture {
	t.Helper()
	f := commentsFixture{discussionFixture: newDiscussionFixture(t)}
	f.admin = scheduleUser(t, f.store, RoleAdmin)
	restoreDiscussionSettings(t, f.discussionFixture)
	f.settings(t, map[string]any{
		"comments_enabled": true, "comments_close_after_days": 0, "comments_threading": "replies",
		"comments_order": "oldest", "comments_per_page": 30,
	})
	return f
}

// settings saves Settings › Discussion fields as an admin.
func (f commentsFixture) settings(t *testing.T, fields map[string]any) {
	t.Helper()
	recorder := trashCall(t, f.server, &f.admin, http.MethodPut, "/api/v1/settings", fields)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
}

// says inserts a comment with a body of its own and returns it.
func (f commentsFixture) says(t *testing.T, post db.Post, commenter db.Commenter, reply *db.ReaderComment, status, body string) db.ReaderComment {
	t.Helper()
	comment := f.comment(t, post, commenter, reply, status)
	_, err := f.conn.Exec(`UPDATE reader_comments SET body = $2 WHERE id = $1`, comment.ID, body)
	require.NoError(t, err)
	comment.Body = body
	return comment
}

// byMember inserts a member's approved comment (3.4).
func (f commentsFixture) byMember(t *testing.T, post db.Post, member db.User, body string) db.ReaderComment {
	t.Helper()
	comment, err := f.store.CreateReaderComment(context.Background(), db.CreateReaderCommentParams{
		PostID:       post.ID,
		AuthorUserID: sql.NullInt64{Int64: member.ID, Valid: true},
		DisplayName:  "Posted as",
		Body:         body,
		Status:       db.ReaderCommentApproved,
		ApprovedAt:   sql.NullTime{Time: time.Now(), Valid: true},
	})
	require.NoError(t, err)
	return comment
}

// read is an anonymous GET of path.
func (f commentsFixture) read(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	return cacheGet(t, f.server, path)
}

// page reads /public/posts/:id/comments[?query] and decodes it (200 required).
func (f commentsFixture) page(t *testing.T, post db.Post, query string) PublicCommentsResponse {
	t.Helper()
	recorder := f.read(t, commentsPath(post, query))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body PublicCommentsResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return body
}

func commentsPath(post db.Post, query string) string {
	path := fmt.Sprintf("/public/posts/%d/comments", post.ID)
	if query != "" {
		path += "?" + query
	}
	return path
}

func threadIDs(threads []PublicReaderCommentThread) []int64 {
	ids := make([]int64, len(threads))
	for i, thread := range threads {
		ids[i] = thread.Comment.ID
	}
	return ids
}

func replyIDs(thread PublicReaderCommentThread) []int64 {
	ids := make([]int64, len(thread.Replies))
	for i, reply := range thread.Replies {
		ids[i] = reply.ID
	}
	return ids
}

func marker(what string) string { return what + " " + uuid.NewString() }

// Only approved comments are served, threaded per 6.2: replies in their root's list,
// oldest first, "Replying to" on a reply to a reply, placeholders where a hidden
// comment keeps approved replies, members' names and badges.
func TestPublicThreadsServeOnlyApproved(t *testing.T) {
	f := newCommentsFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	ana := f.commenter(t)

	hidden := map[string]string{}
	hide := func(name string) string {
		hidden[name] = marker(name)
		return hidden[name]
	}

	a := f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("A"))
	a1 := f.says(t, post, ana, &a, db.ReaderCommentApproved, marker("A1"))
	_, err := f.conn.Exec(`UPDATE reader_comments SET display_name = 'Bea' WHERE id = $1`, a1.ID)
	require.NoError(t, err)
	a2 := f.says(t, post, ana, &a1, db.ReaderCommentApproved, marker("A2"))
	f.says(t, post, ana, &a, db.ReaderCommentPending, hide("A3 pending"))
	f.says(t, post, ana, &a, db.ReaderCommentSpam, hide("A4 spam"))
	// A pending reply that a shown reply answers: a placeholder, and no "Replying to".
	a5 := f.says(t, post, ana, &a, db.ReaderCommentPending, hide("A5 pending, answered"))
	a6 := f.says(t, post, ana, &a5, db.ReaderCommentApproved, marker("A6"))

	// A root that is pending again with an approved reply: a placeholder.
	b := f.says(t, post, ana, nil, db.ReaderCommentApproved, hide("B unapproved"))
	b1 := f.says(t, post, ana, &b, db.ReaderCommentApproved, marker("B1"))
	_, err = f.conn.Exec(`UPDATE reader_comments SET status = 'pending' WHERE id = $1`, b.ID)
	require.NoError(t, err)
	// Hidden, nothing answers them: not listed at all.
	f.says(t, post, ana, nil, db.ReaderCommentPending, hide("C pending"))
	e := f.says(t, post, ana, nil, db.ReaderCommentApproved, hide("E trashed"))
	_, err = f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: e.ID})
	require.NoError(t, err)
	f.says(t, post, ana, nil, db.ReaderCommentUnconfirmed, hide("F unconfirmed"))
	// A tombstone with a reply: a placeholder.
	d := f.says(t, post, ana, nil, db.ReaderCommentApproved, hide("D deleted"))
	d1 := f.says(t, post, ana, &d, db.ReaderCommentApproved, marker("D1"))
	result, err := f.store.DeleteReaderCommentTx(ctx, d.ID)
	require.NoError(t, err)
	require.True(t, result.Tombstoned)
	// Members: the editor is on the published byline (author), the admin isn't (staff).
	g := f.byMember(t, post, f.editor, marker("G by the author"))
	h := f.byMember(t, post, f.admin, marker("H by staff"))

	body := f.page(t, post, "")
	require.Equal(t, []int64{a.ID, b.ID, d.ID, g.ID, h.ID}, threadIDs(body.Threads))
	require.Equal(t, PublicDiscussion{State: discussionStateOpen, Count: 8}, body.Discussion, "A, A1, A2, A6, B1, D1, G, H")
	require.Equal(t, pageInfo{Page: 1, PerPage: 30, Total: 5, TotalPages: 1}, body.Pagination)

	threadA := body.Threads[0]
	require.Equal(t, []int64{a1.ID, a2.ID, a5.ID, a6.ID}, replyIDs(threadA))
	require.EqualValues(t, 4, threadA.ReplyCount)
	require.Equal(t, "Ana Reader", threadA.Comment.Name)
	require.Equal(t, a.Body, threadA.Comment.Body)
	require.Nil(t, threadA.Comment.ParentID)
	require.Nil(t, threadA.Comment.ReplyingTo)
	require.Nil(t, threadA.Comment.Badge)
	require.Nil(t, threadA.Comment.Avatar)
	require.Nil(t, threadA.Replies[0].ReplyingTo, "a direct reply sits under its comment already")
	require.Equal(t, a.ID, *threadA.Replies[0].RootID)
	require.NotNil(t, threadA.Replies[1].ReplyingTo)
	require.Equal(t, "Bea", *threadA.Replies[1].ReplyingTo, "a reply to a reply names the comment it answers")
	require.Equal(t, a1.ID, *threadA.Replies[1].ParentID)
	placeholder := threadA.Replies[2]
	require.True(t, placeholder.Removed)
	require.Empty(t, placeholder.Name)
	require.Empty(t, placeholder.Body)
	require.Nil(t, threadA.Replies[3].ReplyingTo, "its parent is shown as removed")

	threadB := body.Threads[1]
	require.True(t, threadB.Comment.Removed)
	require.Empty(t, threadB.Comment.Body)
	require.Equal(t, []int64{b1.ID}, replyIDs(threadB))
	threadD := body.Threads[2]
	require.True(t, threadD.Comment.Removed, "a tombstone")
	require.Equal(t, []int64{d1.ID}, replyIDs(threadD))

	require.Equal(t, "Schedule Tester", body.Threads[3].Comment.Name, "a member's current name, not the one stored")
	require.Equal(t, readerCommentBadgeAuthor, *body.Threads[3].Comment.Badge)
	require.Equal(t, readerCommentBadgeStaff, *body.Threads[4].Comment.Badge)

	raw := f.read(t, commentsPath(post, "")).Body.String()
	for name, text := range hidden {
		require.NotContains(t, raw, text, "%s is not approved and must not be served", name)
	}
	for _, field := range []string{`"status"`, `"commenter_id"`, `"email"`, `"network_hash"`, `"display_name"`} {
		require.NotContains(t, raw, field)
	}

	// A member's edit shows "Edited"; a removed member's comment keeps its posted name
	// and loses the badge.
	_, err = f.conn.Exec(`UPDATE reader_comments SET edited_at = now() WHERE id = $1`, g.ID)
	require.NoError(t, err)
	_, err = f.conn.Exec(`UPDATE reader_comments SET author_user_id = NULL WHERE id = $1`, h.ID)
	require.NoError(t, err)
	body = f.page(t, post, "")
	require.True(t, body.Threads[3].Comment.Edited)
	require.Equal(t, "Posted as", body.Threads[4].Comment.Name)
	require.Nil(t, body.Threads[4].Comment.Badge)

	// The post read carries the same discussion.
	recorder := f.read(t, fmt.Sprintf("/public/posts/%d", post.ID))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var view publicPostView
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
	require.Equal(t, PublicDiscussion{State: discussionStateOpen, Count: 8}, view.Discussion)
	recorder = f.read(t, "/public/posts/slug/"+post.Slug)
	require.Contains(t, recorder.Body.String(), `"discussion":{"state":"open","closes_at":null,"count":8}`)
}

// Pages of comments_per_page threads, 404 past the last; newest first; flat threading;
// a thread over 100 replies shows 100 and the count; ?thread= shows them all.
func TestPublicThreadPages(t *testing.T) {
	f := newCommentsFixture(t)
	post := f.publishedPost(t)
	ana := f.commenter(t)
	f.settings(t, map[string]any{"comments_per_page": 10})

	roots := make([]db.ReaderComment, 11)
	for i := range roots {
		roots[i] = f.says(t, post, ana, nil, db.ReaderCommentApproved, marker(fmt.Sprintf("root %d", i)))
	}
	replies := make([]db.ReaderComment, 101)
	for i := range replies {
		replies[i] = f.says(t, post, ana, &roots[0], db.ReaderCommentApproved, marker(fmt.Sprintf("reply %d", i)))
	}

	first := f.page(t, post, "")
	require.Equal(t, pageInfo{Page: 1, PerPage: 10, Total: 11, TotalPages: 2}, first.Pagination)
	require.Equal(t, roots[0].ID, first.Threads[0].Comment.ID)
	require.Len(t, first.Threads[0].Replies, discussionRepliesPerThread, "the first 100")
	require.EqualValues(t, 101, first.Threads[0].ReplyCount, "and Show more replies")
	require.Equal(t, replies[0].ID, first.Threads[0].Replies[0].ID, "oldest first")
	require.EqualValues(t, 112, first.Discussion.Count)

	second := f.page(t, post, "page=2")
	require.Equal(t, []int64{roots[10].ID}, threadIDs(second.Threads))
	require.Equal(t, http.StatusNotFound, f.read(t, commentsPath(post, "page=3")).Code)
	require.Equal(t, http.StatusBadRequest, f.read(t, commentsPath(post, "page=0")).Code)
	require.Equal(t, http.StatusBadRequest, f.read(t, commentsPath(post, "page=x")).Code)

	recorder := f.read(t, commentsPath(post, fmt.Sprintf("thread=%d", roots[0].ID)))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var one PublicCommentThreadResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &one))
	require.Equal(t, roots[0].ID, one.Thread.Comment.ID)
	require.Len(t, one.Thread.Replies, 101, "a thread alone has every reply")
	require.EqualValues(t, 112, one.Discussion.Count)
	for _, query := range []string{
		fmt.Sprintf("thread=%d", replies[0].ID), // a reply isn't a thread
		"thread=999999999999",
	} {
		require.Equal(t, http.StatusNotFound, f.read(t, commentsPath(post, query)).Code, query)
	}
	other := f.publishedPost(t)
	require.Equal(t, http.StatusNotFound, f.read(t, commentsPath(other, fmt.Sprintf("thread=%d", roots[0].ID))).Code, "another post's thread")
	require.Equal(t, http.StatusBadRequest, f.read(t, commentsPath(post, "thread=x")).Code)
	require.Equal(t, http.StatusBadRequest, f.read(t, commentsPath(post, fmt.Sprintf("thread=%d&page=1", roots[0].ID))).Code)

	f.settings(t, map[string]any{"comments_order": "newest"})
	newest := f.page(t, post, "")
	require.Equal(t, roots[10].ID, newest.Threads[0].Comment.ID, "newest thread first")
	require.Equal(t, roots[1].ID, newest.Threads[9].Comment.ID)
	oldestLast := f.page(t, post, "page=2")
	require.Equal(t, []int64{roots[0].ID}, threadIDs(oldestLast.Threads))
	require.Equal(t, replies[0].ID, oldestLast.Threads[0].Replies[0].ID, "replies stay oldest first")

	// Flat (6.2 A): every comment on its own, replies included; nothing nested.
	f.settings(t, map[string]any{"comments_threading": "flat", "comments_order": "oldest"})
	flat := f.page(t, post, "")
	require.Equal(t, pageInfo{Page: 1, PerPage: 10, Total: 112, TotalPages: 12}, flat.Pagination)
	require.Equal(t, roots[0].ID, flat.Threads[0].Comment.ID)
	for _, thread := range flat.Threads {
		require.Empty(t, thread.Replies)
		require.Nil(t, thread.Comment.ReplyingTo)
	}
	last := f.page(t, post, "page=12")
	require.Equal(t, []int64{replies[99].ID, replies[100].ID}, threadIDs(last.Threads))
}

// A post /public doesn't serve answers 404; off serves no threads and counts nothing.
func TestPublicThreadsNotServed(t *testing.T) {
	f := newCommentsFixture(t)
	ctx := context.Background()
	ana := f.commenter(t)

	draft := scheduleDraft(t, f.store, f.editor, scheduleWord())
	f.says(t, draft, ana, nil, db.ReaderCommentApproved, marker("on a draft"))
	trashed := f.publishedPost(t)
	f.says(t, trashed, ana, nil, db.ReaderCommentApproved, marker("on a trashed post"))
	_, err := f.store.TrashPost(ctx, trashed.ID)
	require.NoError(t, err)
	unpublished := f.publishedPost(t)
	f.says(t, unpublished, ana, nil, db.ReaderCommentApproved, marker("on an unpublished post"))
	recorder := trashCall(t, f.server, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/unpublish", unpublished.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	for _, post := range []db.Post{draft, trashed, unpublished} {
		recorder := f.read(t, commentsPath(post, ""))
		require.Equal(t, http.StatusNotFound, recorder.Code, "post %d (%s)", post.ID, recorder.Body.String())
		require.NotContains(t, recorder.Body.String(), "on a")
	}
	require.Equal(t, http.StatusNotFound, f.read(t, "/public/posts/999999999999/comments").Code)
	require.Equal(t, http.StatusBadRequest, f.read(t, "/public/posts/x/comments").Code)

	// A published post of a type the site doesn't serve.
	typeName := "c" + scheduleWord()
	recorder = trashCall(t, f.server, &f.admin, http.MethodPost, "/api/v1/post-types", map[string]any{
		"name": typeName, "label": "Private", "public": false, "supports": []string{"title", "comments"},
	})
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	private := f.publishedPost(t)
	_, err = f.conn.Exec(`UPDATE posts SET post_type = $2 WHERE id = $1`, private.ID, typeName)
	require.NoError(t, err)
	require.Equal(t, http.StatusNotFound, f.read(t, commentsPath(private, "")).Code, "not a public type")

	// Off: the post's choice, then the site's switch.
	post := f.publishedPost(t)
	root := f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("while off"))
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID), map[string]any{"discussion": "off"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	requireOff := func(what string) {
		t.Helper()
		body := f.page(t, post, "")
		require.Equal(t, PublicDiscussion{State: discussionStateOff}, body.Discussion, what)
		require.Empty(t, body.Threads, what)
		require.Zero(t, body.Pagination.Total, what)
		raw := f.read(t, commentsPath(post, "")).Body.String()
		require.NotContains(t, raw, root.Body, what)
		require.Equal(t, http.StatusNotFound, f.read(t, commentsPath(post, fmt.Sprintf("thread=%d", root.ID))).Code, what)
		require.Equal(t, http.StatusNotFound, f.read(t, commentsPath(post, "page=2")).Code, what)
		require.Contains(t, f.read(t, fmt.Sprintf("/public/posts/%d", post.ID)).Body.String(),
			`"discussion":{"state":"off","closes_at":null,"count":0}`, what)
	}
	requireOff("the post's choice")
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID), map[string]any{"discussion": "default"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Len(t, f.page(t, post, "").Threads, 1)
	f.settings(t, map[string]any{"comments_enabled": false})
	requireOff("the site's switch")
}

// No cached answer reads the clock: a post past its close date still answers open with
// its closes_at (the renderer and the write path apply the time, 12.4). Closed keeps
// showing its threads.
func TestPublicThreadsCarryClosesAtNotTheClock(t *testing.T) {
	f := newCommentsFixture(t)
	ana := f.commenter(t)
	f.settings(t, map[string]any{"comments_close_after_days": 7})

	older := scheduleDraft(t, f.store, f.editor, scheduleWord())
	_, err := f.conn.Exec(`UPDATE posts SET first_published_at = now() - interval '8 days' WHERE id = $1`, older.ID)
	require.NoError(t, err)
	post := publishForTest(t, f.store, older, f.editor)
	f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("before the close"))

	closes := post.FirstPublishedAt.Time.Add(7 * 24 * time.Hour)
	require.True(t, closes.Before(time.Now()))
	for _, path := range []string{commentsPath(post, ""), fmt.Sprintf("/public/posts/%d", post.ID)} {
		recorder := f.read(t, path)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var body struct {
			Discussion PublicDiscussion `json:"discussion"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, discussionStateOpen, body.Discussion.State, "%s: the state without the clock", path)
		require.NotNil(t, body.Discussion.ClosesAt, path)
		require.WithinDuration(t, closes, *body.Discussion.ClosesAt, time.Second, path)
		require.Equal(t, discussionStateClosed, discussionState(DiscussionSetting{State: body.Discussion.State, ClosesAt: body.Discussion.ClosesAt}, time.Now()),
			"the reader's rule closes it")
		require.NotContains(t, recorder.Body.String(), `"closed"`)
	}

	recorder := trashCall(t, f.server, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID), map[string]any{"discussion": "closed"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	body := f.page(t, post, "")
	require.Equal(t, PublicDiscussion{State: discussionStateClosed, Count: 1}, body.Discussion)
	require.Len(t, body.Threads, 1, "closed keeps showing its threads")
}
