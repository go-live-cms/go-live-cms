package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

type CreatePostTemplateTxParams struct {
	// SourcePostID is the post the template is saved from; its featured image
	// and category terms are read inside the transaction.
	SourcePostID int64
	PostType     string
	Name         string
	// BlockDoc is the source's working copy, already checked by the caller
	// (prepareForStore).
	BlockDoc json.RawMessage
	// WithSettings also saves the source's category and featured image.
	WithSettings bool
	CreatedBy    int64
}

// CreatePostTemplateTx saves a template from a post (#322) in one transaction:
// the row, and with WithSettings the source's featured image and category terms.
func (store *SQLStore) CreatePostTemplateTx(ctx context.Context, arg CreatePostTemplateTxParams) (PostTemplate, error) {
	var template PostTemplate
	err := store.execTx(ctx, func(q *Queries) error {
		var err error
		template, err = q.CreatePostTemplate(ctx, CreatePostTemplateParams{
			PostType:     arg.PostType,
			Name:         arg.Name,
			BlockDoc:     arg.BlockDoc,
			WithSettings: arg.WithSettings,
			SourcePostID: arg.SourcePostID,
			CreatedBy:    sql.NullInt64{Int64: arg.CreatedBy, Valid: arg.CreatedBy != 0},
		})
		if err != nil {
			return err
		}
		if !arg.WithSettings {
			return nil
		}
		return q.CopyPostCategoryTermsToTemplate(ctx, CopyPostCategoryTermsToTemplateParams{
			TemplateID:   template.ID,
			SourcePostID: arg.SourcePostID,
		})
	})
	return template, err
}

type CreatePostFromTemplateTxParams struct {
	// TemplateID is the template the post is made from: its saved category and
	// featured image are read inside the transaction.
	TemplateID int64
	// CreatePostsParams is the new post's row, built by the caller like a
	// duplicate's (#354): owner, title, slug, url, draft status and the
	// template's block_doc with every block id regenerated. UserID is also the
	// post's only byline (user_posts).
	CreatePostsParams
	// ContentMedia are the new block_doc's image blocks in document order; the
	// content links (post_media order > 0) are synced to them.
	ContentMedia []ContentMediaUse
	// PublicMediaPath maps a media row's stored path to the URL kept in the
	// _thumbnail_url meta (the API's publicMediaPath).
	PublicMediaPath func(mediaPath string) string
}

// CreatePostFromTemplateTx creates a draft from a template (#322) in one
// transaction: the row, the caller's byline, the template's category terms and
// featured image (the order-0 post_media link and its _thumbnail_* meta, as
// setFeaturedImage writes them), and the content media links. Like a duplicate
// it has no Yjs state: the collab server seeds it from block_doc on first open.
func (store *SQLStore) CreatePostFromTemplateTx(ctx context.Context, arg CreatePostFromTemplateTxParams) (Post, error) {
	var post Post
	err := store.execTx(ctx, func(q *Queries) error {
		template, err := q.GetPostTemplate(ctx, arg.TemplateID)
		if err != nil {
			return err
		}
		post, err = q.CreatePosts(ctx, arg.CreatePostsParams)
		if err != nil {
			return err
		}
		if _, err := q.CreateUserPost(ctx, CreateUserPostParams{PostID: post.ID, UserID: arg.UserID, Order: 0}); err != nil {
			return err
		}
		if err := q.CopyTemplateTermsToPost(ctx, CopyTemplateTermsToPostParams{NewPostID: post.ID, TemplateID: template.ID}); err != nil {
			return err
		}
		// A template saved without its category: the default one (#331).
		if _, err := q.EnsureDefaultCategory(ctx, []int64{post.ID}); err != nil {
			return err
		}
		if template.FeaturedMediaID.Valid {
			if err := setTemplateFeaturedImage(ctx, q, post.ID, template.FeaturedMediaID.Int64, arg.PublicMediaPath); err != nil {
				return err
			}
		}
		return syncContentMedia(ctx, q, post.ID, arg.ContentMedia)
	})
	return post, err
}

// setTemplateFeaturedImage links a new post's featured image. An image
// deleted since the template was read is skipped (the FK set it NULL anyway).
func setTemplateFeaturedImage(ctx context.Context, q *Queries, postID, mediaID int64, publicPath func(string) string) error {
	media, err := q.GetMedia(ctx, mediaID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := q.CreatePostMedia(ctx, CreatePostMediaParams{PostID: postID, MediaID: media.ID, Order: 0}); err != nil {
		return err
	}
	url := media.MediaPath
	if publicPath != nil {
		url = publicPath(media.MediaPath)
	}
	for key, value := range map[string]string{
		"_thumbnail_id":  strconv.FormatInt(media.ID, 10),
		"_thumbnail_url": url,
	} {
		if _, err := q.UpsertPostMeta(ctx, UpsertPostMetaParams{
			PostID:    postID,
			MetaKey:   key,
			MetaValue: sql.NullString{String: value, Valid: true},
		}); err != nil {
			return err
		}
	}
	return nil
}
