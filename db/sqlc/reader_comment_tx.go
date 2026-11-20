package db

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"slices"
	"time"
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
	// Status is the status the comment had (a tombstone's own is approved).
	Status string
}

// DeleteReaderCommentTx deletes a reader comment for good: a moderator's Delete
// permanently, a reader's delete, an erasure (6.4, 13). A comment that approved replies
// answer, or whose thread they are in, becomes a tombstone instead, so root_id's ON
// DELETE CASCADE never takes an approved reply with it. The row and its replies are
// locked first, so a reply approved meanwhile is seen. sql.ErrNoRows: no such comment.
func (store *SQLStore) DeleteReaderCommentTx(ctx context.Context, id int64) (DeleteReaderCommentTxResult, error) {
	return store.deleteReaderCommentTx(ctx, id, nil)
}

// DeleteModeratedReaderCommentTx is a moderator's Delete permanently (#526): only a
// comment in spam or the trash, checked under the row lock (ErrReaderCommentStatusChanged
// otherwise, nothing deleted), so a comment restored meanwhile stays.
func (store *SQLStore) DeleteModeratedReaderCommentTx(ctx context.Context, id int64) (DeleteReaderCommentTxResult, error) {
	return store.deleteReaderCommentTx(ctx, id, []string{ReaderCommentSpam, ReaderCommentTrash})
}

// deleteReaderCommentTx deletes or tombstones a comment; with statuses, only one in them.
func (store *SQLStore) deleteReaderCommentTx(ctx context.Context, id int64, statuses []string) (DeleteReaderCommentTxResult, error) {
	var result DeleteReaderCommentTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		comment, err := q.LockReaderComment(ctx, id)
		if err != nil {
			return err
		}
		result.Status = comment.Status
		if statuses != nil && comment.Status == ReaderCommentUnconfirmed {
			// Not moderated (4.1): as if there were no such comment.
			return sql.ErrNoRows
		}
		if statuses != nil && (comment.RemovedAt.Valid || !slices.Contains(statuses, comment.Status)) {
			return ErrReaderCommentStatusChanged
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

// ErrReaderCommentParentGone: the comment a reply answers isn't an approved comment of
// the same post any more (unapproved, removed, deleted, or another post's).
var ErrReaderCommentParentGone = errors.New("the comment this replies to is not available")

// lockReaderCommentThread takes the reply's root and parent FOR SHARE, the parent first
// checked to be an approved, shown comment of postID (a tombstone isn't: nothing can be
// answered there). The locks make a delete (FOR UPDATE) and the retention job (SKIP
// LOCKED) wait for the reply instead of cascading it away mid-write (6.4). They are
// taken before the reply's own row, the same parent-then-child order as
// DeleteReaderCommentTx, so the two never deadlock.
func lockReaderCommentThread(ctx context.Context, q *Queries, postID int64, parentID, rootID sql.NullInt64) error {
	if rootID.Valid && (!parentID.Valid || rootID.Int64 != parentID.Int64) {
		if _, err := q.LockReaderCommentForShare(ctx, rootID.Int64); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrReaderCommentParentGone
			}
			return err
		}
	}
	if !parentID.Valid {
		return nil
	}
	parent, err := q.LockReaderCommentForShare(ctx, parentID.Int64)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrReaderCommentParentGone
	}
	if err != nil {
		return err
	}
	if parent.PostID != postID || parent.Status != ReaderCommentApproved || parent.RemovedAt.Valid {
		return ErrReaderCommentParentGone
	}
	return nil
}

// CreateReaderCommentTxParams is a reader comment to store. With VerifiedCommenter (a
// browser key proved the address, 3.3) the commenter's name becomes the one used.
type CreateReaderCommentTxParams struct {
	Comment           CreateReaderCommentParams
	VerifiedCommenter bool
}

// CreateReaderCommentTx stores a reader comment (#524). A reply's parent must still be an
// approved comment of the post, checked under a share lock with its root
// (ErrReaderCommentParentGone otherwise).
func (store *SQLStore) CreateReaderCommentTx(ctx context.Context, arg CreateReaderCommentTxParams) (ReaderComment, error) {
	var comment ReaderComment
	err := store.execTx(ctx, func(q *Queries) error {
		c := arg.Comment
		if err := lockReaderCommentThread(ctx, q, c.PostID, c.ParentID, c.RootID); err != nil {
			return err
		}
		if arg.VerifiedCommenter && c.CommenterID.Valid {
			if _, err := q.VerifyCommenter(ctx, VerifyCommenterParams{ID: c.CommenterID.Int64, DisplayName: c.DisplayName}); err != nil {
				return err
			}
		}
		var err error
		comment, err = q.CreateReaderComment(ctx, c)
		return err
	})
	return comment, err
}

// PublishReaderCommentTxParams moves an unconfirmed comment out of unconfirmed (3.3):
// a confirmation link (TokenHash set: the token must still be the comment's) or the
// confirm page's Publish for a browser holding the address's key (TokenHash nil).
type PublishReaderCommentTxParams struct {
	ID int64
	// TokenHash, when set, must be the comment's confirm token: spending it is the claim.
	TokenHash []byte
	// CreatedAfter: an unconfirmed comment expires (48 hours).
	CreatedAfter time.Time
	// What the rules decided (4.2): pending, approved or spam, with the reason.
	Status     string
	HeldReason sql.NullString
	HeldDetail sql.NullString
	// NewKey, when set, is the browser key the confirming browser gets (3.3 step 2).
	NewKey *CreateCommenterKeyParams
}

// PublishReaderCommentTx publishes (or holds) an unconfirmed comment: the commenter is
// verified and takes the comment's name, the token is spent, a key is stored. A comment
// that isn't unconfirmed any more, has expired, or no longer has that token is
// ErrTokenInvalid (one answer for every bad link); a reply whose parent went is
// ErrReaderCommentParentGone, and nothing is spent.
func (store *SQLStore) PublishReaderCommentTx(ctx context.Context, arg PublishReaderCommentTxParams) (ReaderComment, error) {
	var comment ReaderComment
	err := store.execTx(ctx, func(q *Queries) error {
		// Unlocked first, for its thread: the root and parent are locked before the row.
		current, err := q.GetReaderComment(ctx, arg.ID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTokenInvalid
		}
		if err != nil {
			return err
		}
		if err := lockReaderCommentThread(ctx, q, current.PostID, current.ParentID, current.RootID); err != nil {
			return err
		}
		locked, err := q.LockUnconfirmedReaderComment(ctx, LockUnconfirmedReaderCommentParams{ID: arg.ID, CreatedAfter: arg.CreatedAfter})
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTokenInvalid
		}
		if err != nil {
			return err
		}
		if arg.TokenHash != nil && !bytes.Equal(locked.ConfirmTokenHash, arg.TokenHash) {
			return ErrTokenInvalid
		}
		if !locked.CommenterID.Valid {
			return ErrTokenInvalid
		}
		comment, err = q.PublishUnconfirmedReaderComment(ctx, PublishUnconfirmedReaderCommentParams{
			ID: arg.ID, Status: arg.Status, HeldReason: arg.HeldReason, HeldDetail: arg.HeldDetail,
		})
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTokenInvalid
		}
		if err != nil {
			return err
		}
		if _, err := q.VerifyCommenter(ctx, VerifyCommenterParams{ID: locked.CommenterID.Int64, DisplayName: locked.DisplayName}); err != nil {
			return err
		}
		if arg.NewKey != nil {
			key := *arg.NewKey
			key.CommenterID = locked.CommenterID.Int64
			if _, err := q.CreateCommenterKey(ctx, key); err != nil {
				return err
			}
		}
		return nil
	})
	return comment, err
}
