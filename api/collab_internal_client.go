// collab_internal_client holds the API's calls TO the collab server's
// internal HTTP endpoints (the other direction from internal_routes.go).
//
// flushCollabDoc before a publish fails the publish when it fails (#206).
// restoreCollabVersion (#286) is the server-side restore of a version.
// recheckCollabUser after a role change or removal (#333) is best effort: the
// collab server's periodic re-check (#313) catches up if it fails. Both use
// COLLAB_INTERNAL_URL and "Authorization: Bearer <COLLAB_INTERNAL_SECRET>" and
// forward the request id.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// collabRecheckTimeout bounds the access re-check request. The collab server
// answers as soon as it has queued the lookups.
const collabRecheckTimeout = 5 * time.Second

// collabFlushTimeout bounds the flush publish waits for. The collab server
// stores a loaded document within its debounce window anyway, so a flush that
// takes longer than this means it is unhealthy.
const collabFlushTimeout = 5 * time.Second

// collabRestoreTimeout bounds a server-side restore (#286). The collab server
// may have to load the document (GET /internal/posts/:id/collab, 10s at most)
// before it stores it (PUT, 10s at most), so this is longer than both together:
// giving up first could report a failure for a restore that then lands.
const collabRestoreTimeout = 30 * time.Second

// collabRestoreBodyLimit is what the collab server reads at most
// (RESTORE_BODY_LIMIT in web/collab-server/internal.ts).
const collabRestoreBodyLimit = 8 << 20

// collabRestoreResult is the collab server's answer to a restore that landed:
// the version is in the live document and stored.
type collabRestoreResult struct {
	Revision *int64 `json:"revision"`
	// BlockDoc is "written", or "unchanged" when the working copy already was the version.
	BlockDoc string `json:"block_doc"`
	// Dropped counts the version's blocks the editor can't show (#213), kept hidden.
	Dropped int `json:"dropped"`
}

// collabRestoreError is a restore that didn't land. Status is the collab
// server's answer (0 when it couldn't be reached or didn't answer in time) and
// Reason its code (internal.ts RESTORE_STATUS).
type collabRestoreError struct {
	Status  int
	Reason  string
	Timeout bool
	Err     error
}

func (e *collabRestoreError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("collab restore: %v", e.Err)
	}
	return fmt.Sprintf("collab restore: status %d (%s)", e.Status, e.Reason)
}

// restoreCollabVersion asks the collab server to put a stored version into
// post-<id>'s working copy (#286): it replaces the live document's content in
// one Yjs transaction and stores it, whether or not anyone has the post open,
// and answers only once both happened; any error means neither did (except a
// timeout, which can't tell). Rule 11 holds: the collab server writes
// block_doc, never the API. userID is who restored it (per-block attribution,
// #328).
func (server *Server) restoreCollabVersion(ctx context.Context, postID, userID int64, blockDoc json.RawMessage, requestID string) (collabRestoreResult, error) {
	ctx, cancel := context.WithTimeout(ctx, server.collabRestoreTimeout)
	defer cancel()

	body, err := json.Marshal(struct {
		BlockDoc json.RawMessage `json:"block_doc"`
		UserID   string          `json:"user_id"`
	}{BlockDoc: blockDoc, UserID: strconv.FormatInt(userID, 10)})
	if err != nil {
		return collabRestoreResult{}, &collabRestoreError{Err: err}
	}
	if len(body) > collabRestoreBodyLimit {
		return collabRestoreResult{}, &collabRestoreError{Status: http.StatusRequestEntityTooLarge, Reason: "too-large"}
	}

	url := fmt.Sprintf("%s/internal/documents/post-%d/restore", server.config.CollabInternalURL, postID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return collabRestoreResult{}, &collabRestoreError{Err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(authorizationHeaderKey, "Bearer "+server.config.CollabInternalSecret)
	if requestID != "" {
		req.Header.Set(requestIDHeader, requestID)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return collabRestoreResult{}, &collabRestoreError{Err: err, Timeout: errors.Is(ctx.Err(), context.DeadlineExceeded)}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return collabRestoreResult{}, &collabRestoreError{Status: resp.StatusCode, Err: err, Timeout: errors.Is(ctx.Err(), context.DeadlineExceeded)}
	}
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(raw, &refusal)
		return collabRestoreResult{}, &collabRestoreError{Status: resp.StatusCode, Reason: refusal.Reason}
	}
	var result collabRestoreResult
	if err := json.Unmarshal(raw, &result); err != nil {
		// It answered 200: the restore landed, whatever else the body says.
		return collabRestoreResult{BlockDoc: "written"}, nil
	}
	return result, nil
}

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

// flushCollabTemplate is flushCollabDoc for a template or part, template-<id> (#490,
// design 7.2): the same route with the wider name check. Publishing the site design
// (#492) calls it for every item before reading block_doc.
func (server *Server) flushCollabTemplate(ctx context.Context, templateID int64, requestID string) error {
	ctx, cancel := context.WithTimeout(ctx, server.collabFlushTimeout)
	defer cancel()

	return server.postCollabInternal(ctx, fmt.Sprintf("/internal/documents/template-%d/flush", templateID), requestID)
}

// recheckCollabUser asks the collab server to look up the access of every open
// connection the user has now, instead of at its next periodic re-check (up to
// COLLAB_ACCESS_RECHECK_MS later): a demoted editor's documents turn read-only
// and a removed member's connections close right away. Call it after the change
// commits. Runs after the response (runInBackground), so a slow or down collab
// server never delays it; a failure is only logged.
func (server *Server) recheckCollabUser(requestID string, userID int64) {
	server.recheckCollab(requestID, "collab_recheck", fmt.Sprintf("/internal/users/%d/recheck", userID), "user_id", userID)
}

// recheckCollabDoc asks the collab server to look up the access of every open
// connection to post-<id> now (#327): after a post moves to the trash the API
// answers 410 for it, so the server closes them with post-trashed instead of at
// its next periodic re-check. Best effort and after the response, like
// recheckCollabUser; the periodic re-check closes them if this call fails.
func (server *Server) recheckCollabDoc(requestID string, postID int64) {
	server.recheckCollab(requestID, "collab_doc_recheck", fmt.Sprintf("/internal/documents/post-%d/recheck", postID), "post_id", postID)
}

// recheckCollabTemplate is recheckCollabDoc for template-<id> (#492): after a template or
// part is deleted the access lookup answers 404 for it, so its open editors close now
// instead of at the next periodic re-check. Best effort, after the response.
func (server *Server) recheckCollabTemplate(requestID string, templateID int64) {
	server.recheckCollab(requestID, "collab_doc_recheck", fmt.Sprintf("/internal/documents/template-%d/recheck", templateID), "template_id", templateID)
}

// notifyCollabComments asks the collab server to tell post-<id>'s open editors
// that its comments changed (#192): it broadcasts {"type":"comments"} to the
// doc's connections and the editors refetch GET /posts/:id/comments. Best effort
// and after the response like the re-checks: editors also refetch on reconnect
// and when the tab is shown again, so a lost nudge only delays the update.
func (server *Server) notifyCollabComments(requestID string, postID int64) {
	server.recheckCollab(requestID, "collab_comments_nudge", fmt.Sprintf("/internal/documents/post-%d/comments", postID), "post_id", postID)
}

// recheckCollab is the best-effort POST both re-checks (and the comments nudge) make, after the response
// (runInBackground); a failure logs <task>_failed with the subject (idKey, id).
func (server *Server) recheckCollab(requestID, task, path, idKey string, id int64) {
	server.runInBackground(requestID, task, func() {
		ctx, cancel := context.WithTimeout(context.Background(), collabRecheckTimeout)
		defer cancel()
		if err := server.postCollabInternal(ctx, path, requestID); err != nil {
			logger := server.logger
			if logger == nil {
				logger = slog.Default()
			}
			logger.Warn(task+"_failed", requestIDKey, requestID, idKey, id, "error", err.Error())
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
