package api

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

// Reader comment notifications (#528, discussion_mail.go, 000068) against the test
// database (skipped without one): the outbox written in the approving transaction,
// coalescing, building from the current data, unsubscribing (both forms), erased and
// blocked recipients, members' own comments, preferences, moderation mail, and no
// address in any log line.
//
// The sender drains every due row, so each fixture starts the outbox clean (nothing but
// these tests reads it; no sender runs in tests) and turns moderation mail off for every
// member but its own moderator, so a round mails only this test's people.

type mailFixture struct {
	commentsFixture
	mail  *recordingMailer
	logs  *bytes.Buffer
	ana   db.Commenter
	bea   db.Commenter
	post  db.Post
	other db.User // a moderator who isn't on the post's byline
}

func newMailFixture(t *testing.T) mailFixture {
	t.Helper()
	f := mailFixture{commentsFixture: newCommentsFixture(t), mail: &recordingMailer{}, logs: &bytes.Buffer{}}
	f.server.mailer = f.mail
	f.server.logger = slog.New(slog.NewJSONHandler(f.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	f.server.runInBackground = func(_, _ string, fn func()) { fn() }
	f.other = scheduleUser(t, f.store, RoleEditor)
	f.ana = f.commenter(t)
	f.bea = f.commenter(t)
	f.post = f.publishedPost(t)
	_, err := f.conn.Exec(`UPDATE discussion_mail SET done_at = now(), outcome = 'dropped', claimed_until = NULL WHERE done_at IS NULL`)
	require.NoError(t, err)
	_, err = f.conn.Exec(`UPDATE users SET notify_comment_moderation = 'off' WHERE id <> $1 AND notify_comment_moderation <> 'off'`, f.other.ID)
	require.NoError(t, err)
	return f
}

func ofTemplate(messages []mailer.Message, template string) []mailer.Message {
	var out []mailer.Message
	for _, m := range messages {
		if m.Template == template {
			out = append(out, m)
		}
	}
	return out
}

func ofKind(rows []mailRow, kind string) []mailRow {
	var out []mailRow
	for _, r := range rows {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out
}

// due makes every open row due now, as five minutes (or the digest) passing would.
func (f mailFixture) due(t *testing.T) {
	t.Helper()
	_, err := f.conn.Exec(`UPDATE discussion_mail SET due_at = now() - interval '1 second' WHERE done_at IS NULL AND attempts = 0`)
	require.NoError(t, err)
}

// drain runs the sender until nothing is due, and returns what it mailed since the call.
func (f mailFixture) drain(t *testing.T) []mailer.Message {
	t.Helper()
	before := len(f.mail.messages())
	for i := 0; i < 50; i++ {
		f.server.sendDiscussionMailRound(context.Background())
		var due int
		require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM discussion_mail WHERE done_at IS NULL AND due_at <= now()
			AND (claimed_until IS NULL OR claimed_until <= now())`).Scan(&due))
		if due == 0 {
			return f.mail.messages()[before:]
		}
	}
	t.Fatal("the outbox never drained")
	return nil
}

type mailRow struct {
	ID         int64
	Kind       string
	CommentIDs []int64
	DueAt      time.Time
	Outcome    sql.NullString
}

// rows lists the outbox rows of a recipient (a commenter or a member), oldest first.
func (f mailFixture) rows(t *testing.T, commenterID, userID int64) []mailRow {
	t.Helper()
	list, err := f.conn.Query(`SELECT id, kind, array_to_string(comment_ids, ','), due_at, outcome FROM discussion_mail
		WHERE commenter_id IS NOT DISTINCT FROM NULLIF($1, 0) AND user_id IS NOT DISTINCT FROM NULLIF($2, 0) ORDER BY id`, commenterID, userID)
	require.NoError(t, err)
	defer list.Close()
	var out []mailRow
	for list.Next() {
		var r mailRow
		var ids string
		require.NoError(t, list.Scan(&r.ID, &r.Kind, &ids, &r.DueAt, &r.Outcome))
		for _, part := range strings.Split(ids, ",") {
			if part != "" {
				var id int64
				_, err := fmt.Sscan(part, &id)
				require.NoError(t, err)
				r.CommentIDs = append(r.CommentIDs, id)
			}
		}
		out = append(out, r)
	}
	return out
}

// approve moderates a pending comment to approved as the given moderator.
func (f mailFixture) approve(t *testing.T, by db.User, id int64) {
	t.Helper()
	code, body := moderationFixture{commentsFixture: f.commentsFixture}.call(t, &by, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", id), map[string]any{"action": "approve"})
	require.Equal(t, http.StatusOK, code, body)
}

// oneClick POSTs RFC 8058's form body to the API's one-click route.
func (f mailFixture) oneClick(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := httptest.NewRecorder()
	f.server.router.ServeHTTP(recorder, request)
	return recorder
}

// oneClickPath turns a mail's List-Unsubscribe URL into the API route the web endpoint calls.
func oneClickPath(t *testing.T, msg mailer.Message, base string) (string, string) {
	t.Helper()
	require.True(t, strings.HasPrefix(msg.ListUnsubscribe, base+readerCommentOneClickPath), msg.ListUnsubscribe)
	token, err := url.PathUnescape(strings.TrimPrefix(msg.ListUnsubscribe, base+readerCommentOneClickPath))
	require.NoError(t, err)
	return "/public/discussion/unsubscribe/" + token, token
}

// An approval that rolls back leaves no mail: the trigger writes in its transaction.
func TestDiscussionMailRollbackSendsNothing(t *testing.T) {
	f := newMailFixture(t)
	root := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	reply := f.comment(t, f.post, f.bea, &root, db.ReaderCommentPending)

	tx, err := f.conn.Begin()
	require.NoError(t, err)
	_, err = tx.Exec(`UPDATE reader_comments SET status = 'approved', approved_at = now() WHERE id = $1`, reply.ID)
	require.NoError(t, err)
	var inside int
	require.NoError(t, tx.QueryRow(`SELECT count(*) FROM discussion_mail WHERE $1 = ANY (comment_ids)`, reply.ID).Scan(&inside))
	require.Equal(t, 2, inside, "the reply mail to Ana and the author mail, in the approving transaction")
	require.NoError(t, tx.Rollback())

	var after int
	require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM discussion_mail WHERE $1 = ANY (comment_ids)`, reply.ID).Scan(&after))
	require.Zero(t, after)
	f.due(t)
	for _, msg := range f.drain(t) {
		require.NotEqual(t, f.ana.Email, msg.To)
		require.NotContains(t, msg.Text, reply.Body, "the author's digest names the root only")
	}

	// Committed through the API, it is there.
	f.approve(t, f.other, reply.ID)
	rows := f.rows(t, f.ana.ID, 0)
	require.Len(t, rows, 1)
	require.Equal(t, discussionMailKindReply, rows[0].Kind)
	require.Equal(t, []int64{reply.ID}, rows[0].CommentIDs)
	require.WithinDuration(t, time.Now().Add(5*time.Minute), rows[0].DueAt, time.Minute, "reply mail waits five minutes")
}

// Twenty replies in a minute send one mail, with the RFC 8058 headers; its one-click
// POST stops that comment's replies.
func TestDiscussionMailCoalescesAndOneClickUnsubscribes(t *testing.T) {
	f := newMailFixture(t)
	root := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	for i := 0; i < 20; i++ {
		f.comment(t, f.post, f.bea, &root, db.ReaderCommentApproved)
	}
	rows := f.rows(t, f.ana.ID, 0)
	require.Len(t, rows, 1, "one open row for Ana")
	require.Len(t, rows[0].CommentIDs, 20)

	f.due(t)
	sent := mailsTo(f.drain(t), f.ana.Email)
	require.Len(t, sent, 1, "twenty replies, one mail")
	msg := sent[0]
	require.Equal(t, mailer.TemplateReaderCommentReply, msg.Template)
	require.Contains(t, msg.Subject, "20 new replies")
	require.Equal(t, 20, strings.Count(msg.Text, "#comment-"), "every reply, linked")
	require.Contains(t, msg.Text, f.server.publicURL+readerCommentUnsubscribeURL+"#token=")

	// The headers themselves.
	path, token := oneClickPath(t, msg, f.server.publicURL)
	require.Contains(t, msg.Text, "#token="+token, "the visible link and the header carry the same token")

	// The one-click: the form body is required, then it stops Ana's replies for good.
	require.Equal(t, http.StatusBadRequest, f.oneClick(t, path, "").Code)
	require.Equal(t, http.StatusNoContent, f.oneClick(t, path, "List-Unsubscribe=One-Click").Code)
	require.False(t, f.reload(t, root.ID).NotifyReplies)
	require.Equal(t, http.StatusNoContent, f.oneClick(t, path, "List-Unsubscribe=One-Click").Code, "idempotent")
	require.Equal(t, http.StatusBadRequest, f.oneClick(t, "/public/discussion/unsubscribe/not-a-token", "List-Unsubscribe=One-Click").Code)

	f.comment(t, f.post, f.bea, &root, db.ReaderCommentApproved)
	require.Len(t, f.rows(t, f.ana.ID, 0), 1, "an unsubscribed comment queues nothing")
}

// A comment trashed (or unapproved, or made a tombstone) before its mail is due is left
// out, and a mail left with nothing is dropped.
func TestDiscussionMailLeavesOutWhatChanged(t *testing.T) {
	f := newMailFixture(t)
	root := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	kept := f.says(t, f.post, f.bea, &root, db.ReaderCommentApproved, marker("kept"))
	trashed := f.says(t, f.post, f.bea, &root, db.ReaderCommentApproved, marker("trashed"))
	_, err := f.conn.Exec(`UPDATE reader_comments SET status = 'trash', trashed_from = 'approved', moderated_at = now() WHERE id = $1`, trashed.ID)
	require.NoError(t, err)

	f.due(t)
	sent := mailsTo(f.drain(t), f.ana.Email)
	require.Len(t, sent, 1)
	require.Contains(t, sent[0].Text, kept.Body)
	require.NotContains(t, sent[0].Text, trashed.Body)
	require.Contains(t, sent[0].Subject, "New reply")

	// Only trashed ones: nothing is sent.
	gone := f.comment(t, f.post, f.bea, &root, db.ReaderCommentApproved)
	_, err = f.conn.Exec(`UPDATE reader_comments SET status = 'trash', trashed_from = 'approved', moderated_at = now() WHERE id = $1`, gone.ID)
	require.NoError(t, err)
	f.due(t)
	require.Empty(t, mailsTo(f.drain(t), f.ana.Email))
	rows := f.rows(t, f.ana.ID, 0)
	require.Equal(t, discussionMailDropped, rows[len(rows)-1].Outcome.String)

	// Restoring it doesn't queue it again: it was in a row already.
	_, err = f.conn.Exec(`UPDATE reader_comments SET status = 'approved', trashed_from = NULL WHERE id = $1`, gone.ID)
	require.NoError(t, err)
	require.Len(t, f.rows(t, f.ana.ID, 0), len(rows))

	// A post unpublished meanwhile: nothing.
	other := f.publishedPost(t)
	theirs := f.comment(t, other, f.ana, nil, db.ReaderCommentApproved)
	f.comment(t, other, f.bea, &theirs, db.ReaderCommentApproved)
	_, err = f.conn.Exec(`UPDATE posts SET post_status = 'draft' WHERE id = $1`, other.ID)
	require.NoError(t, err)
	f.due(t)
	require.Empty(t, mailsTo(f.drain(t), f.ana.Email))
}

// An unsubscribed, blocked or erased recipient gets nothing; "Stop all mail" reaches
// every comment of the commenter.
func TestDiscussionMailRecipientsWhoMayNot(t *testing.T) {
	f := newMailFixture(t)

	// Unsubscribed after the row was queued: dropped when built.
	first := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	second := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	f.comment(t, f.post, f.bea, &first, db.ReaderCommentApproved)
	f.due(t)
	sent := mailsTo(f.drain(t), f.ana.Email)
	require.Len(t, sent, 1)
	_, token := oneClickPath(t, sent[0], f.server.publicURL)

	f.comment(t, f.post, f.bea, &second, db.ReaderCommentApproved)
	require.Equal(t, http.StatusBadRequest, doJSON(t, f.server, http.MethodPost, "/public/discussion/unsubscribe", map[string]any{"token": "nope"}, nil).Code)
	recorder := doJSON(t, f.server, http.MethodPost, "/public/discussion/unsubscribe", map[string]any{"token": token, "all": true}, nil)
	require.Equal(t, http.StatusNoContent, recorder.Code, recorder.Body.String())
	require.False(t, f.reload(t, first.ID).NotifyReplies)
	require.False(t, f.reload(t, second.ID).NotifyReplies, "Stop all mail reaches the commenter's other comments")
	f.due(t)
	require.Empty(t, mailsTo(f.drain(t), f.ana.Email), "the row queued before is dropped")

	// Blocked: dropped.
	cy := f.commenter(t)
	cyRoot := f.comment(t, f.post, cy, nil, db.ReaderCommentApproved)
	f.comment(t, f.post, f.bea, &cyRoot, db.ReaderCommentApproved)
	_, err := f.conn.Exec(`UPDATE commenters SET blocked_at = now() WHERE id = $1`, cy.ID)
	require.NoError(t, err)
	f.due(t)
	require.Empty(t, mailsTo(f.drain(t), cy.Email))

	// Erased (#529 deletes the commenter): their rows go with them, and a claim that
	// raced the erasure finds nobody.
	dee := f.commenter(t)
	deeRoot := f.comment(t, f.post, dee, nil, db.ReaderCommentApproved)
	f.comment(t, f.post, f.bea, &deeRoot, db.ReaderCommentApproved)
	require.Len(t, f.rows(t, dee.ID, 0), 1)
	_, err = f.conn.Exec(`DELETE FROM reader_comments WHERE commenter_id = $1`, dee.ID)
	require.NoError(t, err)
	_, err = f.conn.Exec(`DELETE FROM commenters WHERE id = $1`, dee.ID)
	require.NoError(t, err)
	require.Empty(t, f.rows(t, dee.ID, 0), "ON DELETE CASCADE")
	f.due(t)
	require.Empty(t, mailsTo(f.drain(t), dee.Email))

	ema := f.commenter(t)
	emaRoot := f.comment(t, f.post, ema, nil, db.ReaderCommentApproved)
	f.comment(t, f.post, f.bea, &emaRoot, db.ReaderCommentApproved)
	f.due(t)
	claims, err := f.store.ClaimDueDiscussionMail(context.Background(), db.ClaimDueDiscussionMailParams{LeaseSeconds: 60, MaxRows: 100})
	require.NoError(t, err)
	var mine *db.ClaimDueDiscussionMailRow
	for i := range claims {
		if claims[i].CommenterID.Int64 == ema.ID {
			mine = &claims[i]
		}
	}
	require.NotNil(t, mine)
	_, err = f.conn.Exec(`DELETE FROM commenters WHERE id = $1`, ema.ID)
	require.NoError(t, err)
	settings, err := f.store.GetSettings(context.Background())
	require.NoError(t, err)
	require.False(t, f.server.sendDiscussionMail(context.Background(), *mine, settings))
	require.Empty(t, mailsTo(f.mail.messages(), ema.Email))
}

// A member never gets a mail about their own comment, nor about one they approved; a
// reader's reply to their own comment mails nobody.
func TestDiscussionMailNeverAboutYourOwn(t *testing.T) {
	f := newMailFixture(t)
	mf := moderationFixture{commentsFixture: f.commentsFixture}

	// The post's author comments on their own post and replies to Ana: no author mail.
	root := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	code, body := mf.call(t, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/discussion/posts/%d/comments", f.post.ID), map[string]any{"body": "Thanks for reading, " + marker("author")})
	require.Equal(t, http.StatusCreated, code, body)
	code, body = mf.call(t, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/discussion/posts/%d/comments", f.post.ID), map[string]any{"body": "Glad you liked it", "parent_id": root.ID})
	require.Equal(t, http.StatusCreated, code, body)

	// The author approves a reader's comment themselves: no author mail about it either.
	pending := f.comment(t, f.post, f.bea, nil, db.ReaderCommentPending)
	f.approve(t, f.editor, pending.ID)

	// Ana answers herself: no reply mail (the author hears of it).
	self := f.comment(t, f.post, f.ana, &root, db.ReaderCommentApproved)

	authorRows := ofKind(f.rows(t, 0, f.editor.ID), discussionMailKindAuthor)
	require.Len(t, authorRows, 1, "one open row")
	require.ElementsMatch(t, []int64{root.ID, self.ID}, authorRows[0].CommentIDs, "readers' comments approved by someone else only")
	anaRows := f.rows(t, f.ana.ID, 0)
	require.Len(t, anaRows, 1, "the member's reply mails Ana; her own doesn't")
	require.Len(t, anaRows[0].CommentIDs, 1)

	// A member who isn't on the byline gets no author mail.
	require.Empty(t, ofKind(f.rows(t, 0, f.other.ID), discussionMailKindAuthor))

	// The member's reply reaches Ana under the member's name.
	f.due(t)
	sent := mailsTo(f.drain(t), f.ana.Email)
	require.Len(t, sent, 1)
	require.Contains(t, sent[0].Text, "Glad you liked it")
	// The author's digest names Ana's comment only.
	authored := ofTemplate(mailsTo(f.mail.messages(), f.editor.Email), mailer.TemplateReaderCommentAuthor)
	require.Len(t, authored, 1)
	require.Contains(t, authored[0].Text, root.Body)
	require.NotContains(t, authored[0].Text, pending.Body)
}

// Profile's Notifications (8.3): the default digest at 08:00 in the site's zone, Each one
// five minutes after, Off nothing; changing it moves the waiting mail.
func TestDiscussionMailAuthorPreferences(t *testing.T) {
	f := newMailFixture(t)
	path := "/api/v1/users/me/notifications"

	fresh := scheduleUser(t, f.store, RoleEditor)
	recorder := trashCall(t, f.server, &fresh, http.MethodGet, path, nil)
	require.Equal(t, http.StatusOK, recorder.Code)
	require.JSONEq(t, `{"comments_on_posts":"digest","comments_to_moderate":"hourly","moderates":true}`, recorder.Body.String(), "the defaults (decision 8)")
	contributor := scheduleUser(t, f.store, RoleContributor)
	recorder = trashCall(t, f.server, &contributor, http.MethodGet, path, nil)
	require.JSONEq(t, `{"comments_on_posts":"digest","comments_to_moderate":"hourly","moderates":false}`, recorder.Body.String())
	require.Equal(t, http.StatusUnauthorized, trashCall(t, f.server, nil, http.MethodGet, path, nil).Code)
	require.Equal(t, http.StatusBadRequest, trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{"comments_on_posts": "weekly", "comments_to_moderate": "hourly"}).Code)

	// Digest: due at the next 08:00 (UTC here).
	var zone string
	require.NoError(t, f.conn.QueryRow(`SELECT site_timezone FROM settings WHERE id = 1`).Scan(&zone))
	t.Cleanup(func() { _, _ = f.conn.Exec(`UPDATE settings SET site_timezone = $1 WHERE id = 1`, zone) })
	_, err := f.conn.Exec(`UPDATE settings SET site_timezone = 'UTC' WHERE id = 1`)
	require.NoError(t, err)
	f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	rows := f.rows(t, 0, f.editor.ID)
	require.Len(t, rows, 1)
	now := time.Now().UTC()
	next := time.Date(now.Year(), now.Month(), now.Day(), 8, 0, 0, 0, time.UTC)
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	require.WithinDuration(t, next, rows[0].DueAt, time.Second)

	// Each one: the waiting digest moves to five minutes from now.
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{"comments_on_posts": "each", "comments_to_moderate": "hourly"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	rows = f.rows(t, 0, f.editor.ID)
	require.WithinDuration(t, time.Now().Add(5*time.Minute), rows[0].DueAt, time.Minute)
	f.due(t)
	sent := ofTemplate(mailsTo(f.drain(t), f.editor.Email), mailer.TemplateReaderCommentAuthor)
	require.Len(t, sent, 1, "the author mail (and, since hourly is on, a moderation mail)")
	require.True(t, strings.HasPrefix(sent[0].Subject, "New comment on"), sent[0].Subject)
	require.Contains(t, sent[0].Text, f.server.publicURL+adminDiscussionPath+"?status=approved&post=")
	require.Empty(t, sent[0].ListUnsubscribe, "members manage their mail on Profile")

	// Off: a comment approved now queues nothing, and a waiting one is dropped.
	f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{"comments_on_posts": "off", "comments_to_moderate": "off"})
	require.Equal(t, http.StatusOK, recorder.Code)
	f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	f.due(t)
	require.Empty(t, mailsTo(f.drain(t), f.editor.Email))
	rows = f.rows(t, 0, f.editor.ID)
	require.Len(t, rows[len(rows)-1].CommentIDs, 1, "only the one approved before Off")
	require.Equal(t, discussionMailDropped, rows[len(rows)-1].Outcome.String)
}

// "Comments await moderation": to editors and admins who want it, at most hourly, only
// when a comment no mail of theirs counted is waiting; never commenters' details.
func TestDiscussionMailModeration(t *testing.T) {
	f := newMailFixture(t)
	pending := f.says(t, f.post, f.ana, nil, db.ReaderCommentPending, marker("waiting"))
	contributor := scheduleUser(t, f.store, RoleContributor)
	sent := f.drain(t)
	mine := mailsTo(sent, f.other.Email)
	require.Len(t, mine, 1)
	msg := mine[0]
	require.Equal(t, mailer.TemplateReaderCommentModeration, msg.Template)
	require.Contains(t, msg.Text, f.post.Title)
	require.Contains(t, msg.Text, f.server.publicURL+adminDiscussionPath+"?status=pending")
	requireNoPersonalData(t, msg.Text+msg.HTML+msg.Subject, f.ana.Email, pending.Body)
	require.Empty(t, mailsTo(sent, f.admin.Email), "Off")
	require.Empty(t, mailsTo(sent, contributor.Email), "contributors don't moderate")

	// Within the hour: nothing more, even with a new comment.
	f.comment(t, f.post, f.bea, nil, db.ReaderCommentPending)
	require.Empty(t, mailsTo(f.drain(t), f.other.Email))

	// An hour later, the new comment is news.
	_, err := f.conn.Exec(`UPDATE discussion_mail SET done_at = now() - interval '61 minutes' WHERE kind = 'moderation' AND user_id = $1`, f.other.ID)
	require.NoError(t, err)
	again := mailsTo(f.drain(t), f.other.Email)
	require.Len(t, again, 1)

	// Nothing new since: nothing, however long it waits.
	_, err = f.conn.Exec(`UPDATE discussion_mail SET done_at = now() - interval '2 hours' WHERE kind = 'moderation' AND user_id = $1`, f.other.ID)
	require.NoError(t, err)
	require.Empty(t, mailsTo(f.drain(t), f.other.Email))
}

// No address in any log line: the whole path (approval, sending, unsubscribing, a failed
// send) logs ids and outcomes only.
func TestDiscussionMailLogsHoldNoAddress(t *testing.T) {
	f := newMailFixture(t)
	root := f.says(t, f.post, f.ana, nil, db.ReaderCommentApproved, marker("root text"))
	reply := f.says(t, f.post, f.bea, &root, db.ReaderCommentPending, marker("reply text"))
	f.approve(t, f.other, reply.ID)
	f.comment(t, f.post, f.bea, nil, db.ReaderCommentPending)

	// A relay that refuses, quoting the recipient as relays do.
	f.mail.err = fmt.Errorf("550 5.1.1 <%s>: Recipient address rejected", f.ana.Email)
	f.due(t)
	f.server.sendDiscussionMailRound(context.Background())
	f.mail.err = nil
	_, err := f.conn.Exec(`UPDATE discussion_mail SET claimed_until = NULL, due_at = now() - interval '1 second' WHERE done_at IS NULL`)
	require.NoError(t, err)
	sent := mailsTo(f.drain(t), f.ana.Email)
	require.Len(t, sent, 1)
	path, token := oneClickPath(t, sent[0], f.server.publicURL)
	require.Equal(t, http.StatusNoContent, f.oneClick(t, path, "List-Unsubscribe=One-Click").Code)
	require.Equal(t, http.StatusNoContent, doJSON(t, f.server, http.MethodPost, "/public/discussion/unsubscribe", map[string]any{"token": token, "all": true}, nil).Code)

	logs := f.logs.String()
	require.Contains(t, logs, "discussion mail sent")
	require.Contains(t, logs, "discussion mail failed")
	require.Contains(t, logs, "reader_comment_unsubscribed")
	requireNoPersonalData(t, logs,
		f.ana.Email, f.bea.Email, f.editor.Email, f.other.Email, f.admin.Email,
		f.ana.DisplayName, root.Body, reply.Body, token, "Recipient address rejected")
}
