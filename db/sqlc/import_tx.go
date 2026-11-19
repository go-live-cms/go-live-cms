package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// The importer (#150, 000065): one imported post in one transaction.

// Import item statuses (import_items.status) and job statuses (import_jobs.status).
const (
	ImportItemPending  = "pending"
	ImportItemImported = "imported"
	ImportItemSkipped  = "skipped"
	ImportItemFailed   = "failed"

	ImportJobMapping   = "mapping"
	ImportJobQueued    = "queued"
	ImportJobRunning   = "running"
	ImportJobDone      = "done"
	ImportJobFailed    = "failed"
	ImportJobCancelled = "cancelled"

	RedirectSourceImport = "import"
)

var (
	// ErrImportLeaseLost: the job was stopped, or another replica took it over (its lease
	// ran out). Nothing was written.
	ErrImportLeaseLost = errors.New("import job claim lost")
)

// ErrImportedBefore: an earlier import already made a post from this item's key (the
// WordPress GUID), and the post is still there. Nothing was written.
type ErrImportedBefore struct{ PostID int64 }

func (e ErrImportedBefore) Error() string {
	return "imported before as post " + strconv.FormatInt(e.PostID, 10)
}

// ImportPostTxParams is one item's post, built by the API.
type ImportPostTxParams struct {
	JobID      int64
	LeaseToken int64
	ItemID     int64
	SourceKey  string

	// CreatePostsParams is the row, created as a draft; UserID is the owner. Its BlockDoc
	// is already checked by the API (prepareForStore) and has no Yjs state: the collab
	// server seeds the live doc from it on first open.
	CreatePostsParams
	// AuthorIDs is the byline (the owner first).
	AuthorIDs []int64
	// TermIDs are the post's terms (at most one category, #331).
	TermIDs []int64
	// FeaturedMediaID (0 = none) and its public path for the _thumbnail_url meta.
	FeaturedMediaID   int64
	FeaturedMediaPath string
	// ContentMedia are the body's media blocks (post_media, "Used in").
	ContentMedia []ContentMediaUse
	// Snippets are the custom HTML blocks' markup by snippet id (#428), already sanitized.
	Snippets map[string]string

	CreatedAt time.Time
	ChangedAt time.Time
	// Publish: the post was published in the export. It is published like the Publish
	// button does (a version, the published settings), by PublishedBy.
	Publish        bool
	PublishedBy    sql.NullInt64
	PublishedMedia func(blockDoc json.RawMessage) []ContentMediaUse
	// Redirects are the old URLs' redirects to the new post (none = nil).
	Redirects func(post Post) []AddRedirectParams
	// Result is the item's report (import_items.result).
	Result func(post Post, redirects []Redirect) json.RawMessage
}

// ImportPostTxResult is the post written and the redirects added.
type ImportPostTxResult struct {
	Post      Post
	Redirects []Redirect
}

// ImportPostTx writes one imported post, and marks its item imported, in one transaction
// fenced by the job's claim (ErrImportLeaseLost) and by the item's key (ErrImportedBefore):
// a crash anywhere leaves either the whole post and its mark, or neither, so a resumed job
// redoes the item and a repeated one skips it.
func (store *SQLStore) ImportPostTx(ctx context.Context, arg ImportPostTxParams) (ImportPostTxResult, error) {
	var result ImportPostTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		if err := q.LockImportSourceKey(ctx, arg.SourceKey); err != nil {
			return err
		}
		if before, err := q.GetImportedPostBySourceKey(ctx, arg.SourceKey); err == nil {
			return ErrImportedBefore{PostID: before.PostID}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if n, err := q.RenewImportJobLease(ctx, RenewImportJobLeaseParams{ID: arg.JobID, LeaseToken: arg.LeaseToken}); err != nil {
			return err
		} else if n == 0 {
			return ErrImportLeaseLost
		}

		row := arg.CreatePostsParams
		row.PostStatus = "draft"
		post, err := q.CreatePosts(ctx, row)
		if err != nil {
			return err
		}
		for id, html := range arg.Snippets {
			if _, err := q.CreatePostHTMLSnippet(ctx, CreatePostHTMLSnippetParams{PostID: post.ID, SnippetID: id, Html: html}); err != nil {
				return fmt.Errorf("html snippet: %w", err)
			}
		}
		authors := arg.AuthorIDs
		if len(authors) == 0 {
			authors = []int64{row.UserID}
		}
		for i, authorID := range authors {
			if _, err := q.CreateUserPost(ctx, CreateUserPostParams{PostID: post.ID, UserID: authorID, Order: int32(i)}); err != nil {
				return fmt.Errorf("byline: %w", err)
			}
		}
		for _, termID := range arg.TermIDs {
			if err := q.LinkPostTerm(ctx, LinkPostTermParams{PostID: post.ID, TaxonomyTermID: termID}); err != nil {
				return fmt.Errorf("term: %w", err)
			}
		}
		if _, err := q.EnsureDefaultCategory(ctx, []int64{post.ID}); err != nil {
			return err
		}
		if arg.FeaturedMediaID > 0 {
			if _, err := q.CreatePostMedia(ctx, CreatePostMediaParams{PostID: post.ID, MediaID: arg.FeaturedMediaID, Order: 0}); err != nil {
				return fmt.Errorf("featured image: %w", err)
			}
			for key, value := range map[string]string{"_thumbnail_id": strconv.FormatInt(arg.FeaturedMediaID, 10), "_thumbnail_url": arg.FeaturedMediaPath} {
				if _, err := q.UpsertPostMeta(ctx, UpsertPostMetaParams{PostID: post.ID, MetaKey: key, MetaValue: sql.NullString{String: value, Valid: true}}); err != nil {
					return fmt.Errorf("featured image meta: %w", err)
				}
			}
		}
		if err := syncContentMedia(ctx, q, post.ID, arg.ContentMedia); err != nil {
			return err
		}
		firstPublished := sql.NullTime{}
		if arg.Publish {
			firstPublished = sql.NullTime{Time: arg.CreatedAt, Valid: true}
		}
		if err := q.SetImportedPostDates(ctx, SetImportedPostDatesParams{
			ID: post.ID, CreatedAt: arg.CreatedAt, ChangedAt: arg.ChangedAt, FirstPublishedAt: firstPublished,
		}); err != nil {
			return err
		}
		if arg.Publish {
			if _, err := q.LockPostForPublish(ctx, post.ID); err != nil {
				return err
			}
			if _, err := publishLockedPost(ctx, q, PublishPostTxParams{
				PostID: post.ID, CreatedBy: arg.PublishedBy, ContentMedia: arg.PublishedMedia,
			}); err != nil {
				return fmt.Errorf("publish: %w", err)
			}
		}
		if post, err = q.GetPost(ctx, post.ID); err != nil {
			return err
		}
		if arg.Redirects != nil {
			for _, redirect := range arg.Redirects(post) {
				added, err := addRedirect(ctx, q, redirect)
				switch {
				case err == nil:
					result.Redirects = append(result.Redirects, added)
				case errors.Is(err, ErrRedirectLoop):
					// The old URL is the new one after all: nothing to add.
				default:
					return fmt.Errorf("redirect: %w", err)
				}
			}
		}
		report := json.RawMessage(`{}`)
		if arg.Result != nil {
			report = arg.Result(post, result.Redirects)
		}
		n, err := q.FinishImportItem(ctx, FinishImportItemParams{
			ID: arg.ItemID, Status: ImportItemImported, Reason: "", Result: report,
			PostID: sql.NullInt64{Int64: post.ID, Valid: true}, LeaseToken: arg.LeaseToken,
		})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrImportLeaseLost
		}
		result.Post = post
		return nil
	})
	return result, err
}
