package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
)

// ErrCollabRevisionConflict is returned by StorePostCollabTx when the caller
// passed a BaseRevision and posts.block_revision has moved past it: something
// wrote block_doc around the collab server since it loaded the document.
var ErrCollabRevisionConflict = errors.New("block_revision changed since the collab document was loaded")

type StorePostCollabTxParams struct {
	PostID int64
	// State is the full Yjs document (Y.encodeStateAsUpdate).
	State []byte
	Epoch uuid.UUID
	// BlockDoc is the derived, already validated and sanitized Block Spec v1
	// document. nil stores the Yjs state only (the server's derived doc
	// failed validation) and leaves block_doc and block_revision alone.
	BlockDoc json.RawMessage
	// MediaIDs are BlockDoc's image media ids in document order; the content
	// links (post_media order > 0) are synced to them. Ignored without BlockDoc.
	MediaIDs []int64
	// BaseRevision, when set, must equal posts.block_revision or nothing is
	// written (ErrCollabRevisionConflict).
	BaseRevision sql.NullInt64
	LastEditorID sql.NullInt64
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
				mediaIDs := arg.MediaIDs
				if mediaIDs == nil {
					mediaIDs = []int64{}
				}
				if err := q.SyncPostContentMedia(ctx, SyncPostContentMediaParams{
					PostID:   arg.PostID,
					MediaIds: mediaIDs,
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
