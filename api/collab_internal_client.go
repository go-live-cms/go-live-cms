// collab_internal_client holds the API's calls TO the collab server's
// internal HTTP endpoints (the other direction from internal_routes.go).
//
// Both use COLLAB_INTERNAL_URL and "Authorization: Bearer
// <COLLAB_INTERNAL_SECRET>" and forward the request id, and which one runs
// depends on COLLAB_BACKEND (#206):
//   - y-websocket: triggerCollabSquash after a publish, best effort.
//   - hocuspocus: flushCollabDoc before a publish, which fails the publish
//     when it fails.
package api

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

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
// Only used under COLLAB_BACKEND=hocuspocus, where NewServer has checked that
// the URL and secret are set.
func (server *Server) flushCollabDoc(ctx context.Context, postID int64, requestID string) error {
	ctx, cancel := context.WithTimeout(ctx, server.collabFlushTimeout)
	defer cancel()

	url := fmt.Sprintf("%s/internal/documents/post-%d/flush", server.config.CollabInternalURL, postID)
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
		return fmt.Errorf("collab flush: unexpected status %d", resp.StatusCode)
	}
	return nil
}

// triggerCollabSquash fires a best-effort async squash request to the
// y-websocket collaboration server for the given postID. It runs in a
// goroutine and never blocks or fails the caller. Squash merges all LevelDB
// update entries for the document into a single snapshot, preventing
// unbounded log growth. Hocuspocus stores full states, so it has no squash.
//
// Silently skips if COLLAB_INTERNAL_URL or COLLAB_INTERNAL_SECRET is not
// configured. requestID (the publish request's) is forwarded as X-Request-ID
// so the WS server's squash log line can be matched to it.
func (server *Server) triggerCollabSquash(postID int64, requestID string) {
	// NewServer trimmed trailing slashes, so URLs like "http://websocket:1234/"
	// don't produce "//_internal/..." (which the WS server's route regex would
	// not match, silently breaking squash-on-publish).
	collabURL := server.config.CollabInternalURL
	secret := server.config.CollabInternalSecret
	if collabURL == "" || secret == "" {
		return
	}

	logger := slog.Default()
	if server.logger != nil {
		logger = server.logger
	}
	go func() {
		docName := fmt.Sprintf("post-%d", postID)
		url := fmt.Sprintf("%s/_internal/documents/%s/squash", collabURL, docName)
		log := logger.With(requestIDKey, requestID, "doc", docName)

		req, err := http.NewRequest(http.MethodPost, url, nil)
		if err != nil {
			log.Warn("collab squash: failed to build request", "error", err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		if requestID != "" {
			req.Header.Set(requestIDHeader, requestID)
		}

		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			log.Warn("collab squash: request failed", "error", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			log.Warn("collab squash: unexpected status", "status", resp.StatusCode)
			return
		}
		log.Info("collab squash complete")
	}()
}
