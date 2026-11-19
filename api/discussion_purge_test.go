package api

import (
	"context"
	"log/slog"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The purge mapping of section 10 (#523, discussion_purge.go) without a database.

func TestDiscussionEventsAreMapped(t *testing.T) {
	events := []discussionEvent{
		discussionEventPublished, discussionEventHidden, discussionEventRemoved, discussionEventEdited,
		discussionEventBulkModerated, discussionEventUnconfirmed, discussionEventPending, discussionEventUnseen,
	}
	require.Len(t, discussionEventPurges, len(events), "every event is in the mapping, once")
	for _, event := range events {
		_, ok := discussionEventPurges[event]
		require.True(t, ok, "%s is mapped", event)
	}
	for _, event := range []discussionEvent{discussionEventUnconfirmed, discussionEventPending, discussionEventUnseen} {
		require.False(t, discussionEventPurges[event], "%s is out of sight", event)
	}
}

func TestDiscussionStatusEvent(t *testing.T) {
	const (
		none        = ""
		unconfirmed = db.ReaderCommentUnconfirmed
		pending     = db.ReaderCommentPending
		approved    = db.ReaderCommentApproved
		spam        = db.ReaderCommentSpam
		trash       = db.ReaderCommentTrash
	)
	for _, tc := range []struct {
		from, to string
		want     discussionEvent
		purges   bool
	}{
		{none, unconfirmed, discussionEventUnconfirmed, false}, // a POST without a key
		{none, pending, discussionEventPending, false},         // a keyed POST that is held
		{none, spam, discussionEventPending, false},            // routed to spam by the rules
		{none, approved, discussionEventPublished, true},       // a keyed POST that publishes, a member's
		{unconfirmed, pending, discussionEventUnseen, false},   // a confirm that leaves it pending
		{unconfirmed, approved, discussionEventPublished, true},
		{pending, approved, discussionEventPublished, true},
		{trash, approved, discussionEventPublished, true}, // restore
		{approved, pending, discussionEventHidden, true},  // unapprove
		{approved, spam, discussionEventHidden, true},
		{approved, trash, discussionEventHidden, true},
		{pending, spam, discussionEventUnseen, false},
		{spam, pending, discussionEventUnseen, false}, // Not spam
		{pending, trash, discussionEventUnseen, false},
		{approved, approved, discussionEventUnseen, false},
	} {
		got := discussionStatusEvent(tc.from, tc.to)
		require.Equal(t, tc.want, got, "%q → %q", tc.from, tc.to)
		require.Equal(t, tc.purges, discussionEventPurges[got], "%q → %q", tc.from, tc.to)
	}
}

// purgeDiscussion looks the post up only when it would purge, and purges when it can't
// tell (a failed lookup); with no cache it does nothing at all.
func TestPurgeDiscussionWithoutDatabase(t *testing.T) {
	ctx := context.Background()
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	require.False(t, server.purgeDiscussion(ctx, slog.Default(), 1, discussionEventPublished), "no cache: no-op, no lookup")

	withMiniredis(t, server)
	require.False(t, server.purgeDiscussion(ctx, slog.Default(), 1, discussionEventPending), "out of sight: no lookup")
	store.EXPECT().GetPost(gomock.Any(), int64(1)).Return(db.Post{}, context.DeadlineExceeded)
	require.True(t, server.purgeDiscussion(ctx, slog.Default(), 1, discussionEventPublished), "a failed lookup purges")
	store.EXPECT().GetPost(gomock.Any(), int64(2)).Return(db.Post{ID: 2, PostStatus: "draft"}, nil)
	require.False(t, server.purgeDiscussion(ctx, slog.Default(), 2, discussionEventHidden), "a draft has no public thread")
	store.EXPECT().GetPost(gomock.Any(), int64(3)).Return(db.Post{ID: 3, PostStatus: postStatusPublished}, nil)
	require.True(t, server.purgeDiscussion(ctx, slog.Default(), 3, discussionEventRemoved))
	require.True(t, server.purgeDiscussion(ctx, slog.Default(), 0, discussionEventBulkModerated), "several posts: no lookup")
}
