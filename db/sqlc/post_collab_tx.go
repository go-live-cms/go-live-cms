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
