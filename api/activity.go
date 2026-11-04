package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Activity log (#324, 000034): one row per notable event, read by GET /activity
// and Home ("Continue where you left off", the Activity feed). Other features
// read it too: review requests (#323), access requests (#321), per-block "last
// edited by" (#328). To record a new kind of event, add its verb to
// db/sqlc/activity.go and call server.recordActivity (or recordRequestActivity
// in a handler) after the change succeeds.
//
// When: right after the change commits, from the handler. The writes here are
// often several statements (an update, then its media and terms), and most are
// not one transaction, so an event can't be part of one; recording after the
// commit means an event never describes a change that was rolled back. A failed
// insert is logged (activity_record_failed) and never fails the request: the
// change stands, and at worst the feed misses one line. The collab server's
// "edited" event is the exception: StorePostCollabTx records it under the post
// lock (EditActivityWindow), which is what keeps its throttle exact.
//
// Privacy (api/CLAUDE.md, logging policy): actor and object are ids; the payload
// holds only non-personal details (a role, a version number, setting names, a
// time, a count). Never names, emails, titles, content, IPs or user agents: the
// feed joins the current names and titles at read time, under the reader's
// permissions. The table's CHECK caps a payload at 1 KiB.
//
// Retention: ACTIVITY_RETENTION (default 90 days) in activity_retention.go.

// activityEditWindow is the throttle for high-volume events ("edited" through
// collab, "updated" through the REST settings saves): at most one per member and
// post per window. Home's "Continue where you left off" reads them, so it is up
// to one window behind, except for the last collab editor (post_ydoc_state).
const activityEditWindow = 10 * time.Minute

// activityWriteTimeout bounds one event's insert. It runs after the response's
// change, on a context that ignores the client hanging up.
const activityWriteTimeout = 2 * time.Second

// activityWriter is where events go: the store, or a test's recorder.
type activityWriter interface {
	CreateActivity(ctx context.Context, arg db.CreateActivityParams) (db.Activity, error)
	CreateActivityThrottled(ctx context.Context, arg db.CreateActivityThrottledParams) (int64, error)
}

// newActivityWriter picks NewServer's activityWriter: the store. The package's
// tests replace it (test_utils_test.go) so handler tests on a mock store record
// events in memory instead of having to expect every insert.
var newActivityWriter = func(store db.Store) activityWriter {
	if store == nil {
		return nil
	}
	return store
}

// activityEvent is one event to record.
type activityEvent struct {
	// ActorID is who did it; 0 = the system.
	ActorID    int64
	Verb       string
	ObjectType string
	ObjectID   int64
	// Payload is a small set of non-personal details (see the privacy note
	// above); nil = {}.
	Payload map[string]any
	// Throttled records at most one event per actor, verb and object per
	// server.activityEditWindow. Needs an actor.
	Throttled bool
}

// recordActivity writes ev after the change it describes; see the header for
// why it never fails the caller.
func (server *Server) recordActivity(ctx context.Context, log *slog.Logger, ev activityEvent) {
	if server.activity == nil {
		return
	}
	payload := json.RawMessage(`{}`)
	if len(ev.Payload) > 0 {
		encoded, err := json.Marshal(ev.Payload)
		if err != nil {
			log.Warn("activity_record_failed", "verb", ev.Verb, "object_type", ev.ObjectType, "object_id", ev.ObjectID, "error", err)
			return
		}
		payload = encoded
	}

	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), activityWriteTimeout)
	defer cancel()

	var err error
	if ev.Throttled && ev.ActorID != 0 {
		_, err = server.activity.CreateActivityThrottled(ctx, db.CreateActivityThrottledParams{
			Verb:          ev.Verb,
			ObjectType:    ev.ObjectType,
			ObjectID:      ev.ObjectID,
			Payload:       payload,
			ActorID:       ev.ActorID,
			WindowSeconds: server.activityEditWindow.Seconds(),
		})
	} else {
		_, err = server.activity.CreateActivity(ctx, db.CreateActivityParams{
			ActorID:    sql.NullInt64{Int64: ev.ActorID, Valid: ev.ActorID != 0},
			Verb:       ev.Verb,
			ObjectType: ev.ObjectType,
			ObjectID:   ev.ObjectID,
			Payload:    payload,
		})
	}
	if err != nil {
		log.Warn("activity_record_failed", "verb", ev.Verb, "object_type", ev.ObjectType, "object_id", ev.ObjectID, "error", err)
	}
}

// recordRequestActivity records ev for an authenticated request; the actor is
// the caller unless ev names one.
func (server *Server) recordRequestActivity(c *gin.Context, ev activityEvent) {
	if ev.ActorID == 0 {
		if payload, ok := c.Get(authorizationPayloadKey); ok && payload != nil {
			ev.ActorID = getAuthPayload(c).UserID
		}
	}
	server.recordActivity(c.Request.Context(), server.requestLog(c), ev)
}

// postActivity is the common case: verb on post id by the caller.
func (server *Server) recordPostActivity(c *gin.Context, verb string, postID int64, payload map[string]any) {
	server.recordRequestActivity(c, activityEvent{Verb: verb, ObjectType: db.ActivityObjectPost, ObjectID: postID, Payload: payload})
}

// recordMediaActivity is verb on a media file by the caller; the payload keeps
// its kind (the MIME type), never its name.
func (server *Server) recordMediaActivity(c *gin.Context, verb string, media db.Medium) {
	server.recordRequestActivity(c, activityEvent{Verb: verb, ObjectType: db.ActivityObjectMedia, ObjectID: media.ID, Payload: map[string]any{"mime_type": media.MimeType}})
}

// recordPostUpdated is a settings or details save on a post (PUT /posts/:id,
// /seo, the featured image): throttled like collab edits, since the editor's
// settings panel saves as you type.
func (server *Server) recordPostUpdated(c *gin.Context, postID int64) {
	server.recordRequestActivity(c, activityEvent{Verb: db.ActivityUpdated, ObjectType: db.ActivityObjectPost, ObjectID: postID, Throttled: true})
}
