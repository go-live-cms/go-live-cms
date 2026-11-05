package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Post ownership (#353). The owner (posts.user_id) is what permissions read (#135);
// the byline (user_posts, #319) only credits. Two things change owners, and both go
// through reassignPostOwner: a transfer of one post (TransferPostOwnerTx) and a
// member's removal (RemoveUserTx, #333), which hands every post they own to someone
// else.

// ErrNewOwnerNotFound means the member who should own the post doesn't exist (or
// was removed while the transfer ran).
var ErrNewOwnerNotFound = errors.New("the new owner is not a user")

// ErrNewOwnerInactive means the new owner exists but has no content role, so they
// couldn't edit the post they'd own.
var ErrNewOwnerInactive = errors.New("the new owner is not an active member")

// ErrAlreadyOwner means the post already belongs to the new owner: nothing changed.
var ErrAlreadyOwner = errors.New("the post already belongs to that member")

// postOwnerChange is one reassignment: the posts From owns (all of them, or those in
// PostIDs that From still owns) go to To.
type postOwnerChange struct {
	FromID     int64
	ToID       int64
	ToUsername string
	// AllPosts moves every post From owns (a removal); otherwise only PostIDs.
	AllPosts bool
	PostIDs  []int64
	// ReplaceInByline gives From's place in the byline of the moved posts to To
	// (in place, same position), or drops From's credit there when To is already
	// credited. Off: the byline stays as it was.
	ReplaceInByline bool
}

// reassignPostOwner moves posts from one owner to another inside the caller's
// transaction and returns the ids of the posts that moved. It changes the working
// byline only (with ReplaceInByline): the published byline (published_settings) is
// the caller's business, since a transfer leaves it for Update and a removal can't.
// The caller has locked both users (removal: FOR UPDATE; transfer: the new owner
// FOR KEY SHARE and the post FOR UPDATE).
func reassignPostOwner(ctx context.Context, q *Queries, arg postOwnerChange) ([]int64, error) {
	moved, err := q.ReassignPostsOwner(ctx, ReassignPostsOwnerParams{
		ToID:       arg.ToID,
		ToUsername: arg.ToUsername,
		FromID:     arg.FromID,
		AllPosts:   arg.AllPosts,
		PostIds:    arg.PostIDs,
	})
	if err != nil {
		return nil, fmt.Errorf("reassign posts: %w", err)
	}
	if len(moved) == 0 || !arg.ReplaceInByline {
		return moved, nil
	}
	if err := q.ReassignPostBylines(ctx, ReassignPostBylinesParams{
		FromID:  arg.FromID,
		ToID:    arg.ToID,
		PostIds: moved,
	}); err != nil {
		return nil, fmt.Errorf("reassign bylines: %w", err)
	}
	// Where To was already credited, From's credit is still there: it goes.
	if err := q.DeletePostBylineCredits(ctx, DeletePostBylineCreditsParams{
		UserID:  arg.FromID,
		PostIds: moved,
	}); err != nil {
		return nil, fmt.Errorf("drop old owner's credit: %w", err)
	}
	return moved, nil
}

type TransferPostOwnerTxParams struct {
	PostID int64
	// ToID is the member who will own the post.
	ToID int64
	// OwnerRoles are the roles an owner may have (the API's content roles): a member
	// with any other role is ErrNewOwnerInactive.
	OwnerRoles []string
	// ReplaceInByline also replaces the old owner in the working byline ("also
	// replace me in the byline"). Off, the byline is untouched.
	ReplaceInByline bool
}

type TransferPostOwnerTxResult struct {
	Post Post
	// Owner is the new owner, as locked.
	Owner LockNewPostOwnerRow
	// PreviousOwnerID is who owned the post before.
	PreviousOwnerID int64
	// BylineChanged reports whether the working byline changed (ReplaceInByline and
	// the old owner was credited).
	BylineChanged bool
	// Authors is the working byline after the transfer.
	Authors []ListPostBylineAuthorsRow
}

// TransferPostOwnerTx gives a post to another member (#353), in one transaction:
// lock the new owner FOR KEY SHARE (so a removal waits, or wins and this is
// ErrNewOwnerNotFound) and check their role, then lock the post and read its
// owner, then reassignPostOwner (the code a removal runs). Users before the post,
// RemoveUserTx's and SetPostAuthorsTx's order, so they can't deadlock.
//
// The working byline changes only with ReplaceInByline; on a published post the
// site keeps the published byline until Update (golive_post_settings, #319). The
// post's changed_at moves only when the byline changed (a setting did); ownership
// isn't content.
//
// sql.ErrNoRows for a missing post, ErrPostTrashed for a post in the trash (nobody
// edits one, #327), ErrAlreadyOwner when the new owner owns it already.
func (store *SQLStore) TransferPostOwnerTx(ctx context.Context, arg TransferPostOwnerTxParams) (TransferPostOwnerTxResult, error) {
	var result TransferPostOwnerTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		owner, err := q.LockNewPostOwner(ctx, arg.ToID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNewOwnerNotFound
		}
		if err != nil {
			return fmt.Errorf("lock new owner: %w", err)
		}
		if !roleIn(owner.Role, arg.OwnerRoles) {
			return ErrNewOwnerInactive
		}
		result.Owner = owner

		post, err := q.LockPostOwner(ctx, arg.PostID)
		if err != nil {
			return err
		}
		if post.PostStatus == PostStatusTrash {
			return ErrPostTrashed
		}
		if post.UserID == owner.ID {
			return ErrAlreadyOwner
		}
		result.PreviousOwnerID = post.UserID

		before, err := q.ListPostBylineAuthors(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("read byline: %w", err)
		}
		if _, err := reassignPostOwner(ctx, q, postOwnerChange{
			FromID:          post.UserID,
			ToID:            owner.ID,
			ToUsername:      owner.Username,
			PostIDs:         []int64{arg.PostID},
			ReplaceInByline: arg.ReplaceInByline,
		}); err != nil {
			return err
		}
		if result.Authors, err = q.ListPostBylineAuthors(ctx, arg.PostID); err != nil {
			return fmt.Errorf("read byline: %w", err)
		}
		result.BylineChanged = !sameByline(before, result.Authors)

		if result.BylineChanged {
			result.Post, err = q.TouchPost(ctx, arg.PostID)
		} else {
			result.Post, err = q.GetPost(ctx, arg.PostID)
		}
		return err
	})
	return result, err
}

// roleIn reports whether role is one of roles, case-insensitively (roles are
// matched that way everywhere, api/auth_roles.go).
func roleIn(role string, roles []string) bool {
	for _, r := range roles {
		if strings.EqualFold(role, r) {
			return true
		}
	}
	return false
}

func sameByline(a, b []ListPostBylineAuthorsRow) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID {
			return false
		}
	}
	return true
}
