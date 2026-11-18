package db

import (
	"context"
	"slices"
)

// Reader comments (#499, storage #522, 000061; docs/design/reader-comments.md 6.4).

// The statuses of a reader comment (4.1).
const (
	ReaderCommentUnconfirmed = "unconfirmed"
	ReaderCommentPending     = "pending"
	ReaderCommentApproved    = "approved"
	ReaderCommentSpam        = "spam"
	ReaderCommentTrash       = "trash"
)

// DeleteReaderCommentTxResult says what deleting a reader comment did.
type DeleteReaderCommentTxResult struct {
	// Tombstoned: approved replies hang from it, so the row stays, emptied ("This comment
	// was removed"); Comment is the tombstone. Otherwise the row is gone, with the replies
	// its thread still had (none of them approved), and Comment is the row as it was.
	Tombstoned bool
	Comment    ReaderComment
}

// DeleteReaderCommentTx deletes a reader comment for good: a moderator's Delete
// permanently, a reader's delete, an erasure (6.4, 13). A comment that approved replies
// answer, or whose thread they are in, becomes a tombstone instead, so root_id's ON
// DELETE CASCADE never takes an approved reply with it. The row and its replies are
// locked first, so a reply approved meanwhile is seen. sql.ErrNoRows: no such comment.
func (store *SQLStore) DeleteReaderCommentTx(ctx context.Context, id int64) (DeleteReaderCommentTxResult, error) {
	var result DeleteReaderCommentTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		comment, err := q.LockReaderComment(ctx, id)
		if err != nil {
			return err
		}
		replies, err := q.LockReaderCommentReplyStatuses(ctx, id)
		if err != nil {
			return err
		}
		if slices.Contains(replies, ReaderCommentApproved) {
			// Its subscription ends with its text.
			if err := q.DeleteReaderCommentUnsubscribeTokens(ctx, id); err != nil {
				return err
			}
			result.Tombstoned = true
			result.Comment, err = q.TombstoneReaderComment(ctx, id)
			return err
		}
		result.Comment = comment
		_, err = q.DeleteReaderCommentRow(ctx, id)
		return err
	})
	return result, err
}
