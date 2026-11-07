package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrCollabRevisionConflict is returned by StorePostCollabTx when the caller
// passed a BaseRevision and posts.block_revision has moved past it: something
// wrote block_doc around the collab server since it loaded the document.
var ErrCollabRevisionConflict = errors.New("block_revision changed since the collab document was loaded")

// ErrCollabBaseRevisionRequired is returned by StorePostCollabTx for a
// state-only store (no BlockDoc) without a BaseRevision.
var ErrCollabBaseRevisionRequired = errors.New("a state-only collab store needs a base revision")

type StorePostCollabTxParams struct {
	PostID int64
	// State is the full Yjs document (Y.encodeStateAsUpdate).
	State []byte
	Epoch uuid.UUID
	// BlockDoc is the derived, already validated and sanitized Block Spec v1
	// document. nil stores the Yjs state only (the server's derived doc
	// failed validation) and leaves block_doc and block_revision alone.
	BlockDoc json.RawMessage
	// ContentMedia are BlockDoc's image blocks in document order; the content
	// links (post_media order > 0, and every link's blocks) are synced to them.
	// Ignored without BlockDoc.
	ContentMedia []ContentMediaUse
	// BaseRevision, when set, must equal posts.block_revision or nothing is
	// written (ErrCollabRevisionConflict). Required without BlockDoc
	// (ErrCollabBaseRevisionRequired): the state is then recorded against the
	// current revision, which is only right if nothing wrote block_doc since
	// the server loaded it. Otherwise a stale state would pass the load-time
	// revision guard.
	BaseRevision sql.NullInt64
	LastEditorID sql.NullInt64
	// EditActivityWindow, when positive, records an "edited" activity event
	// (#324) for LastEditorID on a store that writes BlockDoc, at most one per
	// editor and post per window. It runs under the post's row lock, so two
	// stores of one post can't both record one. 0 records nothing.
	EditActivityWindow time.Duration
	// BlockIDs are every key of BlockDoc's "blocks". With BlockDoc, the post's
	// post_block_edits rows of any other block are deleted (#328). Ignored
	// without BlockDoc.
	BlockIDs []string
	// BlockEdits attribute the blocks this store changed (#328): upserted into
	// post_block_edits with BlockDoc, never without it, so a state-only store
	// touches no attribution. Each BlockID must be one of BlockIDs (the caller
	// checks). A user that no longer exists is stored as NULL.
	BlockEdits []PostBlockEditInput
	// Mentions are every (block, member) mention in BlockDoc (#320), with who typed it
	// when this store changed that block (MentionedBy, else 0). Those the ledger doesn't
	// have yet are recorded (post_mention_notifications) and returned in NewMentions.
	// Ignored without BlockDoc.
	Mentions []MentionInput
	// Reminders are every reminder chip in BlockDoc (#320). With BlockDoc, the post's
	// pending reminders that aren't among them are deleted, and those with an owner
	// (UserID, else 0: nobody typed it in this store) and a time still ahead are added.
	// Ignored without BlockDoc.
	Reminders []ReminderInput
	// Now decides which reminders are still ahead (time.Now when zero).
	Now time.Time
}

// MentionInput is one mention of a member in a block of a collab store's doc (#320).
type MentionInput struct {
	BlockID     string
	UserID      int64
	MentionedBy int64
}

// ReminderInput is one reminder chip in a collab store's doc (#320).
type ReminderInput struct {
	BlockID string
	// RemindAt is the chip's day and time in the site's zone, as an instant.
	RemindAt time.Time
	// ChipDate (YYYY-MM-DD) and ChipTime (HH:MM) as the chip has them.
	ChipDate string
	ChipTime string
	// UserID owns it: who typed it in this store (0 = nobody known).
	UserID int64
}

// ReminderKey is how DeleteStalePostReminders names a reminder: its block, and its day and
// time as written (never the instant, which a change of the site's zone moves).
func ReminderKey(blockID, chipDate, chipTime string) string {
	return blockID + " " + chipDate + " " + chipTime
}

// PostBlockEditInput is one block's attribution in a collab store (#328).
type PostBlockEditInput struct {
	BlockID  string
	UserID   int64
	EditedAt time.Time
}

type StorePostCollabTxResult struct {
	// BlockRevision is posts.block_revision after the store, which the Yjs
	// state is now recorded against.
	BlockRevision int64
	// NewMentions are the mentions this store recorded for the first time (#320); the
	// caller emails those that are due.
	NewMentions []RecordPostMentionsRow
}

// StorePostCollabTx is the collab server's store (#206 / #280), all in one
// transaction: lock the post row, write block_doc with block_revision+1,
// sync the content media links, and upsert post_ydoc_state with the new
// revision. Because the state and block_doc commit together, the state's
// block_revision can only differ from the post's when something else wrote
// block_doc, which is exactly what the load-time revision guard detects.
//
// Media links are live fields (#135): they are synced only while the post is
// not published. publishPost syncs them from the published doc.
//
// Returns sql.ErrNoRows when the post does not exist.
func (store *SQLStore) StorePostCollabTx(ctx context.Context, arg StorePostCollabTxParams) (StorePostCollabTxResult, error) {
	var result StorePostCollabTxResult
	if arg.BlockDoc == nil && !arg.BaseRevision.Valid {
		return result, ErrCollabBaseRevisionRequired
	}

	err := store.execTx(ctx, func(q *Queries) error {
		post, err := q.LockPostForCollabStore(ctx, arg.PostID)
		if err != nil {
			return err
		}
		if arg.BaseRevision.Valid && arg.BaseRevision.Int64 != post.BlockRevision {
			return ErrCollabRevisionConflict
		}

		result.BlockRevision = post.BlockRevision
		if arg.BlockDoc != nil {
			result.BlockRevision, err = q.UpdatePostBlockDocFromCollab(ctx, UpdatePostBlockDocFromCollabParams{
				ID:       arg.PostID,
				BlockDoc: arg.BlockDoc,
			})
			if err != nil {
				return err
			}
			if !strings.EqualFold(post.PostStatus, "published") {
				if err := syncContentMedia(ctx, q, arg.PostID, arg.ContentMedia); err != nil {
					return err
				}
			}
			// Per-block attribution (#328): only with the block_doc it describes,
			// and the rows of blocks no longer in it go.
			if err := writeBlockEdits(ctx, q, arg); err != nil {
				return err
			}
			// Mentions and reminders (#320): with the block_doc they come from.
			if result.NewMentions, err = recordMentions(ctx, q, arg); err != nil {
				return err
			}
			if err := syncReminders(ctx, q, arg); err != nil {
				return err
			}
			// Only real edits (a block_doc store) count; the collab server sends
			// one only when the derived doc changed (#307).
			if arg.EditActivityWindow > 0 && arg.LastEditorID.Valid {
				if _, err := q.CreateActivityThrottled(ctx, CreateActivityThrottledParams{
					Verb:          ActivityEdited,
					ObjectType:    ActivityObjectPost,
					ObjectID:      arg.PostID,
					Payload:       json.RawMessage(`{}`),
					ActorID:       arg.LastEditorID.Int64,
					WindowSeconds: arg.EditActivityWindow.Seconds(),
				}); err != nil {
					return err
				}
			}
		}

		return q.UpsertPostYdocState(ctx, UpsertPostYdocStateParams{
			PostID:        arg.PostID,
			State:         arg.State,
			Epoch:         arg.Epoch,
			BlockRevision: result.BlockRevision,
			LastEditorID:  arg.LastEditorID,
		})
	})

	return result, err
}

// writeBlockEdits prunes the post's post_block_edits to arg.BlockIDs and upserts
// arg.BlockEdits, inside StorePostCollabTx (#328).
func writeBlockEdits(ctx context.Context, q *Queries, arg StorePostCollabTxParams) error {
	keep := arg.BlockIDs
	if keep == nil {
		keep = []string{}
	}
	if err := q.PrunePostBlockEdits(ctx, PrunePostBlockEditsParams{PostID: arg.PostID, KeepIds: keep}); err != nil {
		return err
	}
	if len(arg.BlockEdits) == 0 {
		return nil
	}
	params := UpsertPostBlockEditsParams{
		PostID:    arg.PostID,
		BlockIds:  make([]string, len(arg.BlockEdits)),
		UserIds:   make([]int64, len(arg.BlockEdits)),
		EditedAts: make([]string, len(arg.BlockEdits)),
	}
	for i, edit := range arg.BlockEdits {
		params.BlockIds[i] = edit.BlockID
		params.UserIds[i] = edit.UserID
		params.EditedAts[i] = edit.EditedAt.UTC().Format(time.RFC3339Nano)
	}
	return q.UpsertPostBlockEdits(ctx, params)
}

// recordMentions adds arg.Mentions to the ledger, inside StorePostCollabTx (#320).
func recordMentions(ctx context.Context, q *Queries, arg StorePostCollabTxParams) ([]RecordPostMentionsRow, error) {
	if len(arg.Mentions) == 0 {
		return nil, nil
	}
	params := RecordPostMentionsParams{
		PostID:      arg.PostID,
		BlockIds:    make([]string, len(arg.Mentions)),
		UserIds:     make([]int64, len(arg.Mentions)),
		MentionedBy: make([]int64, len(arg.Mentions)),
	}
	for i, m := range arg.Mentions {
		params.BlockIds[i] = m.BlockID
		params.UserIds[i] = m.UserID
		params.MentionedBy[i] = m.MentionedBy
	}
	return q.RecordPostMentions(ctx, params)
}

// syncReminders makes the post's pending reminders arg.Reminders, inside
// StorePostCollabTx (#320): a chip that's gone takes its pending row with it, a new one
// with an owner and a time still ahead is added. Sent and skipped rows stay.
func syncReminders(ctx context.Context, q *Queries, arg StorePostCollabTxParams) error {
	keep := make([]string, len(arg.Reminders))
	for i, r := range arg.Reminders {
		keep[i] = ReminderKey(r.BlockID, r.ChipDate, r.ChipTime)
	}
	if err := q.DeleteStalePostReminders(ctx, DeleteStalePostRemindersParams{PostID: arg.PostID, KeepKeys: keep}); err != nil {
		return err
	}
	if len(arg.Reminders) > 0 {
		retime := RetimePostRemindersParams{PostID: arg.PostID}
		for _, r := range arg.Reminders {
			retime.BlockIds = append(retime.BlockIds, r.BlockID)
			retime.ChipDates = append(retime.ChipDates, r.ChipDate)
			retime.ChipTimes = append(retime.ChipTimes, r.ChipTime)
			retime.RemindAts = append(retime.RemindAts, r.RemindAt.UTC().Format(time.RFC3339))
		}
		if err := q.RetimePostReminders(ctx, retime); err != nil {
			return err
		}
	}
	now := arg.Now
	if now.IsZero() {
		now = time.Now()
	}
	params := AddPostRemindersParams{PostID: arg.PostID, BlockIds: []string{}, RemindAts: []string{}, ChipDates: []string{}, ChipTimes: []string{}, UserIds: []int64{}}
	for _, r := range arg.Reminders {
		if r.UserID <= 0 || !r.RemindAt.After(now) {
			continue
		}
		params.BlockIds = append(params.BlockIds, r.BlockID)
		params.RemindAts = append(params.RemindAts, r.RemindAt.UTC().Format(time.RFC3339))
		params.ChipDates = append(params.ChipDates, r.ChipDate)
		params.ChipTimes = append(params.ChipTimes, r.ChipTime)
		params.UserIds = append(params.UserIds, r.UserID)
	}
	if len(params.BlockIds) == 0 {
		return nil
	}
	_, err := q.AddPostReminders(ctx, params)
	return err
}
