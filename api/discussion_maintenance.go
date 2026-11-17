package api

import (
	"context"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// RunDiscussionMaintenance (#522, design 6.6; retention is section 18, decision 13).
// Reader comments keep personal data (a name, a text, a network hash), so every replica
// prunes them on a timer, like the signup and activity prunes. Every statement takes
// its rows FOR UPDATE SKIP LOCKED (db/query/discussion.sql), so replicas running it
// together, or a moderator's transaction, never wait on each other. Deleting is
// idempotent. Logs counts only: never an address, a name or a text (7.3).
//
//   - unconfirmed comments after 48 hours; pending after 90 days; spam and trash 30 days
//     after they got there. One that approved replies still hang from becomes a
//     tombstone instead of being deleted (the root's cascade would take them, 6.4);
//   - network hashes after 30 days (7.2);
//   - expired browser keys (3.3);
//   - tombstones with no replies left;
//   - commenters with no comments and no keys, unseen for 30 days, unless blocked or
//     marked spam in the last 90 days: those rows are what the block and previous_spam
//     rules remember, and they hold no text.

const (
	readerCommentUnconfirmedTTL = 48 * time.Hour
	readerCommentPendingTTL     = 90 * 24 * time.Hour
	readerCommentRemovedTTL     = 30 * 24 * time.Hour // spam and trash
	readerCommentNetworkHashTTL = 30 * 24 * time.Hour
	commenterStaleTTL           = 30 * 24 * time.Hour
	commenterSpamMemory         = 90 * 24 * time.Hour

	discussionMaintenanceTimeout = time.Minute
	// discussionTombstonePasses bounds the tombstone loop: a reply's tombstone going can
	// orphan its root's, and threads are two levels deep (6.2).
	discussionTombstonePasses = 3
)

// discussionMaintenanceResult counts what one run changed.
type discussionMaintenanceResult struct {
	Tombstoned        int64
	CommentsDeleted   int64
	TombstonesDeleted int64
	HashesCleared     int64
	KeysDeleted       int64
	CommentersDeleted int64
}

func (r discussionMaintenanceResult) changed() bool {
	return r != discussionMaintenanceResult{}
}

// RunDiscussionMaintenance runs the job every interval until ctx is done (main.go).
// interval <= 0 turns it off in this process (DISCUSSION_MAINTENANCE_INTERVAL=0).
func (server *Server) RunDiscussionMaintenance(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		server.logger.Info("discussion maintenance is off in this process (DISCUSSION_MAINTENANCE_INTERVAL=0)")
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		server.maintainDiscussion(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// maintainDiscussion runs one round and logs the outcome.
func (server *Server) maintainDiscussion(ctx context.Context) {
	runCtx, cancel := context.WithTimeout(ctx, discussionMaintenanceTimeout)
	defer cancel()
	result, err := server.runDiscussionMaintenance(runCtx, time.Now())
	if err != nil {
		if ctx.Err() == nil { // not just shutting down
			server.logger.Warn("discussion_maintenance_failed", "error", err)
		}
		return
	}
	if result.changed() {
		server.logger.Info("discussion maintenance",
			"comments_tombstoned", result.Tombstoned,
			"comments_deleted", result.CommentsDeleted,
			"tombstones_deleted", result.TombstonesDeleted,
			"network_hashes_cleared", result.HashesCleared,
			"commenter_keys_deleted", result.KeysDeleted,
			"commenters_deleted", result.CommentersDeleted)
	}
}

// runDiscussionMaintenance applies every rule once, as of now. Each rule is its own
// statement (and transaction): one that fails stops the round, and the next round
// starts over, which is safe since every rule is idempotent.
func (server *Server) runDiscussionMaintenance(ctx context.Context, now time.Time) (discussionMaintenanceResult, error) {
	var result discussionMaintenanceResult
	var err error
	unconfirmedBefore := now.Add(-readerCommentUnconfirmedTTL)
	pendingBefore := now.Add(-readerCommentPendingTTL)
	removedBefore := now.Add(-readerCommentRemovedTTL)

	// Tombstones first, so the delete that follows can't cascade to approved replies.
	if result.Tombstoned, err = server.store.TombstoneExpiredReaderComments(ctx, db.TombstoneExpiredReaderCommentsParams{UnconfirmedBefore: unconfirmedBefore, PendingBefore: pendingBefore, RemovedBefore: removedBefore}); err != nil {
		return result, err
	}
	if result.CommentsDeleted, err = server.store.DeleteExpiredReaderComments(ctx, db.DeleteExpiredReaderCommentsParams{UnconfirmedBefore: unconfirmedBefore, PendingBefore: pendingBefore, RemovedBefore: removedBefore}); err != nil {
		return result, err
	}
	for range discussionTombstonePasses {
		deleted, err := server.store.DeleteOrphanReaderCommentTombstones(ctx)
		if err != nil {
			return result, err
		}
		result.TombstonesDeleted += deleted
		if deleted == 0 {
			break
		}
	}
	if result.HashesCleared, err = server.store.ClearOldReaderCommentNetworkHashes(ctx, now.Add(-readerCommentNetworkHashTTL)); err != nil {
		return result, err
	}
	if result.KeysDeleted, err = server.store.DeleteExpiredCommenterKeys(ctx, now); err != nil {
		return result, err
	}
	result.CommentersDeleted, err = server.store.DeleteStaleCommenters(ctx, db.DeleteStaleCommentersParams{StaleBefore: now.Add(-commenterStaleTTL), SpamSince: now.Add(-commenterSpamMemory)})
	return result, err
}
