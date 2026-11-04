package db

import (
	"context"
	"errors"
)

// PostStatusTrash is a post in the trash (#327, 000036).
const PostStatusTrash = "trash"

// ErrPostTrashed: the post is in the trash, so it can't be published (or
// unpublished, edited, scheduled); restore it first.
var ErrPostTrashed = errors.New("the post is in the trash")

// ErrPostNotTrashed: permanent delete is only for posts in the trash.
var ErrPostNotTrashed = errors.New("the post is not in the trash")

// DeleteTrashedPostTx permanently deletes a post that is in the trash (#327):
// the old DeletePostTx, after checking the status under the row lock, so a
// restore committed meanwhile wins. Everything hanging off the post goes with it
// (ON DELETE CASCADE: bylines, meta, media links, terms, versions, Yjs state,
// menu items); children keep existing with no parent. sql.ErrNoRows: no such
// post; ErrPostNotTrashed: it isn't in the trash.
func (store *SQLStore) DeleteTrashedPostTx(ctx context.Context, id int64) error {
	return store.execTx(ctx, func(q *Queries) error {
		status, err := q.LockPostStatus(ctx, id)
		if err != nil {
			return err
		}
		if status != PostStatusTrash {
			return ErrPostNotTrashed
		}
		if err := q.DeleteUserPost(ctx, id); err != nil {
			return err
		}
		return q.DeletePost(ctx, id)
	})
}
