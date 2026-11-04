package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/sqlc-dev/pqtype"
)

// ErrLastAdmin is returned by user-removing transactions (delete, or an update
// that moves the role off admin) when the target is the only remaining admin.
var ErrLastAdmin = errors.New("operation would remove the last admin")

// ErrMediaNotOwned is returned by DeleteMediaTx when an owner-scoped delete
// (AnyOwner unset) targets media uploaded by a different user.
var ErrMediaNotOwned = errors.New("media is owned by another user")

// guardLastAdmin row-locks every admin inside the caller's transaction and
// fails with ErrLastAdmin if userID is the only one. Holding the locks until
// commit serializes concurrent admin-removing operations: a second remover
// blocks, and on wake-up READ COMMITTED re-evaluates the role predicate, so a
// row the first transaction demoted or deleted is no longer counted.
func guardLastAdmin(ctx context.Context, q *Queries, userID int64) error {
	adminIDs, err := q.LockAdminUserIDs(ctx)
	if err != nil {
		return err
	}
	if len(adminIDs) == 1 && adminIDs[0] == userID {
		return ErrLastAdmin
	}
	return nil
}

type Store interface {
	Querier
	CreatePostTx(ctx context.Context, arg CreatePostTxParams) (CreatePostTxResult, error)
	DuplicatePostTx(ctx context.Context, arg DuplicatePostTxParams) (Post, error)
	DeletePostTx(ctx context.Context, id int64) error

	RemoveUserTx(ctx context.Context, arg RemoveUserTxParams) (RemoveUserTxResult, error)
	ChangeUserRoleTx(ctx context.Context, arg SetUserRoleParams) (ChangeUserRoleTxResult, error)
	UpdateUserTx(ctx context.Context, arg UpdateUserTxParams) (UpdateUserTxResult, error)

	CreateUserInvitationTx(ctx context.Context, arg CreateUserInvitationParams) (UserInvitation, error)
	AcceptInvitationTx(ctx context.Context, arg AcceptInvitationTxParams) (AcceptInvitationTxResult, error)
	ResetPasswordTx(ctx context.Context, arg ResetPasswordTxParams) (User, error)
	// profile (#334)
	RequestEmailChangeTx(ctx context.Context, arg RequestEmailChangeTxParams) (EmailChangeToken, error)
	ConfirmEmailChangeTx(ctx context.Context, tokenHash []byte) (ConfirmEmailChangeTxResult, error)
	SignOutOtherSessionsTx(ctx context.Context, arg SignOutOtherSessionsTxParams) (SignOutOtherSessionsTxResult, error)

	CreatePostWithTaxonomyTermsTx(ctx context.Context, arg CreatePostWithTaxonomyTermsTxParams) (CreatePostWithTaxonomyTermsTxResult, error)
	DeleteTaxonomyTermTx(ctx context.Context, id int64) error
	UpdatePostTaxonomyTermsTx(ctx context.Context, arg UpdatePostTaxonomyTermsTxParams) error
	CreateTaxonomyTermAndLinkTx(ctx context.Context, arg CreateTaxonomyTermAndLinkTxParams) (CreateTaxonomyTermAndLinkTxResult, error)

	CreatePostWithMediaTx(ctx context.Context, arg CreatePostWithMediaTxParams) (CreatePostWithMediaTxResult, error)
	DeleteMediaTx(ctx context.Context, arg DeleteMediaTxParams) error
	UpdatePostMediaTx(ctx context.Context, arg UpdatePostMediaTxParams) error
	UpdatePostWithSlugTx(ctx context.Context, arg UpdatePostWithSlugTxParams) (Post, error)
	CreateMediaAndLinkTx(ctx context.Context, arg CreateMediaAndLinkTxParams) (CreateMediaAndLinkTxResult, error)
	SetMediaVariantsTx(ctx context.Context, arg SetMediaVariantsTxParams) (Medium, error)

	StorePostCollabTx(ctx context.Context, arg StorePostCollabTxParams) (StorePostCollabTxResult, error)

	PublishPostTx(ctx context.Context, arg PublishPostTxParams) (PublishPostTxResult, error)
	PublishScheduledPostTx(ctx context.Context, arg PublishScheduledPostTxParams) (PublishPostTxResult, error)
	ScheduleUpdateTx(ctx context.Context, arg ScheduleUpdateTxParams) (PostScheduledUpdateRow, error)
	PublishScheduledUpdateTx(ctx context.Context, arg PublishScheduledUpdateTxParams) (PublishPostTxResult, error)
	RestorePostSettingsTx(ctx context.Context, arg RestorePostSettingsTxParams) (Post, error)
	SetPostAuthorsTx(ctx context.Context, arg SetPostAuthorsTxParams) (SetPostAuthorsTxResult, error)

	SaveMenuTx(ctx context.Context, arg SaveMenuTxParams) (Menu, error)
	ReplaceMenuItemsTx(ctx context.Context, arg ReplaceMenuItemsTxParams) ([]MenuItem, error)

	ExecTx(ctx context.Context, fn func(*Queries) error) error

	// Ping checks that the database is reachable (the API's /readyz).
	Ping(ctx context.Context) error
}

func (store *SQLStore) ExecTx(ctx context.Context, fn func(*Queries) error) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	q := New(tx)
	err = fn(q)
	if err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return fmt.Errorf("tx err: %v, rb err: %v", err, rbErr)
		}
		return err
	}

	return tx.Commit()
}

// SQLStore gives us the functions to interact with the database
type SQLStore struct {
	*Queries
	db *sql.DB
}

func NewStore(db *sql.DB) Store {
	return &SQLStore{
		db:      db,
		Queries: New(db),
	}
}

// Ping checks that the database is reachable (the API's /readyz).
func (store *SQLStore) Ping(ctx context.Context) error {
	return store.db.PingContext(ctx)
}

func (store *SQLStore) execTx(ctx context.Context, fn func(*Queries) error) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	q := New(tx)
	err = fn(q)
	if err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return fmt.Errorf("tx err: %v, rb err: %v", err, rbErr)
		}
		return err
	}

	return tx.Commit()
}

type CreatePostTxParams struct {
	CreatePostsParams
	AuthorIDs []int64
}

type CreatePostTxResult struct {
	Post      Post       `json:"post"`
	UserPosts []UserPost `json:"user_posts"`
}

func (store *SQLStore) CreatePostTx(ctx context.Context, arg CreatePostTxParams) (CreatePostTxResult, error) {
	var result CreatePostTxResult

	err := store.execTx(ctx, func(q *Queries) error {
		var err error

		result.Post, err = q.CreatePosts(ctx, arg.CreatePostsParams)
		if err != nil {
			return err
		}

		userPost, err := q.CreateUserPost(ctx, CreateUserPostParams{
			PostID: result.Post.ID,
			UserID: arg.UserID,
			Order:  0,
		})
		if err != nil {
			return err
		}
		result.UserPosts = append(result.UserPosts, userPost)

		for i, authorID := range arg.AuthorIDs {
			if authorID != arg.UserID {
				userPost, err := q.CreateUserPost(ctx, CreateUserPostParams{
					PostID: result.Post.ID,
					UserID: authorID,
					Order:  int32(i + 1),
				})
				if err != nil {
					return err
				}
				result.UserPosts = append(result.UserPosts, userPost)
			}
		}

		return nil
	})

	return result, err
}

func (store *SQLStore) DeletePostTx(ctx context.Context, id int64) error {
	err := store.execTx(ctx, func(q *Queries) error {
		err := q.DeleteUserPost(ctx, id)
		if err != nil {
			return err
		}

		err = q.DeletePost(ctx, id)
		if err != nil {
			return err
		}

		return nil
	})

	return err
}

type ChangeUserRoleTxResult struct {
	User User
	// PreviousRole is the role before the change (equal to User.Role when the
	// request set the role it already had).
	PreviousRole string
}

// ChangeUserRoleTx sets a user's role (#333). Moving the role off admin first runs
// guardLastAdmin, which locks every admin row until commit, so two demotions racing
// for the last two admins can't both pass: the second re-reads the first's demotion
// and gets ErrLastAdmin. The user's row is then locked and read, so PreviousRole is
// the role this change replaced (the activity log, #324). sql.ErrNoRows if the
// user doesn't exist.
func (store *SQLStore) ChangeUserRoleTx(ctx context.Context, arg SetUserRoleParams) (ChangeUserRoleTxResult, error) {
	var result ChangeUserRoleTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		if !strings.EqualFold(arg.Role, "admin") {
			if err := guardLastAdmin(ctx, q, arg.ID); err != nil {
				return err
			}
		}
		// After guardLastAdmin, as in UpdateUserTx: admin rows first.
		if err := q.LockUserForUpdate(ctx, arg.ID); err != nil {
			return err
		}
		previous, err := q.GetUser(ctx, arg.ID)
		if err != nil {
			return err
		}
		result.PreviousRole = previous.Role
		result.User, err = q.SetUserRole(ctx, arg)
		return err
	})
	return result, err
}

// ErrReassignToRemovedUser is returned by RemoveUserTx when the posts would go to
// the member being removed.
var ErrReassignToRemovedUser = errors.New("posts can't be reassigned to the member being removed")

// ErrReassignTargetNotFound is returned by RemoveUserTx when the user who should
// receive the posts doesn't exist.
var ErrReassignTargetNotFound = errors.New("the user to reassign posts to doesn't exist")

type RemoveUserTxParams struct {
	UserID int64
	// ReassignTo receives the posts and media the member owns.
	ReassignTo int64
}

type RemoveUserTxResult struct {
	// PostsReassigned is the number of posts that changed owner.
	PostsReassigned int
	// AvatarURL is the removed member's avatar (#334), for the API to delete its
	// file after the commit.
	AvatarURL string
}

// RemoveUserTx removes a member (#333), in one transaction:
//   - refuses the last admin (guardLastAdmin, which also serializes removals and
//     demotions of admins),
//   - locks the member and the recipient (LockUsersForUpdate, id order),
//   - moves every post they own (posts.user_id) to the recipient, with their byline
//     on those posts (ReassignPostBylines), and the media they uploaded,
//   - drops their credit on everyone else's posts, crediting the owner where that
//     leaves a byline empty, in the working and the published bylines alike (#319),
//   - deletes their sessions, which revokes every refresh token,
//   - deletes the user row. Their reset tokens and
//     invitation links go with it (ON DELETE CASCADE / SET NULL); revisions they
//     published keep a NULL created_by (000032).
//
// sql.ErrNoRows if the member doesn't exist.
func (store *SQLStore) RemoveUserTx(ctx context.Context, arg RemoveUserTxParams) (RemoveUserTxResult, error) {
	var result RemoveUserTxResult
	if arg.UserID == arg.ReassignTo {
		return result, ErrReassignToRemovedUser
	}
	err := store.execTx(ctx, func(q *Queries) error {
		if err := guardLastAdmin(ctx, q, arg.UserID); err != nil {
			return err
		}

		locked, err := q.LockUsersForUpdate(ctx, []int64{arg.UserID, arg.ReassignTo})
		if err != nil {
			return err
		}
		var found, recipient *LockUsersForUpdateRow
		for i := range locked {
			switch locked[i].ID {
			case arg.UserID:
				found = &locked[i]
			case arg.ReassignTo:
				recipient = &locked[i]
			}
		}
		if found == nil {
			return sql.ErrNoRows
		}
		if recipient == nil {
			return ErrReassignTargetNotFound
		}
		result.AvatarURL = found.AvatarUrl

		moved, err := q.ReassignPostsOwner(ctx, ReassignPostsOwnerParams{
			FromID:     arg.UserID,
			ToID:       recipient.ID,
			ToUsername: recipient.Username,
		})
		if err != nil {
			return err
		}
		result.PostsReassigned = len(moved)

		if len(moved) > 0 {
			if err := q.ReassignPostBylines(ctx, ReassignPostBylinesParams{
				FromID:  arg.UserID,
				ToID:    recipient.ID,
				PostIds: moved,
			}); err != nil {
				return err
			}
		}
		// Bylines (#319): their remaining credits go (other people's posts, or a
		// moved post that already credits the recipient), a byline left empty
		// credits the post's owner, and the published bylines get the same rule at
		// once: the site can't credit an account that no longer exists.
		credited, err := q.DeleteUserBylines(ctx, arg.UserID)
		if err != nil {
			return err
		}
		if len(credited) > 0 {
			if err := q.CreditOwnersOnEmptyBylines(ctx, credited); err != nil {
				return err
			}
		}
		if err := q.ReassignPublishedBylines(ctx, ReassignPublishedBylinesParams{
			FromID:       arg.UserID,
			ToID:         recipient.ID,
			MovedPostIds: moved,
		}); err != nil {
			return err
		}

		if err := q.TransferMediaToUser(ctx, TransferMediaToUserParams{
			UserID:   arg.UserID,
			UserID_2: recipient.ID,
		}); err != nil {
			return err
		}

		if err := q.DeleteUserSessions(ctx, arg.UserID); err != nil {
			return err
		}

		return q.DeleteUser(ctx, arg.UserID)
	})

	return result, err
}

type UpdateUserTxParams struct {
	UpdateUserParams
	CheckUniqueness bool
	// PasswordChanged marks HashedPassword as a new password. The transaction
	// then locks the user row, stamps PasswordChangedAt itself (overriding the
	// caller's value), uses up any outstanding password reset tokens, and
	// blocks every session the user holds, so a stolen
	// refresh or access token cannot outlive the password it was issued under.
	//
	// The row lock serializes against refresh-token rotation, which takes the
	// same row FOR SHARE (LockUserForShare) and mints its access token before
	// committing. A rotation that commits first therefore has its new session
	// blocked here and its token's iat at or before PasswordChangedAt; one
	// that waits finds its session already blocked. Stamping the time only
	// after the lock is what makes that ordering hold; a timestamp taken
	// before hashing or before the wait would let such tokens survive.
	PasswordChanged bool
}

type UpdateUserTxResult struct {
	User User `json:"user"`
}

func (store *SQLStore) UpdateUserTx(ctx context.Context, arg UpdateUserTxParams) (UpdateUserTxResult, error) {
	var result UpdateUserTxResult

	err := store.execTx(ctx, func(q *Queries) error {
		var err error

		if !strings.EqualFold(arg.Role, "admin") {
			if err := guardLastAdmin(ctx, q, arg.ID); err != nil {
				return err
			}
		}

		// Taken after guardLastAdmin so the lock order matches its
		// LockAdminUserIDs (admin rows first), avoiding deadlocks with a
		// concurrent demotion.
		if arg.PasswordChanged {
			if err := q.LockUserForUpdate(ctx, arg.ID); err != nil {
				return err
			}
			arg.PasswordChangedAt = time.Now()
		}

		if arg.CheckUniqueness {
			existingUser, err := q.GetUserByUsername(ctx, arg.Username)
			if err == nil && existingUser.ID != arg.ID {
				return fmt.Errorf("username '%s' already exists", arg.Username)
			}

			existingUser, err = q.GetUserByEmail(ctx, arg.Email)
			if err == nil && existingUser.ID != arg.ID {
				return fmt.Errorf("email '%s' already exists", arg.Email)
			}
		}

		result.User, err = q.UpdateUser(ctx, arg.UpdateUserParams)
		if err != nil {
			return err
		}

		if arg.Username != "" {
			err = q.UpdatePostsUsername(ctx, UpdatePostsUsernameParams{
				UserID:   arg.ID,
				Username: arg.Username,
			})
			if err != nil {
				return err
			}
		}

		if arg.PasswordChanged {
			if err := q.BlockAllSessionsForUser(ctx, arg.ID); err != nil {
				return err
			}
			// A reset link requested before the change must not be able
			// to undo it.
			if err := q.InvalidatePasswordResetTokensForUser(ctx, arg.ID); err != nil {
				return err
			}
			// Nor an email change requested with the old one (#334).
			if err := q.InvalidateEmailChangeTokensForUser(ctx, arg.ID); err != nil {
				return err
			}
		}

		return nil
	})

	return result, err
}

type CreatePostWithTaxonomyTermsTxParams struct {
	CreatePostsParams
	AuthorIDs       []int64
	TaxonomyTermIDs []int64
}

type CreatePostWithTaxonomyTermsTxResult struct {
	Post                      Post                       `json:"post"`
	UserPosts                 []UserPost                 `json:"user_posts"`
	PostTaxonomyRelationships []PostTaxonomyRelationship `json:"post_taxonomy_relationships"`
}

func (store *SQLStore) CreatePostWithTaxonomyTermsTx(ctx context.Context, arg CreatePostWithTaxonomyTermsTxParams) (CreatePostWithTaxonomyTermsTxResult, error) {
	var result CreatePostWithTaxonomyTermsTxResult

	err := store.ExecTx(ctx, func(q *Queries) error {
		var err error

		// validate all taxonomy terms before creating the post
		for _, termID := range arg.TaxonomyTermIDs {
			_, err := q.GetTaxonomyTerm(ctx, termID)
			if err != nil {
				return fmt.Errorf("taxonomy term %d not found: %w", termID, err)
			}
		}

		result.Post, err = q.CreatePosts(ctx, arg.CreatePostsParams)
		if err != nil {
			return fmt.Errorf("failed to create post: %w", err)
		}

		userPost, err := q.CreateUserPost(ctx, CreateUserPostParams{
			PostID: result.Post.ID,
			UserID: arg.UserID,
			Order:  0,
		})
		if err != nil {
			return fmt.Errorf("failed to create user-post relationship: %w", err)
		}
		result.UserPosts = append(result.UserPosts, userPost)

		// create user-post relationships for additional authors
		for i, authorID := range arg.AuthorIDs {
			if authorID != arg.UserID {
				userPost, err := q.CreateUserPost(ctx, CreateUserPostParams{
					PostID: result.Post.ID,
					UserID: authorID,
					Order:  int32(i + 1),
				})
				if err != nil {
					return fmt.Errorf("failed to create user-post relationship for author %d: %w", authorID, err)
				}
				result.UserPosts = append(result.UserPosts, userPost)
			}
		}

		// create taxonomy relationships
		for _, termID := range arg.TaxonomyTermIDs {
			relationship, err := q.AddPostToTaxonomyTerm(ctx, AddPostToTaxonomyTermParams{
				PostID:         result.Post.ID,
				TaxonomyTermID: termID,
			})
			if err != nil {
				return fmt.Errorf("failed to add taxonomy term %d to post: %w", termID, err)
			}
			result.PostTaxonomyRelationships = append(result.PostTaxonomyRelationships, relationship)
		}

		return nil
	})

	return result, err
}

func (store *SQLStore) DeleteTaxonomyTermTx(ctx context.Context, termID int64) error {
	err := store.ExecTx(ctx, func(q *Queries) error {
		// validate that the taxonomy term exists
		_, err := q.GetTaxonomyTerm(ctx, termID)
		if err != nil {
			return fmt.Errorf("taxonomy term %d not found: %w", termID, err)
		}

		err = q.RemoveAllPostTaxonomiesByTerm(ctx, termID)
		if err != nil {
			return fmt.Errorf("failed to remove post relationships for term %d: %w", termID, err)
		}

		err = q.DeleteTaxonomyTerm(ctx, termID)
		if err != nil {
			return fmt.Errorf("failed to delete taxonomy term %d: %w", termID, err)
		}

		return nil
	})

	return err
}

type UpdatePostTaxonomyTermsTxParams struct {
	PostID          int64
	TaxonomyTermIDs []int64
}

func (store *SQLStore) UpdatePostTaxonomyTermsTx(ctx context.Context, arg UpdatePostTaxonomyTermsTxParams) error {
	err := store.ExecTx(ctx, func(q *Queries) error {
		// Validate that the post exists
		_, err := q.GetPost(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("post %d not found: %w", arg.PostID, err)
		}

		// Validate all taxonomy terms exist
		for _, termID := range arg.TaxonomyTermIDs {
			_, err := q.GetTaxonomyTerm(ctx, termID)
			if err != nil {
				return fmt.Errorf("taxonomy term %d not found: %w", termID, err)
			}
		}

		// Remove all existing relationships for this post
		err = q.RemoveAllPostTaxonomies(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("failed to remove existing taxonomy relationships for post %d: %w", arg.PostID, err)
		}

		// Add new relationships
		for _, termID := range arg.TaxonomyTermIDs {
			_, err := q.AddPostToTaxonomyTerm(ctx, AddPostToTaxonomyTermParams{
				PostID:         arg.PostID,
				TaxonomyTermID: termID,
			})
			if err != nil {
				return fmt.Errorf("failed to add taxonomy term %d to post %d: %w", termID, arg.PostID, err)
			}
		}

		return nil
	})

	return err
}

func (store *SQLStore) CreateTaxonomyTermAndLinkTx(ctx context.Context, arg CreateTaxonomyTermAndLinkTxParams) (CreateTaxonomyTermAndLinkTxResult, error) {
	var result CreateTaxonomyTermAndLinkTxResult

	err := store.ExecTx(ctx, func(q *Queries) error {
		var err error

		// Validate that the taxonomy type exists
		_, err = q.GetTaxonomyTypeByID(ctx, arg.TaxonomyTypeID)
		if err != nil {
			return fmt.Errorf("taxonomy type %d not found: %w", arg.TaxonomyTypeID, err)
		}

		// Validate that the post exists
		_, err = q.GetPost(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("post %d not found: %w", arg.PostID, err)
		}

		// create the taxonomy term
		result.TaxonomyTerm, err = q.CreateTaxonomyTerm(ctx, arg.CreateTaxonomyTermParams)
		if err != nil {
			return fmt.Errorf("failed to create taxonomy term: %w", err)
		}

		// link the term to the post
		result.PostTaxonomyRelationship, err = q.AddPostToTaxonomyTerm(ctx, AddPostToTaxonomyTermParams{
			PostID:         arg.PostID,
			TaxonomyTermID: result.TaxonomyTerm.ID,
		})
		if err != nil {
			return fmt.Errorf("failed to link taxonomy term to post: %w", err)
		}

		return nil
	})

	return result, err
}

type CreateTaxonomyAndLinkTxParams struct {
	Name        string
	Description string
	PostID      int64
}

type CreateTaxonomyAndLinkTxResult struct {
	TaxonomyTerm             TaxonomyTerm             `json:"taxonomy_term"`
	PostTaxonomyRelationship PostTaxonomyRelationship `json:"post_taxonomy_relationship"`
}

type CreateTaxonomyTermAndLinkTxParams struct {
	CreateTaxonomyTermParams
	PostID int64
}

type CreateTaxonomyTermAndLinkTxResult struct {
	TaxonomyTerm             TaxonomyTerm             `json:"taxonomy_term"`
	PostTaxonomyRelationship PostTaxonomyRelationship `json:"post_taxonomy_relationship"`
}

type CreatePostWithMediaTxParams struct {
	CreatePostsParams
	AuthorIDs []int64
	MediaIDs  []int64
}

type CreatePostWithMediaTxResult struct {
	Post      Post         `json:"post"`
	UserPosts []UserPost   `json:"user_posts"`
	PostMedia []PostMedium `json:"post_media"`
}

// DeleteMediaTxParams identifies the media to delete and the caller deleting it.
// The ownership check (UserID must own the media) is skipped when AnyOwner is
// set; the API sets it for roles allowed to moderate other users' media.
type DeleteMediaTxParams struct {
	MediaID  int64
	UserID   int64
	AnyOwner bool
}

type UpdatePostMediaTxParams struct {
	PostID   int64
	MediaIDs []int64
}

type UpdatePostWithSlugTxParams struct {
	UpdatePostParams
	Slug string
}

// UpdatePostWithSlugTx applies UpdatePost and the slug change in one
// transaction, so a slug clash (unique index) doesn't leave the other field
// changes committed. UpdatePost itself can't take the slug: it COALESCEs
// non-null params, so its other callers would blank it.
func (store *SQLStore) UpdatePostWithSlugTx(ctx context.Context, arg UpdatePostWithSlugTxParams) (Post, error) {
	var post Post
	err := store.ExecTx(ctx, func(q *Queries) error {
		if _, err := q.UpdatePost(ctx, arg.UpdatePostParams); err != nil {
			return err
		}
		var err error
		post, err = q.UpdatePostSlug(ctx, UpdatePostSlugParams{ID: arg.ID, Slug: arg.Slug})
		return err
	})
	return post, err
}

type CreateMediaAndLinkTxParams struct {
	Name             string
	Description      string
	Alt              string
	MediaPath        string
	UserID           int64
	FileSize         int64
	MimeType         string
	Width            int32
	Height           int32
	Duration         int32
	OriginalFilename string
	PostID           int64
	Order            int32
	// Variants is the generated image variants (NULL stores {}).
	Variants pqtype.NullRawMessage
	// Decorative marks an image whose empty alt text is intended (#325).
	Decorative bool
}

type CreateMediaAndLinkTxResult struct {
	Media     Medium     `json:"media"`
	PostMedia PostMedium `json:"post_media"`
}

func (store *SQLStore) CreatePostWithMediaTx(ctx context.Context, arg CreatePostWithMediaTxParams) (CreatePostWithMediaTxResult, error) {
	var result CreatePostWithMediaTxResult

	err := store.ExecTx(ctx, func(q *Queries) error {
		var err error

		result.Post, err = q.CreatePosts(ctx, arg.CreatePostsParams)
		if err != nil {
			return err
		}

		userPost, err := q.CreateUserPost(ctx, CreateUserPostParams{
			PostID: result.Post.ID,
			UserID: arg.UserID,
			Order:  0,
		})
		if err != nil {
			return err
		}
		result.UserPosts = append(result.UserPosts, userPost)

		for i, authorID := range arg.AuthorIDs {
			if authorID != arg.UserID {
				userPost, err := q.CreateUserPost(ctx, CreateUserPostParams{
					PostID: result.Post.ID,
					UserID: authorID,
					Order:  int32(i + 1),
				})
				if err != nil {
					return err
				}
				result.UserPosts = append(result.UserPosts, userPost)
			}
		}

		for i, mediaID := range uniqueMediaIDs(arg.MediaIDs) {

			_, err := q.GetMedia(ctx, mediaID)
			if err != nil {
				return fmt.Errorf("media %d not found: %w", mediaID, err)
			}

			postMedia, err := q.CreatePostMedia(ctx, CreatePostMediaParams{
				PostID:  result.Post.ID,
				MediaID: mediaID,
				Order:   int32(i),
			})
			if err != nil {
				return err
			}
			result.PostMedia = append(result.PostMedia, postMedia)
		}

		return nil
	})

	return result, err
}

func (store *SQLStore) DeleteMediaTx(ctx context.Context, arg DeleteMediaTxParams) error {
	err := store.ExecTx(ctx, func(q *Queries) error {

		media, err := q.GetMedia(ctx, arg.MediaID)
		if err != nil {
			return err
		}

		if !arg.AnyOwner && media.UserID != arg.UserID {
			return fmt.Errorf("user %d, media %d: %w", arg.UserID, arg.MediaID, ErrMediaNotOwned)
		}

		err = q.DeleteMediaPosts(ctx, arg.MediaID)
		if err != nil {
			return err
		}

		err = q.DeleteMedia(ctx, arg.MediaID)
		if err != nil {
			return err
		}

		return nil
	})

	return err
}

// uniqueMediaIDs keeps the first position of each media id. CreatePostMedia
// upserts on (post_id, media_id), so a repeated id would move its row to the
// later position, the featured image (order 0) included (#389).
func uniqueMediaIDs(ids []int64) []int64 {
	seen := make(map[int64]bool, len(ids))
	unique := make([]int64, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	return unique
}

func (store *SQLStore) UpdatePostMediaTx(ctx context.Context, arg UpdatePostMediaTxParams) error {
	err := store.ExecTx(ctx, func(q *Queries) error {

		_, err := q.GetPost(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("post %d not found: %w", arg.PostID, err)
		}

		err = q.DeletePostMedias(ctx, arg.PostID)
		if err != nil {
			return err
		}

		for i, mediaID := range uniqueMediaIDs(arg.MediaIDs) {

			_, err := q.GetMedia(ctx, mediaID)
			if err != nil {
				return fmt.Errorf("media %d not found: %w", mediaID, err)
			}

			_, err = q.CreatePostMedia(ctx, CreatePostMediaParams{
				PostID:  arg.PostID,
				MediaID: mediaID,
				Order:   int32(i),
			})
			if err != nil {
				return err
			}
		}

		return nil
	})

	return err
}

func (store *SQLStore) CreateMediaAndLinkTx(ctx context.Context, arg CreateMediaAndLinkTxParams) (CreateMediaAndLinkTxResult, error) {
	var result CreateMediaAndLinkTxResult

	err := store.ExecTx(ctx, func(q *Queries) error {
		var err error

		result.Media, err = q.CreateMedia(ctx, CreateMediaParams{
			Name:             arg.Name,
			Description:      arg.Description,
			Alt:              arg.Alt,
			MediaPath:        arg.MediaPath,
			UserID:           arg.UserID,
			FileSize:         arg.FileSize,
			MimeType:         arg.MimeType,
			Width:            arg.Width,
			Height:           arg.Height,
			Duration:         arg.Duration,
			OriginalFilename: arg.OriginalFilename,
			Variants:         arg.Variants,
			Decorative:       arg.Decorative,
		})
		if err != nil {
			return err
		}

		_, err = q.GetPost(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("post %d not found: %w", arg.PostID, err)
		}

		result.PostMedia, err = q.CreatePostMedia(ctx, CreatePostMediaParams{
			PostID:  arg.PostID,
			MediaID: result.Media.ID,
			Order:   arg.Order,
		})
		if err != nil {
			return err
		}

		return nil
	})

	return result, err
}

// ErrMediaChanged is returned by SetMediaVariantsTx when the media row no
// longer describes the file the variants were generated from (a replace or
// an edit happened in between).
var ErrMediaChanged = errors.New("media changed since its variants were generated")

type SetMediaVariantsTxParams struct {
	ID int64
	// MediaPath and ChangedAt are the row's values when the variants were
	// generated; the write only happens if both still match.
	MediaPath string
	ChangedAt time.Time
	Variants  json.RawMessage
	// CommitFiles moves the generated files into place. It runs while the row
	// is locked, after the check, so it never overwrites a newer replace's
	// variants: that replace's UPDATE waits for this transaction.
	CommitFiles func() error
}

// SetMediaVariantsTx is the variant backfill's write: lock the row, check it
// still describes the same file, move the files into place and store the
// variants. The backfill runs in its own process, so the API's in-process
// replace lock doesn't cover it; the row lock does.
func (store *SQLStore) SetMediaVariantsTx(ctx context.Context, arg SetMediaVariantsTxParams) (Medium, error) {
	var media Medium
	err := store.ExecTx(ctx, func(q *Queries) error {
		current, err := q.GetMediaForUpdate(ctx, arg.ID)
		if err != nil {
			return err
		}
		if current.MediaPath != arg.MediaPath || !current.ChangedAt.Equal(arg.ChangedAt) {
			return ErrMediaChanged
		}
		if arg.CommitFiles != nil {
			if err := arg.CommitFiles(); err != nil {
				return err
			}
		}
		media, err = q.SetMediaVariants(ctx, SetMediaVariantsParams{ID: arg.ID, Variants: arg.Variants})
		return err
	})
	return media, err
}
