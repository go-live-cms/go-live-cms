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
	// CancelledScheduledUpdate: PublishPostTx (the Update button) superseded a
	// pending scheduled update (#335), which 000035's trigger deleted. The editor
	// says so, whichever tab scheduled it.
	CancelledScheduledUpdate bool
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
		locked, err := q.LockPostForPublish(ctx, arg.PostID)
		if err != nil {
			return err
		}
		// Publishing would bring a trashed post back on the site around restore.
		if locked.PostStatus == PostStatusTrash {
			return ErrPostTrashed
		}
		// Under the post's lock, so no schedule or cancel slips in between.
		_, pendingErr := q.GetPostScheduledUpdate(ctx, arg.PostID)
		if pendingErr != nil && !errors.Is(pendingErr, sql.ErrNoRows) {
			return fmt.Errorf("scheduled update: %w", pendingErr)
		}
		result, err = publishLockedPost(ctx, q, arg)
		result.CancelledScheduledUpdate = pendingErr == nil
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
	return publishInsertedVersion(ctx, q, arg.PostID, PublishPostTxResult{
		VersionID: version.ID, VersionNo: version.VersionNo, BlockDoc: version.BlockDoc,
	}, arg.ContentMedia)
}

// publishInsertedVersion makes a version just inserted the post's published
// snapshot and syncs the content image links from its body: the rest of a publish,
// whichever way the version was written (the working copy, or a scheduled update's
// frozen snapshot, #335). SetPublishedVersionOnPost changes published_version_id,
// so 000035's trigger also ends any scheduled update: an Update by hand supersedes
// it, and an applied one is done.
func publishInsertedVersion(ctx context.Context, q *Queries, postID int64, version PublishPostTxResult, contentMedia func(json.RawMessage) []ContentMediaUse) (PublishPostTxResult, error) {
	if err := q.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID:                 postID,
		PublishedVersionID: sql.NullInt64{Int64: version.VersionID, Valid: true},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: version.BlockDoc, Valid: true},
	}); err != nil {
		return PublishPostTxResult{}, fmt.Errorf("set published version: %w", err)
	}
	if contentMedia != nil {
		if err := syncContentMedia(ctx, q, postID, contentMedia(version.BlockDoc)); err != nil {
			return PublishPostTxResult{}, fmt.Errorf("sync content media: %w", err)
		}
	}
	return version, nil
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

// PostScheduledUpdateRow is a pending scheduled update without its snapshot
// (#335): what ScheduleUpdateTx returns and GET /posts/:id shows.
type PostScheduledUpdateRow = GetPostScheduledUpdateRow

type ScheduleUpdateTxParams struct {
	PostID      int64
	UpdateAt    time.Time
	ScheduledBy sql.NullInt64
}

var (
	// ErrPostNotPublished: ScheduleUpdateTx found the post isn't published, so
	// there is no live post to update (a draft is scheduled with SchedulePost).
	ErrPostNotPublished = errors.New("the post isn't published")
	// ErrNoUnpublishedChanges: ScheduleUpdateTx found the working copy equal to
	// what the site shows (#326): there is nothing to update.
	ErrNoUnpublishedChanges = errors.New("the post has no changes to publish")
)

// ScheduleUpdateTx schedules a published post's Update (#335): lock the post,
// check it is published and its working copy differs from the live one, and
// freeze that working copy (block_doc and settings, as stored now) with the time,
// replacing any update scheduled before. The caller flushes the collab document
// first, outside the transaction (the collab store locks this row too), as publish
// does, so the snapshot has the last edits. sql.ErrNoRows: no such post.
func (store *SQLStore) ScheduleUpdateTx(ctx context.Context, arg ScheduleUpdateTxParams) (PostScheduledUpdateRow, error) {
	var result PostScheduledUpdateRow
	err := store.execTx(ctx, func(q *Queries) error {
		status, err := q.LockPostStatusForUpdate(ctx, arg.PostID)
		if err != nil {
			return err
		}
		if status != "published" {
			return ErrPostNotPublished
		}
		changed, err := q.GetPostHasUnpublishedChanges(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("unpublished changes: %w", err)
		}
		if !changed {
			return ErrNoUnpublishedChanges
		}
		row, err := q.UpsertScheduledUpdateFromPost(ctx, UpsertScheduledUpdateFromPostParams{
			UpdateAt:    arg.UpdateAt,
			ScheduledBy: arg.ScheduledBy,
			PostID:      arg.PostID,
		})
		if err != nil {
			return fmt.Errorf("store scheduled update: %w", err)
		}
		result = PostScheduledUpdateRow(row)
		return nil
	})
	return result, err
}

type PublishScheduledUpdateTxParams struct {
	PostID int64
	// Claim is the claim's fencing token, ClaimDueScheduledUpdates'
	// next_attempt_at.
	Claim time.Time
	// ContentMedia as in PublishPostTxParams.
	ContentMedia func(blockDoc json.RawMessage) []ContentMediaUse
}

// PublishScheduledUpdateTx applies a scheduled update the scheduler claimed
// (#335): lock the post, then the pending update under this claim, write its
// frozen snapshot as the next version (credited to whoever scheduled it) and
// publish it as Update does. The working copy isn't read: edits made after
// scheduling aren't included, and no collab flush is needed. The check under the
// locks makes it happen once (ErrScheduleChanged otherwise, nothing written);
// publishInsertedVersion's new published version then deletes the pending row.
func (store *SQLStore) PublishScheduledUpdateTx(ctx context.Context, arg PublishScheduledUpdateTxParams) (PublishPostTxResult, error) {
	var result PublishPostTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		// Post first, then the update: the order every writer of both takes
		// (an Update by hand locks the post, then its trigger deletes the update).
		if _, err := q.LockPostForPublish(ctx, arg.PostID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrScheduleChanged
			}
			return fmt.Errorf("lock post: %w", err)
		}
		if _, err := q.LockScheduledUpdateClaim(ctx, LockScheduledUpdateClaimParams{PostID: arg.PostID, Claim: arg.Claim}); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrScheduleChanged
			}
			return fmt.Errorf("lock scheduled update: %w", err)
		}
		next, err := q.GetNextVersionNoForPost(ctx, arg.PostID)
		if err != nil {
			return fmt.Errorf("next version number: %w", err)
		}
		version, err := q.InsertPublishedVersionFromScheduledUpdate(ctx, InsertPublishedVersionFromScheduledUpdateParams{
			VersionNo: next,
			PostID:    arg.PostID,
		})
		if err != nil {
			return fmt.Errorf("insert version: %w", err)
		}
		result, err = publishInsertedVersion(ctx, q, arg.PostID, PublishPostTxResult{
			VersionID: version.ID, VersionNo: version.VersionNo, BlockDoc: version.BlockDoc,
		}, arg.ContentMedia)
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
