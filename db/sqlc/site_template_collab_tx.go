package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// StoreSiteTemplateCollabTxParams is the collab server's store of a template or part
// (#490, docs/design/theme-builder.md 7.2): StorePostCollabTxParams without what only a
// post has (block edits, mentions, reminders, media links; comments and the plugin event
// trigger are posts' too).
type StoreSiteTemplateCollabTxParams struct {
	TemplateID int64
	// State is the full Yjs document (Y.encodeStateAsUpdate).
	State []byte
	Epoch uuid.UUID
	// BlockDoc is the derived, validated and sanitized Block Spec v1 document. nil stores
	// the Yjs state only (the derived doc failed its kind's rules, or didn't change) and
	// leaves block_doc and block_revision alone.
	BlockDoc json.RawMessage
	// BaseRevision, when set, must equal site_templates.block_revision or nothing is
	// written (ErrCollabRevisionConflict). Required without BlockDoc
	// (ErrCollabBaseRevisionRequired), for the reason StorePostCollabTxParams gives.
	BaseRevision sql.NullInt64
	LastEditorID sql.NullInt64
	// EditActivityWindow, when positive, records site_template_edited for LastEditorID on
	// a store that writes BlockDoc, at most one per editor and template per window, under
	// the row lock. 0 records nothing.
	EditActivityWindow time.Duration
}

type StoreSiteTemplateCollabTxResult struct {
	// BlockRevision is site_templates.block_revision after the store, which the Yjs state
	// is now recorded against.
	BlockRevision int64
}

// StoreSiteTemplateCollabTx is StorePostCollabTx for the template-<id> document kind, in
// one transaction: lock the row, write block_doc with block_revision+1, and upsert
// site_template_ydoc_state at the new revision. The state and block_doc commit together,
// so the state's revision can only differ from the row's when something else wrote
// block_doc, which is what GET /internal/site-templates/:id/collab's guard detects.
//
// Returns sql.ErrNoRows when the template does not exist.
func (store *SQLStore) StoreSiteTemplateCollabTx(ctx context.Context, arg StoreSiteTemplateCollabTxParams) (StoreSiteTemplateCollabTxResult, error) {
	var result StoreSiteTemplateCollabTxResult
	if arg.BlockDoc == nil && !arg.BaseRevision.Valid {
		return result, ErrCollabBaseRevisionRequired
	}

	err := store.execTx(ctx, func(q *Queries) error {
		revision, err := q.LockSiteTemplateForCollabStore(ctx, arg.TemplateID)
		if err != nil {
			return err
		}
		if arg.BaseRevision.Valid && arg.BaseRevision.Int64 != revision {
			return ErrCollabRevisionConflict
		}

		result.BlockRevision = revision
		if arg.BlockDoc != nil {
			result.BlockRevision, err = q.UpdateSiteTemplateBlockDocFromCollab(ctx, UpdateSiteTemplateBlockDocFromCollabParams{
				ID:       arg.TemplateID,
				BlockDoc: arg.BlockDoc,
			})
			if err != nil {
				return err
			}
			if arg.EditActivityWindow > 0 && arg.LastEditorID.Valid {
				if _, err := q.CreateActivityThrottled(ctx, CreateActivityThrottledParams{
					Verb:          ActivitySiteTemplateEdited,
					ObjectType:    ActivityObjectSiteDesign,
					ObjectID:      arg.TemplateID,
					Payload:       json.RawMessage(`{}`),
					ActorID:       arg.LastEditorID.Int64,
					WindowSeconds: arg.EditActivityWindow.Seconds(),
				}); err != nil {
					return err
				}
			}
		}

		return q.UpsertSiteTemplateYdocState(ctx, UpsertSiteTemplateYdocStateParams{
			TemplateID:    arg.TemplateID,
			State:         arg.State,
			Epoch:         arg.Epoch,
			BlockRevision: result.BlockRevision,
			LastEditorID:  arg.LastEditorID,
		})
	})

	return result, err
}
