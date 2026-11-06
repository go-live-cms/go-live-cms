package db

import (
	"context"
	"database/sql"
	"errors"
)

// Block comments (#192, 000048): the writes that are more than one statement.

// ErrCommentDeleted means the comment was deleted (by someone else, meanwhile):
// nothing was written.
var ErrCommentDeleted = errors.New("the comment was deleted")

type CreatePostCommentThreadTxParams struct {
	PostID   int64
	BlockID  string
	AuthorID int64
	Body     string
}

type CreatePostCommentThreadTxResult struct {
	Thread  PostCommentThread
	Comment PostComment
}

// CreatePostCommentThreadTx starts a thread on a block with its first comment.
func (store *SQLStore) CreatePostCommentThreadTx(ctx context.Context, arg CreatePostCommentThreadTxParams) (CreatePostCommentThreadTxResult, error) {
	var result CreatePostCommentThreadTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		author := sql.NullInt64{Int64: arg.AuthorID, Valid: arg.AuthorID > 0}
		var err error
		result.Thread, err = q.CreatePostCommentThread(ctx, CreatePostCommentThreadParams{
			PostID: arg.PostID, BlockID: arg.BlockID, CreatedBy: author,
		})
		if err != nil {
			return err
		}
		result.Comment, err = q.CreatePostComment(ctx, CreatePostCommentParams{
			ThreadID: result.Thread.ID, AuthorID: author, Body: arg.Body,
		})
		return err
	})
	return result, err
}

type DeletePostCommentTxResult struct {
	Comment PostComment
	// ThreadDeleted: it was the thread's last live comment, so the thread went too.
	ThreadDeleted bool
}

// DeletePostCommentTx deletes a comment: the row stays without its body, so the
// replies keep their place, and a thread left with no live comment is deleted.
// The thread row is locked first, so two deletes of a thread's last two comments
// can't both leave it behind. ErrCommentDeleted when it was already deleted;
// sql.ErrNoRows when the comment or its thread is gone.
func (store *SQLStore) DeletePostCommentTx(ctx context.Context, commentID, threadID int64) (DeletePostCommentTxResult, error) {
	var result DeletePostCommentTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.LockPostCommentThread(ctx, threadID); err != nil {
			return err
		}
		var err error
		result.Comment, err = q.SoftDeletePostComment(ctx, commentID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrCommentDeleted
			}
			return err
		}
		live, err := q.CountLivePostComments(ctx, threadID)
		if err != nil {
			return err
		}
		if live == 0 {
			if err := q.DeletePostCommentThread(ctx, threadID); err != nil {
				return err
			}
			result.ThreadDeleted = true
		}
		return nil
	})
	return result, err
}
