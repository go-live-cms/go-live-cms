package api

import (
	"context"
	"time"
)

// Pending signups (#191) hold an email, a name and a password hash nobody has
// confirmed. RequestSignupTx deletes expired ones whenever a new signup is
// stored, but a site that closes signup (or gets no more) would keep them for
// good, so every replica also deletes them once an hour. Deleting is idempotent.

const (
	signupPruneInterval = time.Hour
	signupPruneTimeout  = 30 * time.Second
)

// RunSignupRequestPrune deletes expired signup requests every interval until ctx
// is done (main.go). interval <= 0 uses signupPruneInterval.
func (server *Server) RunSignupRequestPrune(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = signupPruneInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		server.pruneSignupRequests(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// pruneSignupRequests runs one prune and logs the outcome.
func (server *Server) pruneSignupRequests(ctx context.Context) {
	pruneCtx, cancel := context.WithTimeout(ctx, signupPruneTimeout)
	defer cancel()
	deleted, err := server.store.DeleteStaleSignupRequests(pruneCtx)
	if err != nil {
		if ctx.Err() == nil { // not just shutting down
			server.logger.Warn("signup_prune_failed", "error", err)
		}
		return
	}
	if deleted > 0 {
		server.logger.Info("expired signup requests deleted", "deleted", deleted)
	}
}
