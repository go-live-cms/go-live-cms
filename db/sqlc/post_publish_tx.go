package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/sqlc-dev/pqtype"
)

type PublishPostTxParams struct {
	PostID    int64
	Label     sql.NullString
	Message   sql.NullString
	CreatedBy sql.NullInt64
	// ContentMedia gives the image blocks of the published body in document
	// order (the api package parses it). Their post_media links are synced
	// with SyncPostContentMedia, which leaves the featured image's order (0)
	// alone. Nil leaves the links as they are.
	ContentMedia func(blockDoc json.RawMessage) []ContentMediaUse
}

type PublishPostTxResult struct {
	VersionID int64
	VersionNo int32
	// BlockDoc is the published body (the working copy at publish time).
	BlockDoc json.RawMessage
}

// PublishPostTx publishes the post's working copy (#136, #358) in one
// transaction: lock the post, write the next version with its block_doc and
// settings (one INSERT ... SELECT, so both are the same moment's), and point
// the post's published snapshot at it, then sync the content image links
// (#389). Before, the blocks were read and the version written in separate
// statements, so a concurrent publish could take the same version_no, and
// settings weren't saved at all. The links were synced after the commit, one
// CreatePostMedia upsert per image, which moved a featured image that was also
// in the content from order 0 to its content position. sql.ErrNoRows: no such
// post.
func (store *SQLStore) PublishPostTx(ctx context.Context, arg PublishPostTxParams) (PublishPostTxResult, error) {
	var result PublishPostTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.LockPostForPublish(ctx, arg.PostID); err != nil {
			return err
		}
		next, err := q.GetNextVersionNoForPost(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("next version number: %w", err)
		}
		version, err := q.InsertPublishedVersionFromPost(ctx, InsertPublishedVersionFromPostParams{
			PostID:    arg.PostID,
			VersionNo: next,
			Label:     arg.Label,
			Message:   arg.Message,
			CreatedBy: arg.CreatedBy,
		})
		if err != nil {
			return fmt.Errorf("insert version: %w", err)
		}
		if err := q.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
			ID:                 arg.PostID,
			PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
			PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: version.BlockDoc, Valid: true},
		}); err != nil {
			return fmt.Errorf("set published version: %w", err)
		}
		if arg.ContentMedia != nil {
			if err := syncContentMedia(ctx, q, arg.PostID, arg.ContentMedia(version.BlockDoc)); err != nil {
				return fmt.Errorf("sync content media: %w", err)
			}
		}
		result = PublishPostTxResult{VersionID: version.ID, VersionNo: version.VersionNo, BlockDoc: version.BlockDoc}
		return nil
	})
	return result, err
}

type RestorePostSettingsTxParams struct {
	PostID   int64
	Settings RestoredPostSettings
}

// RestoredPostSettings is what restoring a version writes back (#358). The api
// package decodes the version's snapshot into it.
type RestoredPostSettings struct {
	Title       string
	Description string
	// FeaturedImageID is nil for no featured image.
	FeaturedImageID *int64
	TermIDs         []int64
	// ThumbnailURL gives the _thumbnail_url stored with the featured image, from
	// the media row as it is now (the api maps its path to the /uploads URL).
	ThumbnailURL func(Medium) string
}

// RestorePostSettingsTx puts a version's settings back into the post's working
// copy (#358): title, excerpt, featured image (post_media order 0 and the
// _thumbnail_* meta, as POST /posts/:id/featured-image writes them) and term
// links. The published settings stay as they are until Update. A featured image
// whose media was deleted since is dropped, and so are deleted terms.
func (store *SQLStore) RestorePostSettingsTx(ctx context.Context, arg RestorePostSettingsTxParams) (Post, error) {
	var post Post
	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.LockPostForPublish(ctx, arg.PostID); err != nil {
			return err
		}
		var err error
		post, err = q.RestorePostTitleAndDescription(ctx, RestorePostTitleAndDescriptionParams{
			ID:          arg.PostID,
			Title:       arg.Settings.Title,
			Description: arg.Settings.Description,
		})
		if err != nil {
			return fmt.Errorf("restore title: %w", err)
		}

		if err := q.UnlinkPostFeaturedMedia(ctx, arg.PostID); err != nil {
			return fmt.Errorf("remove featured image: %w", err)
		}
		for _, key := range []string{"_thumbnail_id", "_thumbnail_url"} {
			if err := q.DeletePostMeta(ctx, DeletePostMetaParams{PostID: arg.PostID, MetaKey: key}); err != nil {
				return fmt.Errorf("remove %s meta: %w", key, err)
			}
		}
		if id := arg.Settings.FeaturedImageID; id != nil {
			if media, err := q.GetMedia(ctx, *id); err == nil {
				// CreatePostMedia upserts: an image also linked as a content image
				// moves to order 0, as POST /posts/:id/featured-image does.
				if _, err := q.CreatePostMedia(ctx, CreatePostMediaParams{PostID: arg.PostID, MediaID: *id, Order: 0}); err != nil {
					return fmt.Errorf("link featured image: %w", err)
				}
				if _, err := q.UpsertPostMeta(ctx, UpsertPostMetaParams{
					PostID:    arg.PostID,
					MetaKey:   "_thumbnail_id",
					MetaValue: sql.NullString{String: fmt.Sprintf("%d", *id), Valid: true},
				}); err != nil {
					return fmt.Errorf("store thumbnail id: %w", err)
				}
				if _, err := q.UpsertPostMeta(ctx, UpsertPostMetaParams{
					PostID:    arg.PostID,
					MetaKey:   "_thumbnail_url",
					MetaValue: sql.NullString{String: arg.Settings.ThumbnailURL(media), Valid: true},
				}); err != nil {
					return fmt.Errorf("store thumbnail url: %w", err)
				}
			} else if err != sql.ErrNoRows {
				return fmt.Errorf("get media: %w", err)
			}
		}

		if err := q.RemoveAllPostTaxonomies(ctx, arg.PostID); err != nil {
			return fmt.Errorf("remove terms: %w", err)
		}
		if len(arg.Settings.TermIDs) > 0 {
			if err := q.AddExistingTermsToPost(ctx, AddExistingTermsToPostParams{
				PostID:  arg.PostID,
				TermIds: arg.Settings.TermIDs,
			}); err != nil {
				return fmt.Errorf("restore terms: %w", err)
			}
		}
		return nil
	})
	return post, err
}
