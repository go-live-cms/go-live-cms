// collab_internal_client holds the API's calls TO the collab server's
// internal HTTP endpoints (the other direction from internal_routes.go).
//
// flushCollabDoc before a publish fails the publish when it fails (#206).
// recheckCollabUser after a role change or removal (#333) is best effort: the
// collab server's periodic re-check (#313) catches up if it fails. Both use
// COLLAB_INTERNAL_URL and "Authorization: Bearer <COLLAB_INTERNAL_SECRET>" and
// forward the request id.
package api

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// collabRecheckTimeout bounds the access re-check request. The collab server
// answers as soon as it has queued the lookups.
const collabRecheckTimeout = 5 * time.Second

// collabFlushTimeout bounds the flush publish waits for. The collab server
// stores a loaded document within its debounce window anyway, so a flush that
// takes longer than this means it is unhealthy.
const collabFlushTimeout = 5 * time.Second

// flushCollabDoc asks the Hocuspocus server to store post-<id> now and waits
// for it, so block_doc holds every edit made before the publish. The server
// answers 200 when the store finished or the document isn't loaded (nothing
// to flush). Anything else, including a timeout, is an error: publishing
// then would snapshot stale content.
//
// NewServer has checked that the URL and secret are set.
func (server *Server) flushCollabDoc(ctx context.Context, postID int64, requestID string) error {
	ctx, cancel := context.WithTimeout(ctx, server.collabFlushTimeout)
	defer cancel()

	return server.postCollabInternal(ctx, fmt.Sprintf("/internal/documents/post-%d/flush", postID), requestID)
}

// recheckCollabUser asks the collab server to look up the access of every open
// connection the user has now, instead of at its next periodic re-check (up to
// COLLAB_ACCESS_RECHECK_MS later): a demoted editor's documents turn read-only
// and a removed member's connections close right away. Call it after the change
// commits. Runs after the response (runInBackground), so a slow or down collab
// server never delays it; a failure is only logged.
func (server *Server) recheckCollabUser(requestID string, userID int64) {
	server.runInBackground(requestID, "collab_recheck", func() {
		ctx, cancel := context.WithTimeout(context.Background(), collabRecheckTimeout)
		defer cancel()
		err := server.postCollabInternal(ctx, fmt.Sprintf("/internal/users/%d/recheck", userID), requestID)
		if err != nil {
			logger := server.logger
			if logger == nil {
				logger = slog.Default()
			}
			logger.Warn("collab_recheck_failed", requestIDKey, requestID, "user_id", userID, "error", err.Error())
		}
	})
}

// postCollabInternal POSTs to one of the collab server's internal endpoints and
// fails on anything but a 200.
func (server *Server) postCollabInternal(ctx context.Context, path, requestID string) error {
	url := server.config.CollabInternalURL + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set(authorizationHeaderKey, "Bearer "+server.config.CollabInternalSecret)
	if requestID != "" {
		req.Header.Set(requestIDHeader, requestID)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// Drain (bounded) so the connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("collab %s: unexpected status %d", path, resp.StatusCode)
	}
	return nil
}
