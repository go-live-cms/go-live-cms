package db

import (
	"context"
	"database/sql"
	"fmt"
)

type Store interface {
	Querier
	CreatePostTx(ctx context.Context, arg CreatePostTxParams) (CreatePostTxResult, error)
	DeletePostTx(ctx context.Context, id int64) error

	DeleteUserTx(ctx context.Context, id int64) error
	DeleteUserWithTransferTx(ctx context.Context, arg DeleteUserWithTransferTxParams) error
	UpdateUserTx(ctx context.Context, arg UpdateUserTxParams) (UpdateUserTxResult, error)

	CreatePostWithTaxonomiesTx(ctx context.Context, arg CreatePostWithTaxonomiesTxParams) (CreatePostWithTaxonomiesTxResult, error)
	DeleteTaxonomyTx(ctx context.Context, id int64) error
	UpdatePostTaxonomiesTx(ctx context.Context, arg UpdatePostTaxonomiesTxParams) error
	CreateTaxonomyAndLinkTx(ctx context.Context, arg CreateTaxonomyAndLinkTxParams) (CreateTaxonomyAndLinkTxResult, error)

	CreatePostWithMediaTx(ctx context.Context, arg CreatePostWithMediaTxParams) (CreatePostWithMediaTxResult, error)
	DeleteMediaTx(ctx context.Context, arg DeleteMediaTxParams) error
	UpdatePostMediaTx(ctx context.Context, arg UpdatePostMediaTxParams) error
	CreateMediaAndLinkTx(ctx context.Context, arg CreateMediaAndLinkTxParams) (CreateMediaAndLinkTxResult, error)

	ExecTx(ctx context.Context, fn func(*Queries) error) error
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

		err := q.DeleteUserSessions(ctx, id)
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
}

type UpdateUserTxResult struct {
	User User `json:"user"`
}

func (store *SQLStore) UpdateUserTx(ctx context.Context, arg UpdateUserTxParams) (UpdateUserTxResult, error) {
	var result UpdateUserTxResult

	err := store.execTx(ctx, func(q *Queries) error {
		var err error

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

		err := q.TransferPostsToAdmin(ctx, TransferPostsToAdminParams{
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

type CreatePostWithTaxonomiesTxParams struct {
	CreatePostsParams
	AuthorIDs   []int64
	TaxonomyIDs []int64
}

type CreatePostWithTaxonomiesTxResult struct {
	Post           Post            `json:"post"`
	UserPosts      []UserPost      `json:"user_posts"`
	PostTaxonomies []PostsTaxonomy `json:"post_taxonomies"`
}

func (store *SQLStore) CreatePostWithTaxonomiesTx(ctx context.Context, arg CreatePostWithTaxonomiesTxParams) (CreatePostWithTaxonomiesTxResult, error) {
	var result CreatePostWithTaxonomiesTxResult

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

		for _, taxonomyID := range arg.TaxonomyIDs {

			_, err := q.GetTaxonomy(ctx, taxonomyID)
			if err != nil {
				return fmt.Errorf("taxonomy %d not found: %w", taxonomyID, err)
			}

			postTaxonomy, err := q.CreatePostTaxonomy(ctx, CreatePostTaxonomyParams{
				PostID:     result.Post.ID,
				TaxonomyID: taxonomyID,
			})
			if err != nil {
				return err
			}
			result.PostTaxonomies = append(result.PostTaxonomies, postTaxonomy)
		}

		return nil
	})

	return result, err
}

func (store *SQLStore) DeleteTaxonomyTx(ctx context.Context, id int64) error {
	err := store.ExecTx(ctx, func(q *Queries) error {

		err := q.DeleteTaxonomyPosts(ctx, id)
		if err != nil {
			return err
		}

		err = q.DeleteTaxonomy(ctx, id)
		if err != nil {
			return err
		}

		return nil
	})

	return err
}

type UpdatePostTaxonomiesTxParams struct {
	PostID      int64
	TaxonomyIDs []int64
}

func (store *SQLStore) UpdatePostTaxonomiesTx(ctx context.Context, arg UpdatePostTaxonomiesTxParams) error {
	err := store.ExecTx(ctx, func(q *Queries) error {

		err := q.DeletePostTaxonomies(ctx, arg.PostID)
		if err != nil {
			return err
		}

		for _, taxonomyID := range arg.TaxonomyIDs {

			_, err := q.GetTaxonomy(ctx, taxonomyID)
			if err != nil {
				return fmt.Errorf("taxonomy %d not found: %w", taxonomyID, err)
			}

			_, err = q.CreatePostTaxonomy(ctx, CreatePostTaxonomyParams{
				PostID:     arg.PostID,
				TaxonomyID: taxonomyID,
			})
			if err != nil {
				return err
			}
		}

		return nil
	})

	return err
}

type CreateTaxonomyAndLinkTxParams struct {
	Name        string
	Description string
	PostID      int64
}

type CreateTaxonomyAndLinkTxResult struct {
	Taxonomy     Taxonomy      `json:"taxonomy"`
	PostTaxonomy PostsTaxonomy `json:"post_taxonomy"`
}

func (store *SQLStore) CreateTaxonomyAndLinkTx(ctx context.Context, arg CreateTaxonomyAndLinkTxParams) (CreateTaxonomyAndLinkTxResult, error) {
	var result CreateTaxonomyAndLinkTxResult

	err := store.ExecTx(ctx, func(q *Queries) error {
		var err error

		existingTaxonomy, err := q.GetTaxonomyByName(ctx, arg.Name)
		if err == nil {
			result.Taxonomy = existingTaxonomy
		} else {
			result.Taxonomy, err = q.CreateTaxonomy(ctx, CreateTaxonomyParams{
				Name:        arg.Name,
				Description: arg.Description,
			})
			if err != nil {
				return err
			}
		}

		_, err = q.GetPost(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("post %d not found: %w", arg.PostID, err)
		}

		existing, _ := q.GetPostTaxonomies(ctx, arg.PostID)
		for _, t := range existing {
			if t.ID == result.Taxonomy.ID {
				result.PostTaxonomy = PostsTaxonomy{
					PostID:     arg.PostID,
					TaxonomyID: result.Taxonomy.ID,
				}
				return nil
			}
		}

		result.PostTaxonomy, err = q.CreatePostTaxonomy(ctx, CreatePostTaxonomyParams{
			PostID:     arg.PostID,
			TaxonomyID: result.Taxonomy.ID,
		})
		if err != nil {
			return err
		}

		return nil
	})

	return result, err
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

type DeleteMediaTxParams struct {
	MediaID int64
	UserID  int64
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

		if media.UserID != arg.UserID {
			return fmt.Errorf("user %d does not own media %d", arg.UserID, arg.MediaID)
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
