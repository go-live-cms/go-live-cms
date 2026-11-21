package db

import (
	"context"
	"database/sql"
	"errors"
	"slices"
)

// A commenter's erasure (#529, docs/design/reader-comments.md 13): by an admin from the
// commenter's page, or by the reader from "Your comments" ("Delete everything").

// EraseCommenterTxResult says what erasing a commenter did.
type EraseCommenterTxResult struct {
	// Comments is how many comments the commenter had (every status).
	Comments int
	// Tombstoned is how many of them stay as "This comment was removed": someone else's
	// approved reply answers them. The others were deleted.
	Tombstoned int
	// Shown: one of them was on the site (approved, or a tombstone now), so the public
	// thread changed. PostIDs are the posts those were on.
	Shown   bool
	PostIDs []int64
	// MailRowsDeleted counts the other recipients' outbox rows left with nothing to say.
	MailRowsDeleted int64
}

// ErrReaderCommentNotTheCommenters: the comment isn't (any more) one of this commenter's.
var ErrReaderCommentNotTheCommenters = errors.New("the comment is not this commenter's")

// EraseCommenterTx erases a commenter in one transaction (13.1): every comment of theirs,
// in every status, is deleted, except those that someone else's approved reply still
// answers, which become tombstones (6.4: empty, no commenter). Then the outbox forgets
// those comments (other members' author mail, a moderation mail's count; a row left with
// nothing to send goes), and the commenter row goes with its browser keys, "Your
// comments" links, unsubscribe tokens (with their comments) and its own reply mail (ON
// DELETE CASCADE). sql.ErrNoRows: no such commenter (erased already, or pruned).
//
// Locks: every row of the threads involved in id order, then the commenter, so neither a
// moderator's status change (thread rows, then the commenter for a spam mark) nor a
// reply's insert (its parent, then the commenter's key) can deadlock with it. Comments are
// removed newest first, so the commenter's own replies go before what they answer and a
// tombstone is left only where another person's approved reply is.
func (store *SQLStore) EraseCommenterTx(ctx context.Context, commenterID int64) (EraseCommenterTxResult, error) {
	var result EraseCommenterTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		result = EraseCommenterTxResult{}
		owner := sql.NullInt64{Int64: commenterID, Valid: true}
		if _, err := q.LockCommenterThreads(ctx, owner); err != nil {
			return err
		}
		if _, err := q.LockCommenter(ctx, commenterID); err != nil {
			return err
		}
		// Again: a comment stored while this waited for the commenter's lock.
		if _, err := q.LockCommenterThreads(ctx, owner); err != nil {
			return err
		}
		ids, err := q.ListCommenterCommentIDs(ctx, owner)
		if err != nil {
			return err
		}
		result.Comments = len(ids)
		for _, id := range ids {
			removed, err := deleteReaderComment(ctx, q, id, nil)
			if errors.Is(err, sql.ErrNoRows) {
				// Gone with a thread deleted before it (a root's cascade).
				continue
			}
			if err != nil {
				return err
			}
			if removed.Tombstoned {
				result.Tombstoned++
			}
			if removed.Tombstoned || removed.Status == ReaderCommentApproved {
				result.Shown = true
				if !slices.Contains(result.PostIDs, removed.Comment.PostID) {
					result.PostIDs = append(result.PostIDs, removed.Comment.PostID)
				}
			}
		}
		if len(ids) > 0 {
			rows, err := q.ScrubDiscussionMailComments(ctx, ids)
			if err != nil {
				return err
			}
			var empty []int64
			for _, row := range rows {
				if row.Empty {
					empty = append(empty, row.ID)
				}
			}
			if len(empty) > 0 {
				if result.MailRowsDeleted, err = q.DeleteDiscussionMailRows(ctx, empty); err != nil {
					return err
				}
			}
		}
		deleted, err := q.DeleteCommenter(ctx, commenterID)
		if err != nil {
			return err
		}
		if deleted == 0 {
			return sql.ErrNoRows
		}
		return nil
	})
	return result, err
}

// DeleteCommenterReaderCommentTx is a reader's Delete on "Your comments" (13.2): one of
// their comments, whatever its status, deleted, or a tombstone when approved replies
// answer it (6.4). ErrReaderCommentNotTheCommenters when it isn't theirs (checked under
// the row lock), sql.ErrNoRows when there is no such comment.
func (store *SQLStore) DeleteCommenterReaderCommentTx(ctx context.Context, commenterID, commentID int64) (DeleteReaderCommentTxResult, error) {
	var result DeleteReaderCommentTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		var err error
		result, err = deleteReaderComment(ctx, q, commentID, func(comment ReaderComment) error {
			if !comment.CommenterID.Valid || comment.CommenterID.Int64 != commenterID {
				return ErrReaderCommentNotTheCommenters
			}
			return nil
		})
		return err
	})
	return result, err
}
