package db

import (
	"context"
	"errors"
	"fmt"
	"slices"
)

// ErrUnknownAuthor means a byline names a user that doesn't exist (or was removed
// while the byline was being written).
var ErrUnknownAuthor = errors.New("an author is not a user")

// ErrBylineChanged means the post's byline is no longer the one the caller edited
// (someone else saved theirs meanwhile): nothing was written.
var ErrBylineChanged = errors.New("the byline changed since it was loaded")

type SetPostAuthorsTxParams struct {
	PostID int64
	// AuthorIDs is the whole byline in credit order: one or more distinct user ids
	// (the API checks that).
	AuthorIDs []int64
	// BaseAuthorIDs is the byline the caller started from; when set and it isn't
	// the current one, the transaction fails with ErrBylineChanged, so one
	// editor's save can't silently drop another's change. nil skips the check.
	BaseAuthorIDs []int64
}

type SetPostAuthorsTxResult struct {
	Post Post
	// Authors is the byline as written, read in the same transaction.
	Authors []ListPostBylineAuthorsRow
	// Current is the byline found when ErrBylineChanged is returned.
	Current []ListPostBylineAuthorsRow
}

// SetPostAuthorsTx replaces a post's working byline (user_posts, #319) in one
// transaction: check every author exists (their rows FOR KEY SHARE, so a removal
// waits for this or wins and the byline is refused with ErrUnknownAuthor), lock
// the post, compare the byline with BaseAuthorIDs, write it in order and stamp
// changed_at. Users are locked before the post, the order RemoveUserTx uses
// (users, then their posts), so the two can't deadlock. The owner
// (posts.user_id) never changes. On a published post the site keeps the
// published byline until Update (golive_post_settings). sql.ErrNoRows for a
// missing post.
func (store *SQLStore) SetPostAuthorsTx(ctx context.Context, arg SetPostAuthorsTxParams) (SetPostAuthorsTxResult, error) {
	var result SetPostAuthorsTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		kept, err := lockAuthors(ctx, q, arg.AuthorIDs, true)
		if err != nil {
			return err
		}
		if _, err := q.LockPostForPublish(ctx, arg.PostID); err != nil {
			return err
		}
		if arg.BaseAuthorIDs != nil {
			current, err := q.ListPostBylineAuthors(ctx, arg.PostID)
			if err != nil {
				return fmt.Errorf("read byline: %w", err)
			}
			ids := make([]int64, len(current))
			for i, row := range current {
				ids[i] = row.ID
			}
			if !slices.Equal(ids, arg.BaseAuthorIDs) {
				result.Current = current
				return ErrBylineChanged
			}
		}
		if err := replaceByline(ctx, q, arg.PostID, kept); err != nil {
			return err
		}
		if result.Post, err = q.TouchPost(ctx, arg.PostID); err != nil {
			return err
		}
		result.Authors, err = q.ListPostBylineAuthors(ctx, arg.PostID)
		return err
	})
	return result, err
}

// lockAuthors locks the given users FOR KEY SHARE and returns the ones that
// exist, in the given order, once each. With strict, a user that doesn't exist (or
// none at all) is ErrUnknownAuthor; without it (restoring a version) such users
// are skipped. Call it before locking the post (see SetPostAuthorsTx).
func lockAuthors(ctx context.Context, q *Queries, authorIDs []int64, strict bool) ([]int64, error) {
	existing, err := q.LockUsersForShare(ctx, authorIDs)
	if err != nil {
		return nil, fmt.Errorf("lock authors: %w", err)
	}
	found := make(map[int64]bool, len(existing))
	for _, id := range existing {
		found[id] = true
	}
	kept := make([]int64, 0, len(authorIDs))
	for _, id := range authorIDs {
		if !found[id] {
			if strict {
				return nil, ErrUnknownAuthor
			}
			continue
		}
		found[id] = false // once each
		kept = append(kept, id)
	}
	if strict && len(kept) == 0 {
		return nil, ErrUnknownAuthor
	}
	return kept, nil
}

// replaceByline replaces the post's byline with the given users, in order. An
// empty list leaves the byline as it is (a byline is never empty). The post and
// the users must already be locked.
func replaceByline(ctx context.Context, q *Queries, postID int64, authorIDs []int64) error {
	if len(authorIDs) == 0 {
		return nil
	}
	if err := q.DeleteUserPost(ctx, postID); err != nil {
		return fmt.Errorf("clear byline: %w", err)
	}
	if err := q.InsertPostByline(ctx, InsertPostBylineParams{PostID: postID, AuthorIds: authorIDs}); err != nil {
		return fmt.Errorf("write byline: %w", err)
	}
	return nil
}
