package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

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
		var err error
		result, err = publishLockedPost(ctx, q, arg)
		return err
	})
	return result, err
}

// publishLockedPost is the publish itself, for a post whose row the
// transaction has locked: PublishPostTx (the Publish button) and
// PublishScheduledPostTx (the scheduler, #147) share it, so a scheduled post
// is published exactly like one published by hand. SetPublishedVersionOnPost
// also clears any schedule.
func publishLockedPost(ctx context.Context, q *Queries, arg PublishPostTxParams) (PublishPostTxResult, error) {
	next, err := q.GetNextVersionNoForPost(ctx, arg.PostID)
	if err != nil {
		return PublishPostTxResult{}, fmt.Errorf("next version number: %w", err)
	}
	version, err := q.InsertPublishedVersionFromPost(ctx, InsertPublishedVersionFromPostParams{
		PostID:    arg.PostID,
		VersionNo: next,
		Label:     arg.Label,
		Message:   arg.Message,
		CreatedBy: arg.CreatedBy,
	})
	if err != nil {
		return PublishPostTxResult{}, fmt.Errorf("insert version: %w", err)
	}
	if err := q.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID:                 arg.PostID,
		PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: version.BlockDoc, Valid: true},
	}); err != nil {
		return PublishPostTxResult{}, fmt.Errorf("set published version: %w", err)
	}
	if arg.ContentMedia != nil {
		if err := syncContentMedia(ctx, q, arg.PostID, arg.ContentMedia(version.BlockDoc)); err != nil {
			return PublishPostTxResult{}, fmt.Errorf("sync content media: %w", err)
		}
	}
	return PublishPostTxResult{VersionID: version.ID, VersionNo: version.VersionNo, BlockDoc: version.BlockDoc}, nil
}

type PublishScheduledPostTxParams struct {
	PostID int64
	// Claim is the claim's fencing token, ClaimDueScheduledPosts'
	// publish_next_attempt_at.
	Claim time.Time
	// ContentMedia as in PublishPostTxParams.
	ContentMedia func(blockDoc json.RawMessage) []ContentMediaUse
}

// ErrScheduleChanged: PublishScheduledPostTx found the post no longer
// scheduled under the claim (cancelled, rescheduled, published by hand,
// deleted, or claimed again after the lease ran out). Nothing was written.
var ErrScheduleChanged = errors.New("the post's schedule changed since it was claimed")

// PublishScheduledPostTx publishes a scheduled post the scheduler claimed
// (#147): lock the row and check, under the lock, that it is still scheduled
// under this claim, then publishLockedPost, the Publish button's path. The
// version is credited to whoever scheduled it. The check is what makes the
// publish happen once: a second replica, or the same post claimed again after
// a lease ran out, finds it published (or reclaimed) and gets
// ErrScheduleChanged. The caller flushes the collab document first, outside
// the transaction: the collab store locks this row too.
func (store *SQLStore) PublishScheduledPostTx(ctx context.Context, arg PublishScheduledPostTxParams) (PublishPostTxResult, error) {
	var result PublishPostTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		claim, err := q.LockScheduledPostClaim(ctx, LockScheduledPostClaimParams{ID: arg.PostID, Claim: arg.Claim})
		if errors.Is(err, sql.ErrNoRows) {
			return ErrScheduleChanged
		}
		if err != nil {
			return fmt.Errorf("lock scheduled post: %w", err)
		}
		result, err = publishLockedPost(ctx, q, PublishPostTxParams{
			PostID:       arg.PostID,
			CreatedBy:    claim.PublishScheduledBy,
			ContentMedia: arg.ContentMedia,
		})
		return err
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

	// The SEO fields (#357). SocialImageID is nil for none; a deleted one is dropped.
	SEOTitle       string
	SEODescription string
	SocialImageID  *int64
	Noindex        bool
	CanonicalURL   string

	// AuthorIDs is the version's byline (#319), in credit order. Users removed
	// since are skipped; nil (a version from before #319), or none left, keeps the
	// working byline as it is.
	AuthorIDs []int64
}

// RestorePostSettingsTx puts a version's settings back into the post's working
// copy (#358): title, excerpt, featured image (post_media order 0 and the
// _thumbnail_* meta, as POST /posts/:id/featured-image writes them), term
// links, the SEO fields (#357) and the byline (#319). The published settings stay as they are until
// Update. A featured or social image whose media was deleted since is dropped,
// and so are deleted terms.
func (store *SQLStore) RestorePostSettingsTx(ctx context.Context, arg RestorePostSettingsTxParams) (Post, error) {
	var post Post
	err := store.execTx(ctx, func(q *Queries) error {
		// The byline's users before the post, like SetPostAuthorsTx (lock order).
		var authors []int64
		if len(arg.Settings.AuthorIDs) > 0 {
			var err error
			if authors, err = lockAuthors(ctx, q, arg.Settings.AuthorIDs, false); err != nil {
				return fmt.Errorf("restore byline: %w", err)
			}
		}
		if _, err := q.LockPostForPublish(ctx, arg.PostID); err != nil {
			return err
		}
		// SEO first: the title's UPDATE returns the row, with these in it.
		seo := RestorePostSEOParams{
			PostID:         arg.PostID,
			SeoTitle:       arg.Settings.SEOTitle,
			SeoDescription: arg.Settings.SEODescription,
			Noindex:        arg.Settings.Noindex,
			CanonicalUrl:   arg.Settings.CanonicalURL,
		}
		if id := arg.Settings.SocialImageID; id != nil {
			seo.SocialImageID = sql.NullInt64{Int64: *id, Valid: true}
		}
		if err := q.RestorePostSEO(ctx, seo); err != nil {
			return fmt.Errorf("restore SEO: %w", err)
		}
		if err := replaceByline(ctx, q, arg.PostID, authors); err != nil {
			return fmt.Errorf("restore byline: %w", err)
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
