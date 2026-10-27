// collab_internal_client holds the API's calls TO the collab server's
// internal HTTP endpoints (the other direction from internal_routes.go).
//
// Today that is one call, flushCollabDoc before a publish, which fails the
// publish when it fails (#206). It uses COLLAB_INTERNAL_URL and
// "Authorization: Bearer <COLLAB_INTERNAL_SECRET>" and forwards the request id.
package api

import (
	"context"
	"fmt"
	"io"
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
// NewServer has checked that the URL and secret are set.
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
