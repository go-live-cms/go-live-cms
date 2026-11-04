package db

import (
	"context"
	"errors"
	"fmt"
)

// ErrUnknownAuthor means a byline names a user that doesn't exist (or was removed
// while the byline was being written).
var ErrUnknownAuthor = errors.New("an author is not a user")

type SetPostAuthorsTxParams struct {
	PostID int64
	// AuthorIDs is the whole byline in credit order: one or more distinct user ids
	// (the API checks that).
	AuthorIDs []int64
}

// SetPostAuthorsTx replaces a post's working byline (user_posts, #319) in one
// transaction: lock the post, check every author exists (their rows FOR KEY SHARE,
// so a removal waits for this or wins and the byline is refused with
// ErrUnknownAuthor), write the byline in order and stamp changed_at. The owner
// (posts.user_id) never changes. On a published post the site keeps the published
// byline until Update (golive_post_settings). sql.ErrNoRows for a missing post.
func (store *SQLStore) SetPostAuthorsTx(ctx context.Context, arg SetPostAuthorsTxParams) (Post, error) {
	var post Post
	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.LockPostForPublish(ctx, arg.PostID); err != nil {
			return err
		}
		if err := writeByline(ctx, q, arg.PostID, arg.AuthorIDs, true); err != nil {
			return err
		}
		var err error
		post, err = q.TouchPost(ctx, arg.PostID)
		return err
	})
	return post, err
}

// writeByline replaces the post's byline with the given users, in order. With
// strict, a user that doesn't exist is ErrUnknownAuthor; without it (restoring a
// version) such users are skipped, and if none is left the byline stays as it is.
// The post must already be locked.
func writeByline(ctx context.Context, q *Queries, postID int64, authorIDs []int64, strict bool) error {
	existing, err := q.LockUsersForShare(ctx, authorIDs)
	if err != nil {
		return fmt.Errorf("lock authors: %w", err)
	}
	found := make(map[int64]bool, len(existing))
	for _, id := range existing {
		found[id] = true
	}
	kept := make([]int64, 0, len(authorIDs))
	for _, id := range authorIDs {
		if !found[id] {
			if strict {
				return ErrUnknownAuthor
			}
			continue
		}
		found[id] = false // once each
		kept = append(kept, id)
	}
	if len(kept) == 0 {
		if strict {
			return ErrUnknownAuthor
		}
		return nil
	}
	if err := q.DeleteUserPost(ctx, postID); err != nil {
		return fmt.Errorf("clear byline: %w", err)
	}
	if err := q.InsertPostByline(ctx, InsertPostBylineParams{PostID: postID, AuthorIds: kept}); err != nil {
		return fmt.Errorf("write byline: %w", err)
	}
	return nil
}
