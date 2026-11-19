package api

import (
	"context"
	"log/slog"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Reader comments and the public cache (#523; design docs/design/reader-comments.md 10).
//
// The thread reads (discussion_public.go) and `discussion` on the post reads are ordinary
// cached /public reads, so #185's global purge is what keeps them fresh. What purges,
// always after the write committed:
//
//   - Route writes the purge middleware already covers (publicCachePurgeRoutes): a post's
//     Discussion choice (PUT /posts/:id/discussion, only when the post was or is
//     published), a Settings › Discussion save (PUT /settings), and every event that
//     takes a post on or off the site (publish, unpublish, trash, restore, delete), which
//     covers its thread too.
//   - Comment writes call purgeDiscussion with what happened (discussionEvent). The
//     mapping below decides whether readers can see it: a comment entering or leaving
//     approved, a tombstone or deletion, a member's edit purge; a comment that stays out
//     of sight (an unconfirmed or pending POST, a confirm that leaves it pending, a
//     pending comment marked spam) doesn't. Those routes declare themselves in
//     publicCacheDiscussionRoutes, not in publicCachePurgeRoutes, because the purge
//     depends on the outcome (as publicCachePostDetailRoutes depend on the post's status).
//
// purgeDiscussion never runs inside a transaction: call it once the write's transaction
// committed (after ExecTx returned), or a read racing the purge would store the old
// thread under the new generation (cache.Namespace). A bulk action purges once per
// request (discussionEventBulkModerated), not once per comment.
//
// The maintenance job (RunDiscussionMaintenance) doesn't purge: what it deletes or
// tombstones is never shown (unconfirmed, pending, spam, trash, orphan tombstones), and a
// hidden root it tombstones was already shown as a placeholder, which a tombstone renders
// the same (TestDiscussionMaintenanceKeepsPublicThreads).

// discussionEvent is what a committed comment write did, for purgeDiscussion.
type discussionEvent string

const (
	// A comment became shown: a keyed POST or a confirm that publishes it (#524), a
	// moderator's approve, a restore or Not spam that puts an approved comment back, a
	// member's comment or reply (#526).
	discussionEventPublished discussionEvent = "comment_published"
	// A shown comment stopped being shown: unapprove, spam or trash of an approved one.
	discussionEventHidden discussionEvent = "comment_hidden"
	// A comment was deleted or tombstoned: delete permanently, a reader's delete, an
	// erasure (#529).
	discussionEventRemoved discussionEvent = "comment_removed"
	// A member edited their own comment (#526).
	discussionEventEdited discussionEvent = "comment_edited"
	// A bulk moderation request changed at least one comment's shown state: one purge.
	discussionEventBulkModerated discussionEvent = "comments_bulk_moderated"

	// Out of sight, no purge: a POST that waits for its confirmation mail, a POST or a
	// confirm that leaves the comment pending (held, or routed to spam), and a status
	// change between two statuses readers never see (pending to spam, spam to pending).
	discussionEventUnconfirmed discussionEvent = "comment_unconfirmed"
	discussionEventPending     discussionEvent = "comment_pending"
	discussionEventUnseen      discussionEvent = "comment_status_unseen"
)

// discussionEventPurges is the purge mapping (section 10): true when readers can see the
// change. Every discussionEvent is listed (TestDiscussionEventsAreMapped).
var discussionEventPurges = map[discussionEvent]bool{
	discussionEventPublished:     true,
	discussionEventHidden:        true,
	discussionEventRemoved:       true,
	discussionEventEdited:        true,
	discussionEventBulkModerated: true,
	discussionEventUnconfirmed:   false,
	discussionEventPending:       false,
	discussionEventUnseen:        false,
}

// discussionStatusEvent is the event of one comment's status change (moderation): from
// and to are reader_comments statuses, "" for no row (a new comment). Entering approved
// is published, leaving it hidden, anything else unseen. A tombstone or a deletion is
// discussionEventRemoved, whatever the status.
func discussionStatusEvent(from, to string) discussionEvent {
	switch {
	case from != db.ReaderCommentApproved && to == db.ReaderCommentApproved:
		return discussionEventPublished
	case from == db.ReaderCommentApproved && to != db.ReaderCommentApproved:
		return discussionEventHidden
	case to == db.ReaderCommentUnconfirmed:
		return discussionEventUnconfirmed
	case from == "":
		return discussionEventPending
	default:
		// Between two statuses readers never see, or approved to approved.
		return discussionEventUnseen
	}
}

// purgeDiscussion is the one purge entry point for comment writes: call it after the
// write committed, with the post whose comments changed (0 when a bulk request spans
// several) and what happened. It purges only when the event is one readers can see and
// the post may be on the site: a post known not to be published has no public thread,
// and its publish purges anyway. It never fails the caller (purgePublicCache logs).
// It reports whether it purged, for the tests.
func (server *Server) purgeDiscussion(ctx context.Context, log *slog.Logger, postID int64, event discussionEvent) bool {
	if !discussionEventPurges[event] || !server.publicCache.enabled() {
		return false
	}
	if postID > 0 {
		// A lookup that fails purges: better a cold read than a stale thread.
		if post, err := server.store.GetPost(ctx, postID); err == nil && post.PostStatus != postStatusPublished {
			return false
		}
	}
	server.purgePublicCache(ctx, log, "discussion:"+string(event))
	return true
}

// publicCacheDiscussionRoutes are the mutating routes that purge themselves through
// purgeDiscussion, by outcome (the comment writes of #524, #526, #529), with why. A route
// here is neither in publicCachePurgeRoutes (the middleware would purge on every 2xx,
// pending comments included) nor in publicCacheNoPurgeRoutes
// (TestMutatingRoutesDeclarePublicCachePurge). /public has no purge middleware at all, so
// a /public write must be here or in publicCacheNoPurgeRoutes.
var publicCacheDiscussionRoutes = map[string]string{}
