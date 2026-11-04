package api

import (
	"context"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Activity retention (#324). The activity log keeps ACTIVITY_RETENTION of history
// (default 90 days: Home reads the last few weeks, and a quarter covers "what
// happened to this post lately"); every replica prunes older events once an hour,
// in batches, so no run holds a long lock. Deleting is idempotent, so replicas
// pruning at once only repeat each other's work. 0 keeps everything.
//
// What is kept is ids and non-personal details (activity.go), so a removed
// member's events stay with a NULL actor until they age out.

const (
	activityPruneInterval = time.Hour
	activityPruneBatch    = 5000
	activityPruneTimeout  = 30 * time.Second
)

// RunActivityRetention prunes events older than retention every interval
// until ctx is done (main.go). retention 0 turns it off.
func (server *Server) RunActivityRetention(ctx context.Context, retention time.Duration) {
	if retention <= 0 {
		server.logger.Info("activity retention off: events are kept forever")
		return
	}
	ticker := time.NewTicker(activityPruneInterval)
	defer ticker.Stop()
	for {
		server.pruneActivityLogged(ctx, retention)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (server *Server) pruneActivityLogged(ctx context.Context, retention time.Duration) {
	deleted, err := server.pruneActivity(ctx, time.Now().Add(-retention))
	if err != nil {
		if ctx.Err() == nil { // not just shutting down
			server.logger.Warn("activity_prune_failed", "deleted", deleted, "error", err)
		}
		return
	}
	if deleted > 0 {
		server.logger.Info("activity pruned", "deleted", deleted, "retention", retention.String())
	}
}

// pruneActivity deletes every event created before cutoff, a batch at a time,
// and returns how many went.
func (server *Server) pruneActivity(ctx context.Context, cutoff time.Time) (int64, error) {
	var total int64
	for ctx.Err() == nil {
		batchCtx, cancel := context.WithTimeout(ctx, activityPruneTimeout)
		n, err := server.store.DeleteActivityBefore(batchCtx, db.DeleteActivityBeforeParams{Cutoff: cutoff, BatchSize: activityPruneBatch})
		cancel()
		total += n
		if err != nil {
			return total, err
		}
		if n < activityPruneBatch {
			return total, nil
		}
	}
	return total, ctx.Err()
}
