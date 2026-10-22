package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
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
	DeletePostTx(ctx context.Context, id int64) error

	DeleteUserTx(ctx context.Context, id int64) error
	DeleteUserWithTransferTx(ctx context.Context, arg DeleteUserWithTransferTxParams) error
	UpdateUserTx(ctx context.Context, arg UpdateUserTxParams) (UpdateUserTxResult, error)

	CreatePostWithTaxonomyTermsTx(ctx context.Context, arg CreatePostWithTaxonomyTermsTxParams) (CreatePostWithTaxonomyTermsTxResult, error)
	DeleteTaxonomyTermTx(ctx context.Context, id int64) error
	UpdatePostTaxonomyTermsTx(ctx context.Context, arg UpdatePostTaxonomyTermsTxParams) error
	CreateTaxonomyTermAndLinkTx(ctx context.Context, arg CreateTaxonomyTermAndLinkTxParams) (CreateTaxonomyTermAndLinkTxResult, error)

	CreatePostWithMediaTx(ctx context.Context, arg CreatePostWithMediaTxParams) (CreatePostWithMediaTxResult, error)
	DeleteMediaTx(ctx context.Context, arg DeleteMediaTxParams) error
	UpdatePostMediaTx(ctx context.Context, arg UpdatePostMediaTxParams) error
	CreateMediaAndLinkTx(ctx context.Context, arg CreateMediaAndLinkTxParams) (CreateMediaAndLinkTxResult, error)

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

func (store *SQLStore) DeleteUserTx(ctx context.Context, id int64) error {
	err := store.execTx(ctx, func(q *Queries) error {

		err := guardLastAdmin(ctx, q, id)
		if err != nil {
			return err
		}

		err = q.DeleteUserSessions(ctx, id)
		if err != nil {
			return err
		}

		err = q.DeleteUserPostsByUserID(ctx, id)
		if err != nil {
			return err
		}

		err = q.DeleteMediaByUserID(ctx, id)
		if err != nil {
			return err
		}

		err = q.DeletePostsByUserID(ctx, id)
		if err != nil {
			return err
		}

		err = q.DeleteUser(ctx, id)
		if err != nil {
			return err
		}

		return nil
	})

	return err
}

type UpdateUserTxParams struct {
	UpdateUserParams
	CheckUniqueness bool
	// PasswordChanged marks HashedPassword as a new password. The transaction
	// then locks the user row, stamps PasswordChangedAt itself (overriding the
	// caller's value), and blocks every session the user holds, so a stolen
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
		}

		return nil
	})

	return result, err
}

type DeleteUserWithTransferTxParams struct {
	UserID       int64
	TransferToID int64
}

func (store *SQLStore) DeleteUserWithTransferTx(ctx context.Context, arg DeleteUserWithTransferTxParams) error {
	err := store.execTx(ctx, func(q *Queries) error {

		err := guardLastAdmin(ctx, q, arg.UserID)
		if err != nil {
			return err
		}

		err = q.TransferPostsToAdmin(ctx, TransferPostsToAdminParams{
			UserID:   arg.UserID,
			UserID_2: arg.TransferToID,
		})
		if err != nil {
			return err
		}

		err = q.UpdateUserPostsOwnership(ctx, UpdateUserPostsOwnershipParams{
			UserID:   arg.UserID,
			UserID_2: arg.TransferToID,
		})
		if err != nil {
			return err
		}

		err = q.TransferMediaToUser(ctx, TransferMediaToUserParams{
			UserID:   arg.UserID,
			UserID_2: arg.TransferToID,
		})
		if err != nil {
			return err
		}

		err = q.DeleteUserSessions(ctx, arg.UserID)
		if err != nil {
			return err
		}

		err = q.DeleteUser(ctx, arg.UserID)
		if err != nil {
			return err
		}

		return nil
	})

	return err
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

		for i, mediaID := range arg.MediaIDs {

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

		for i, mediaID := range arg.MediaIDs {

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
