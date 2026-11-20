package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// Reader comment events and the comment guard (#530, 000066, reader-comments.md 14)
// against the test database (skipped without one): the trigger writes the six events
// only for a subscriber and with ids only, they reach an observer through the outbox,
// Host.Comments reads the text only with comments:read, and the guard's hold, spam and
// errors route comments on the real write path, which a guard can't approve.

var commentEvents = []string{
	pluginsdk.EventCommentCreated, pluginsdk.EventCommentApproved, pluginsdk.EventCommentUnapproved,
	pluginsdk.EventCommentSpammed, pluginsdk.EventCommentTrashed, pluginsdk.EventCommentDeleted,
}

// commentPluginEvents lists a post's comment events in id order.
func commentPluginEvents(t *testing.T, conn *sql.DB, postID int64) []pluginEventRow {
	t.Helper()
	out := []pluginEventRow{}
	for _, e := range postPluginEvents(t, conn, postID) {
		if strings.HasPrefix(e.Event, "comment.") {
			out = append(out, e)
		}
	}
	return out
}

// eventsOfComment is the events naming comment id, as "event status[<-previous]".
func eventsOfComment(events []pluginEventRow, id int64) []string {
	out := []string{}
	for _, e := range events {
		if commentID, _ := e.Data["comment_id"].(float64); int64(commentID) == id {
			label := e.Event + " " + e.Data["status"].(string)
			if previous, ok := e.Data["previous_status"].(string); ok {
				label += "<-" + previous
			}
			out = append(out, label)
		}
	}
	return out
}

func commentEventsSubscribed(t *testing.T, conn *sql.DB) bool {
	t.Helper()
	var subscribed sql.NullBool
	require.NoError(t, conn.QueryRow(`SELECT bool_or(golive_plugin_event_subscribed(e)) FROM unnest($1::text[]) e`,
		"{"+strings.Join(commentEvents, ",")+"}").Scan(&subscribed))
	return subscribed.Bool
}

// No event row without a subscriber: with none, nothing a comment goes through writes
// one; a plugin subscribed to one event gets that event alone.
func TestCommentEventsNeedASubscriber(t *testing.T) {
	f := newDiscussionFixture(t)
	if commentEventsSubscribed(t, f.conn) {
		t.Skip("an enabled plugin in this database subscribes to comment events")
	}
	ctx := context.Background()
	post := f.publishedPost(t)
	commenter := f.commenter(t)
	root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
	reply := f.comment(t, post, commenter, &root, db.ReaderCommentPending)
	f.comment(t, post, commenter, nil, db.ReaderCommentSpam)
	_, err := f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: reply.ID})
	require.NoError(t, err)
	_, err = f.store.DeleteReaderCommentTx(ctx, reply.ID)
	require.NoError(t, err)
	require.Empty(t, commentPluginEvents(t, f.conn, post.ID))

	enableHookPlugin(t, f.store, []string{pluginsdk.EventCommentApproved}, nil)
	approved := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
	f.comment(t, post, commenter, nil, db.ReaderCommentPending)
	require.Equal(t, []string{"comment.approved approved"}, eventsOfComment(commentPluginEvents(t, f.conn, post.ID), approved.ID),
		"only the subscribed event, not comment.created")
	require.Len(t, commentPluginEvents(t, f.conn, post.ID), 1)
}

// Every event of 14.1, from every kind of change, with ids and small facts only.
func TestCommentEventsLifecycle(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	enableHookPlugin(t, f.store, commentEvents, nil)
	post := f.publishedPost(t)
	commenter := f.commenter(t)

	// A reader's comment: nothing while unconfirmed, created (and approved) when it is
	// confirmed.
	confirmed := f.comment(t, post, commenter, nil, db.ReaderCommentUnconfirmed)
	require.Empty(t, eventsOfComment(commentPluginEvents(t, f.conn, post.ID), confirmed.ID))
	_, err := f.conn.Exec(`UPDATE reader_comments SET status = 'approved', approved_at = now(), confirm_token_hash = NULL WHERE id = $1`, confirmed.ID)
	require.NoError(t, err)

	// Stored at once: approved (a keyed comment), held, spam.
	keyed := f.comment(t, post, commenter, &confirmed, db.ReaderCommentApproved)
	held := f.comment(t, post, commenter, nil, db.ReaderCommentPending)
	spam := f.comment(t, post, commenter, nil, db.ReaderCommentSpam)

	// A member's comment.
	var member db.ReaderComment
	require.NoError(t, f.conn.QueryRow(`INSERT INTO reader_comments (post_id, author_user_id, display_name, body, status, approved_at)
		VALUES ($1, $2, 'Editor', 'From the staff.', 'approved', now()) RETURNING id`, post.ID, f.editor.ID).Scan(&member.ID))

	// Moderation: unapprove, spam, trash, approve, each by the editor.
	moderate := func(id int64, status string) {
		t.Helper()
		_, err := f.conn.Exec(`UPDATE reader_comments SET status = $2::varchar, moderated_by = $3, moderated_at = clock_timestamp(),
			approved_at = CASE WHEN $2::varchar = 'approved' THEN now() ELSE approved_at END WHERE id = $1`, id, status, f.editor.ID)
		require.NoError(t, err)
	}
	moderate(keyed.ID, db.ReaderCommentPending)
	moderate(held.ID, db.ReaderCommentApproved)
	moderate(spam.ID, db.ReaderCommentPending) // spam -> pending is no event
	_, err = f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: spam.ID, ModeratedBy: sql.NullInt64{Int64: f.editor.ID, Valid: true}})
	require.NoError(t, err)
	moderate(held.ID, db.ReaderCommentSpam)

	// Deleting: a plain delete, and a root with an approved reply becomes a tombstone,
	// whose later removal is no second event.
	_, err = f.store.DeleteReaderCommentTx(ctx, spam.ID)
	require.NoError(t, err)
	moderate(keyed.ID, db.ReaderCommentApproved)
	_, err = f.store.DeleteReaderCommentTx(ctx, confirmed.ID)
	require.NoError(t, err)
	requireTombstone(t, f.reload(t, confirmed.ID))
	_, err = f.conn.Exec(`DELETE FROM reader_comments WHERE id = $1`, keyed.ID)
	require.NoError(t, err)
	_, err = f.conn.Exec(`DELETE FROM reader_comments WHERE id = $1`, confirmed.ID)
	require.NoError(t, err)
	// An unconfirmed comment expiring is no event either.
	expired := f.comment(t, post, commenter, nil, db.ReaderCommentUnconfirmed)
	_, err = f.conn.Exec(`DELETE FROM reader_comments WHERE id = $1`, expired.ID)
	require.NoError(t, err)

	events := commentPluginEvents(t, f.conn, post.ID)
	require.Equal(t, []string{"comment.created approved<-unconfirmed", "comment.approved approved<-unconfirmed", "comment.deleted approved"},
		eventsOfComment(events, confirmed.ID))
	require.Equal(t, []string{"comment.created approved", "comment.approved approved", "comment.unapproved pending<-approved",
		"comment.approved approved<-pending", "comment.deleted approved"}, eventsOfComment(events, keyed.ID))
	require.Equal(t, []string{"comment.created pending", "comment.approved approved<-pending", "comment.spammed spam<-approved"},
		eventsOfComment(events, held.ID))
	require.Equal(t, []string{"comment.created spam", "comment.spammed spam", "comment.trashed trash<-pending", "comment.deleted trash"},
		eventsOfComment(events, spam.ID))
	require.Equal(t, []string{"comment.created approved", "comment.approved approved"}, eventsOfComment(events, member.ID))
	require.Empty(t, eventsOfComment(events, expired.ID))

	reader := commenterAddress(t, f, commenter.ID)
	for _, e := range events {
		// Ids and small facts only: never a name, text or address (7.1).
		for key := range e.Data {
			require.Contains(t, []string{"comment_id", "root_id", "status", "previous_status", "by_member"}, key, "%s data", e.Event)
		}
		raw, err := json.Marshal(e.Data)
		require.NoError(t, err)
		requireNoPersonalData(t, string(raw), reader, commenter.DisplayName, "A comment", "From the staff", "Editor")
		require.Equal(t, e.Data["comment_id"] == float64(member.ID), e.Data["by_member"], "%s by_member", e.Event)
		switch {
		case e.Data["comment_id"] == float64(member.ID):
			require.Equal(t, f.editor.ID, e.ActorID.Int64, "the member wrote it")
		case e.Event == pluginsdk.EventCommentCreated || e.Event == pluginsdk.EventCommentDeleted:
			require.False(t, e.ActorID.Valid, "%s: a reader's comment names no member", e.Event)
		case e.Data["previous_status"] != nil && e.Data["previous_status"] != db.ReaderCommentUnconfirmed:
			require.Equal(t, f.editor.ID, e.ActorID.Int64, "%s: the moderator", e.Event)
		}
	}
	reply := eventsNamed(events, pluginsdk.EventCommentCreated)[1]
	require.Equal(t, float64(confirmed.ID), reply.Data["root_id"], "a reply carries its thread")
	_, hasRoot := eventsNamed(events, pluginsdk.EventCommentCreated)[0].Data["root_id"]
	require.False(t, hasRoot, "a top-level comment has no root_id")

	// A post deleted for good: its post.deleted stands for its comments (none here: the
	// plugin doesn't subscribe to it), not one event per comment.
	before := len(commentPluginEvents(t, f.conn, post.ID))
	_, err = f.store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	require.NoError(t, f.store.DeleteTrashedPostTx(ctx, post.ID))
	require.Len(t, commentPluginEvents(t, f.conn, post.ID), before)
}

func commenterAddress(t *testing.T, f discussionFixture, id int64) string {
	t.Helper()
	commenter, err := f.store.GetCommenter(context.Background(), id)
	require.NoError(t, err)
	return commenter.Email
}

// The events reach an observer through the outbox, like post events; Host.Comments
// reads the comment (never the address) only with comments:read.
func TestCommentEventsReachObservers(t *testing.T) {
	f := newDiscussionFixture(t)
	reader := enableHookPlugin(t, f.store, []string{pluginsdk.EventCommentCreated}, nil, pluginsdk.CapabilityCommentsRead)
	blind := enableHookPlugin(t, f.store, []string{pluginsdk.EventCommentCreated}, nil)

	type seen struct {
		event   pluginsdk.Event
		comment pluginsdk.Comment
		err     error
		reader  bool
	}
	var mu sync.Mutex
	got := map[string][]seen{}
	observer := func(slug string) pluginsdk.Observer {
		return func(ctx context.Context, host pluginsdk.Host, event pluginsdk.Event) error {
			s := seen{event: event, reader: host.Comments() != nil}
			if s.reader {
				s.comment, s.err = host.Comments().Get(ctx, int64(event.Data["comment_id"].(float64)))
			}
			mu.Lock()
			got[slug] = append(got[slug], s)
			mu.Unlock()
			return nil
		}
	}
	registry := pluginHookRegistry{
		reader.Slug: {Observers: map[string]pluginsdk.Observer{pluginsdk.EventCommentCreated: observer(reader.Slug)}},
		blind.Slug:  {Observers: map[string]pluginsdk.Observer{pluginsdk.EventCommentCreated: observer(blind.Slug)}},
	}
	_, dispatcher := hookServer(t, f.store, registry)

	post := f.publishedPost(t)
	commenter := f.commenter(t)
	comment := f.comment(t, post, commenter, nil, db.ReaderCommentPending)
	forPost := func(slug string) []seen {
		mu.Lock()
		defer mu.Unlock()
		out := []seen{}
		for _, s := range got[slug] {
			if s.event.PostID == post.ID {
				out = append(out, s)
			}
		}
		return out
	}
	roundsUntil(t, dispatcher, func() bool { return len(forPost(reader.Slug)) == 1 && len(forPost(blind.Slug)) == 1 })

	s := forPost(reader.Slug)[0]
	require.True(t, s.reader)
	require.NoError(t, s.err)
	require.Equal(t, pluginsdk.EventCommentCreated, s.event.Name)
	require.Equal(t, pluginsdk.Comment{ID: comment.ID, PostID: post.ID, Name: comment.DisplayName, Body: comment.Body,
		Status: db.ReaderCommentPending, CreatedAt: s.comment.CreatedAt}, s.comment)
	require.False(t, forPost(blind.Slug)[0].reader, "no comments:read, no Host.Comments")

	// An unconfirmed comment isn't created yet, so the reader doesn't find it.
	host := &pluginHost{server: f.server, plugin: hookPlugin{slug: reader.Slug, manifest: PluginManifest{Capabilities: []string{pluginsdk.CapabilityCommentsRead}}}}
	unconfirmed := f.comment(t, post, commenter, nil, db.ReaderCommentUnconfirmed)
	_, err := host.Comments().Get(context.Background(), unconfirmed.ID)
	require.ErrorIs(t, err, pluginsdk.ErrNotFound)
	_, err = host.Comments().Get(context.Background(), 0)
	require.ErrorIs(t, err, pluginsdk.ErrNotFound)
}

// commentGuardCode is a comment guard's code for a test: it records what it was asked
// and answers by the comment's text.
type commentGuardCode struct {
	mu    sync.Mutex
	asked []pluginsdk.CommentCandidate
}

func (g *commentGuardCode) guard(_ context.Context, _ pluginsdk.Host, c pluginsdk.CommentCandidate) (pluginsdk.CommentDecision, error) {
	g.mu.Lock()
	g.asked = append(g.asked, c)
	g.mu.Unlock()
	switch {
	case strings.Contains(c.Body, "HOLD"):
		return pluginsdk.HoldComment("Looks automated"), nil
	case strings.Contains(c.Body, "SPAM"):
		return pluginsdk.SpamComment("Known spammer"), nil
	case strings.Contains(c.Body, "FAIL"):
		return pluginsdk.CommentDecision{}, errors.New("the service answered 503 for " + c.Email)
	case strings.Contains(c.Body, "APPROVE"):
		return pluginsdk.CommentDecision{Verdict: "approve"}, nil
	}
	return pluginsdk.AllowComment(), nil
}

func (g *commentGuardCode) askedAbout(text string) []pluginsdk.CommentCandidate {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := []pluginsdk.CommentCandidate{}
	for _, c := range g.asked {
		if strings.Contains(c.Body, text) {
			out = append(out, c)
		}
	}
	return out
}

// The guard on the write path: its hold and spam route the comment and store their
// reason, an error follows on_error, it can't approve, a keyless comment's verdict is
// applied at its confirmation without asking again, and no log line holds the
// commenter's data.
func TestCommentGuardOnTheWritePath(t *testing.T) {
	f := newCommentFlow(t, discussionModerationNone)
	slug := pluginDBSlug("comment-guard")
	enableManifestPlugin(t, f.store, slug, map[string]any{
		"manifest_version": 1, "id": slug, "name": "Spam check", "version": "1.0.0", "plugin_api": 1,
		"capabilities": []string{pluginsdk.CapabilityCommentsPrivate},
		"server":       map[string]any{"hooks": []any{map[string]any{"event": pluginCommentGuardEvent, "on_error": "hold"}}},
	})
	code := &commentGuardCode{}
	f.server.pluginRegistry = pluginHookRegistry{slug: {BeforeCommentCreate: code.guard}}
	var logs bytes.Buffer
	var logMu sync.Mutex
	f.server.logger = slog.New(slog.NewJSONHandler(&lockedWriter{mu: &logMu, w: &logs}, &slog.HandlerOptions{Level: slog.LevelDebug}))

	post := f.publishedPost(t)
	address := uniqueAddress()
	send := func(text string, keys ...string) {
		t.Helper()
		recorder := f.post(t, post.ID, gin.H{"name": "Maya Rivers", "email": address, "body": text}, keys...)
		require.Less(t, recorder.Code, 300, recorder.Body.String())
	}
	stored := func(text string) db.ReaderComment {
		t.Helper()
		for _, c := range f.commentsOf(t, post.ID) {
			if strings.Contains(c.Body, text) {
				return c
			}
		}
		t.Fatalf("no comment %q", text)
		return db.ReaderComment{}
	}

	// A keyless comment the guard holds: stored unconfirmed with the verdict, which the
	// confirmation applies without asking the guard again.
	held := "Please HOLD this one " + uuid.NewString()
	send(held)
	comment := stored(held)
	require.Equal(t, db.ReaderCommentUnconfirmed, comment.Status)
	require.Equal(t, heldPlugin, comment.HeldReason.String)
	recorder, answer := f.confirm(t, f.lastToken(t, address))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, readerCommentOutcomePending, answer["outcome"])
	comment = f.reload(t, comment.ID)
	require.Equal(t, db.ReaderCommentPending, comment.Status)
	require.Equal(t, heldPlugin, comment.HeldReason.String)
	require.Equal(t, "Spam check: Looks automated", comment.HeldDetail.String, "the reason moderators see")
	asked := code.askedAbout(held)
	require.Len(t, asked, 1, "asked once, not again at the confirmation")
	require.Equal(t, address, asked[0].Email, "the guard sees the request")
	require.Equal(t, post.ID, asked[0].PostID)
	require.NotEmpty(t, asked[0].IP)
	require.False(t, asked[0].HasBrowserKey)
	key := answer["set_key"].(string)

	// Keyed comments are decided at once.
	allowed := "Fine words " + uuid.NewString()
	send(allowed, key)
	require.Equal(t, db.ReaderCommentApproved, stored(allowed).Status)
	require.True(t, code.askedAbout(allowed)[0].HasBrowserKey)

	keyedHold := "HOLD again " + uuid.NewString()
	send(keyedHold, key)
	require.Equal(t, db.ReaderCommentPending, stored(keyedHold).Status)
	require.Equal(t, heldPlugin, stored(keyedHold).HeldReason.String)

	spam := "Buy SPAM now " + uuid.NewString()
	send(spam, key)
	require.Equal(t, db.ReaderCommentSpam, stored(spam).Status)
	require.Equal(t, spamPlugin, stored(spam).HeldReason.String)
	require.Equal(t, "Spam check: Known spammer", stored(spam).HeldDetail.String)

	// An error follows on_error: hold.
	failed := "Make it FAIL " + uuid.NewString()
	send(failed, key)
	require.Equal(t, db.ReaderCommentPending, stored(failed).Status)
	require.Equal(t, "Spam check couldn't check this comment.", stored(failed).HeldDetail.String)

	// A guard can't approve: with every comment held, its "approve" changes nothing.
	_, err := f.conn.Exec(`UPDATE settings SET comments_moderation = $1`, discussionModerationAll)
	require.NoError(t, err)
	approve := "APPROVE me " + uuid.NewString()
	send(approve, key)
	require.Equal(t, db.ReaderCommentPending, stored(approve).Status)
	require.Equal(t, heldModerationAll, stored(approve).HeldReason.String)

	// Disabled, the guard isn't asked.
	_, err = f.store.DisablePlugin(context.Background(), slug)
	require.NoError(t, err)
	_, err = f.conn.Exec(`UPDATE settings SET comments_moderation = $1`, discussionModerationNone)
	require.NoError(t, err)
	after := "HOLD after disabling " + uuid.NewString()
	send(after, key)
	require.Equal(t, db.ReaderCommentApproved, stored(after).Status)
	require.Empty(t, code.askedAbout(after))

	logMu.Lock()
	text := logs.String()
	logMu.Unlock()
	require.Contains(t, text, "plugin_comment_guard_failed")
	requireNoPersonalData(t, text, address, strings.ToLower(address), "Maya Rivers", held, spam, failed, "Looks automated", "Known spammer")
}

// The guard's budget on the write path: one that hangs is not waited for past its time,
// and the comment is answered (on_error allow: core's rules decide).
func TestCommentGuardBudgetOnTheWritePath(t *testing.T) {
	shortCommentGuardBudgets(t, 50*time.Millisecond, 80*time.Millisecond)
	f := newCommentFlow(t, discussionModerationNone)
	slug := pluginDBSlug("comment-guard")
	enableManifestPlugin(t, f.store, slug, map[string]any{
		"manifest_version": 1, "id": slug, "name": "Slow check", "version": "1.0.0", "plugin_api": 1,
		"capabilities": []string{pluginsdk.CapabilityCommentsPrivate},
		"server":       map[string]any{"hooks": []any{map[string]any{"event": pluginCommentGuardEvent}}},
	})
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	f.server.pluginRegistry = pluginHookRegistry{slug: {BeforeCommentCreate: func(context.Context, pluginsdk.Host, pluginsdk.CommentCandidate) (pluginsdk.CommentDecision, error) {
		<-release // ignores its context
		return pluginsdk.SpamComment("too late"), nil
	}}}
	post := f.publishedPost(t)
	started := time.Now()
	recorder := f.post(t, post.ID, gin.H{"name": "Ana", "email": uniqueAddress(), "body": "A patient comment."})
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	require.Less(t, time.Since(started), 2*time.Second, "the hung guard wasn't waited for")
	comments := f.commentsOf(t, post.ID)
	require.Len(t, comments, 1)
	require.Equal(t, db.ReaderCommentUnconfirmed, comments[0].Status, "allowed: the late spam is ignored")
	require.False(t, comments[0].HeldReason.Valid)
}
