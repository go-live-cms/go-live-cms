// Package api — Scheduled publishing (#147): the scheduler
//
// Every ScheduledPublishInterval (30s) each API process claims the scheduled
// posts that are due and publishes them through the Publish button's path:
// flush the collab document (collab_internal_client.go), then
// PublishScheduledPostTx, which is PublishPostTx's publish (a version, the
// published snapshot, post_status "published") behind a check that the post is
// still scheduled under this claim.
//
// Exactly once, with any number of replicas:
//   - ClaimDueScheduledPosts takes a due row FOR UPDATE SKIP LOCKED and stamps a
//     lease (publish_next_attempt_at), so the others skip it. The row lock is
//     only held for that statement: the flush can't run under it, because the
//     collab store it triggers locks the same row.
//   - The lease value is the claim's fencing token. The publish transaction
//     locks the row and goes ahead only if it is still scheduled under that
//     token, so a cancel, a reschedule, a publish by hand or a second claim
//     after a lease ran out (this replica died) all make it publish nothing.
//
// A failed attempt (the collab server can't flush, the 503 case of the Publish
// button, or the transaction fails) is recorded on the post (publish_failed_at,
// publish_error: the editor's "Scheduled publish failed") and retried with
// backoff, 30s up to every 10 minutes, until it publishes or someone changes
// the schedule. A replica that dies mid-attempt leaves its lease, so the post
// is retried when the lease ends. A post is never left scheduled in silence.
//
// Scheduled updates (#335) run in the same rounds, with the same claim, lease,
// fencing and backoff, on post_scheduled_updates rows: ClaimDueScheduledUpdates,
// then PublishScheduledUpdateTx, which publishes the update's frozen snapshot as
// the next version. Its content was flushed and frozen when it was scheduled, so
// there is no flush here: what goes live is what the editor scheduled, never the
// working copy as it is at the time. A failure (update_failed) is recorded on the
// row and shown as scheduled_update.failure.
package api

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	// scheduledPublishLease is how long a claim keeps other replicas off a post:
	// well past an attempt's own bound, so it only ends if the replica died.
	scheduledPublishLease = 2 * time.Minute
	// scheduledPublishTimeout bounds one attempt (flush and transaction).
	scheduledPublishTimeout = 30 * time.Second
	// scheduledPublishMaxPerRound stops one round from running unbounded; the
	// next round picks up the rest.
	scheduledPublishMaxPerRound = 100

	// Reasons recorded in publish_error, shown by the editor.
	scheduledPublishCollabFlushFailed = "collab_flush_failed"
	scheduledPublishFailed            = "publish_failed"
	// The reason recorded on a scheduled update (#335) whose apply failed.
	scheduledUpdateFailed = "update_failed"
)

// scheduledPublishBackoff is the wait after the Nth failed attempt; the last
// one repeats.
var scheduledPublishBackoff = []time.Duration{
	30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute,
}

// scheduledPublishRetryAfter is the wait before the next attempt after
// attempts failed ones.
func scheduledPublishRetryAfter(attempts int32) time.Duration {
	i := int(attempts) - 1
	if i < 0 {
		i = 0
	}
	if i >= len(scheduledPublishBackoff) {
		i = len(scheduledPublishBackoff) - 1
	}
	return scheduledPublishBackoff[i]
}

// RunScheduledPublishing publishes due scheduled posts every interval until ctx
// is done, then returns once the attempt in flight has finished: it isn't cut
// short by ctx. If the process is killed first (Docker's stop grace period is
// 10s), the publish transaction rolls back as a whole and the claim's lease
// runs out, so the post is tried again then. interval 0 turns it off.
// main.go runs it beside the HTTP listeners.
func (server *Server) RunScheduledPublishing(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		server.logger.Info("scheduled publishing is off in this process (SCHEDULED_PUBLISH_INTERVAL=0)")
		return
	}
	server.logger.Info("scheduled publishing started", "interval", interval.String())
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		server.publishDueScheduledPosts(ctx)
		server.applyDueScheduledUpdates(ctx)
		select {
		case <-ctx.Done():
			server.logger.Info("scheduled publishing stopped")
			return
		case <-ticker.C:
		}
	}
}

// publishDueScheduledPosts is one round: claim and publish due posts one at a
// time until none is due, ctx is done or the round's cap is reached. One at a
// time, so a shutdown leaves nothing claimed but the post in flight, and
// replicas share a backlog. Returns how many it published.
func (server *Server) publishDueScheduledPosts(ctx context.Context) int {
	published := 0
	for i := 0; i < scheduledPublishMaxPerRound && ctx.Err() == nil; i++ {
		claims, err := server.store.ClaimDueScheduledPosts(ctx, db.ClaimDueScheduledPostsParams{
			LeaseSeconds: scheduledPublishLease.Seconds(),
			MaxPosts:     1,
		})
		if err != nil {
			if ctx.Err() == nil {
				server.logger.Warn("claiming due scheduled posts failed", "error", err)
			}
			return published
		}
		if len(claims) == 0 {
			return published
		}
		if server.publishScheduledPost(ctx, claims[0]) {
			published++
		}
	}
	return published
}

// publishScheduledPost makes one attempt at a claimed post and reports whether
// it published. Each attempt gets its own request id, sent with the collab
// flush and on every log line, like a request's.
func (server *Server) publishScheduledPost(ctx context.Context, claim db.ClaimDueScheduledPostsRow) bool {
	requestID := uuid.NewString()
	log := server.logger.With(requestIDKey, requestID, "post_id", claim.ID, "attempt", claim.PublishAttempts)
	if !claim.Claim.Valid {
		// The claim always sets it; nothing to fence with otherwise.
		log.Error("scheduled publish claim has no lease")
		return false
	}

	// Not cancelled with ctx: on shutdown the attempt in flight finishes (or, if the
	// process is killed, rolls back and is retried after the lease).
	attemptCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), scheduledPublishTimeout)
	defer cancel()

	// As publishPost: block_doc must hold every edit before it's snapshotted.
	if err := server.flushCollabDoc(attemptCtx, claim.ID, requestID); err != nil {
		server.recordScheduledPublishFailure(attemptCtx, log, claim, scheduledPublishCollabFlushFailed, err)
		return false
	}

	version, err := server.store.PublishScheduledPostTx(attemptCtx, db.PublishScheduledPostTxParams{
		PostID:       claim.ID,
		Claim:        claim.Claim.Time,
		ContentMedia: publishedContentMedia,
	})
	if errors.Is(err, db.ErrScheduleChanged) {
		log.Info("scheduled publish skipped: the post's schedule changed meanwhile")
		return false
	}
	if err != nil {
		server.recordScheduledPublishFailure(attemptCtx, log, claim, scheduledPublishFailed, err)
		return false
	}

	attrs := []any{"version_no", version.VersionNo}
	if claim.PublishAt.Valid {
		attrs = append(attrs,
			"publish_at", claim.PublishAt.Time.UTC().Format(time.RFC3339),
			"delay_ms", time.Since(claim.PublishAt.Time).Milliseconds())
	}
	log.Info("scheduled post published", attrs...)
	return true
}

// recordScheduledPublishFailure stores the failed attempt on the post (the
// editor shows it) with the next try after the backoff. If even that fails,
// the claim's lease still runs out and the post is tried again then.
func (server *Server) recordScheduledPublishFailure(ctx context.Context, log *slog.Logger, claim db.ClaimDueScheduledPostsRow, reason string, cause error) {
	retry := scheduledPublishRetryAfter(claim.PublishAttempts)
	log.Warn("scheduled publish failed", "reason", reason, "error", cause, "retry_in", retry.String())
	rows, err := server.store.RecordScheduledPublishFailure(ctx, db.RecordScheduledPublishFailureParams{
		Reason:            reason,
		RetryAfterSeconds: retry.Seconds(),
		ID:                claim.ID,
		Claim:             claim.Claim.Time,
	})
	if err != nil {
		log.Error("recording a failed scheduled publish failed; retried when the claim expires",
			"error", err, "lease", scheduledPublishLease.String())
		return
	}
	if rows == 0 {
		log.Info("failed scheduled publish not recorded: the post's schedule changed meanwhile")
	}
}

// applyDueScheduledUpdates is publishDueScheduledPosts for scheduled updates
// (#335): claim and apply due updates one at a time until none is due, ctx is
// done or the round's cap is reached. Returns how many it applied.
func (server *Server) applyDueScheduledUpdates(ctx context.Context) int {
	applied := 0
	for i := 0; i < scheduledPublishMaxPerRound && ctx.Err() == nil; i++ {
		claims, err := server.store.ClaimDueScheduledUpdates(ctx, db.ClaimDueScheduledUpdatesParams{
			LeaseSeconds: scheduledPublishLease.Seconds(),
			MaxPosts:     1,
		})
		if err != nil {
			if ctx.Err() == nil {
				server.logger.Warn("claiming due scheduled updates failed", "error", err)
			}
			return applied
		}
		if len(claims) == 0 {
			return applied
		}
		if server.applyScheduledUpdate(ctx, claims[0]) {
			applied++
		}
	}
	return applied
}

// applyScheduledUpdate makes one attempt at a claimed update and reports whether
// it went live. Its own request id on every log line, as publishScheduledPost.
func (server *Server) applyScheduledUpdate(ctx context.Context, claim db.ClaimDueScheduledUpdatesRow) bool {
	requestID := uuid.NewString()
	log := server.logger.With(requestIDKey, requestID, "post_id", claim.PostID, "attempt", claim.Attempts)
	if !claim.Claim.Valid {
		log.Error("scheduled update claim has no lease")
		return false
	}
	attemptCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), scheduledPublishTimeout)
	defer cancel()

	version, err := server.store.PublishScheduledUpdateTx(attemptCtx, db.PublishScheduledUpdateTxParams{
		PostID:       claim.PostID,
		Claim:        claim.Claim.Time,
		ContentMedia: publishedContentMedia,
	})
	if errors.Is(err, db.ErrScheduleChanged) {
		log.Info("scheduled update skipped: it changed or ended meanwhile")
		return false
	}
	if err != nil {
		retry := scheduledPublishRetryAfter(claim.Attempts)
		log.Warn("scheduled update failed", "reason", scheduledUpdateFailed, "error", err, "retry_in", retry.String())
		rows, recErr := server.store.RecordScheduledUpdateFailure(attemptCtx, db.RecordScheduledUpdateFailureParams{
			Reason:            scheduledUpdateFailed,
			RetryAfterSeconds: retry.Seconds(),
			PostID:            claim.PostID,
			Claim:             claim.Claim.Time,
		})
		switch {
		case recErr != nil:
			log.Error("recording a failed scheduled update failed; retried when the claim expires",
				"error", recErr, "lease", scheduledPublishLease.String())
		case rows == 0:
			log.Info("failed scheduled update not recorded: it changed meanwhile")
		}
		return false
	}
	log.Info("scheduled update published",
		"version_no", version.VersionNo,
		"update_at", claim.UpdateAt.UTC().Format(time.RFC3339),
		"delay_ms", time.Since(claim.UpdateAt).Milliseconds())
	return true
}
