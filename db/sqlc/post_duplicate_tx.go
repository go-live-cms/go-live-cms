package db

import "context"

type DuplicatePostTxParams struct {
	// SourceID is the post being copied. Its terms and featured image are read
	// inside the transaction.
	SourceID int64
	// CreatePostsParams is the copy's row, already built by the caller: owner,
	// title, slug, url, status and the block_doc with regenerated block ids.
	// UserID is also the copy's only byline (user_posts).
	CreatePostsParams
	// ContentMediaIDs are the copy's block_doc image media ids in document
	// order; its content links (post_media order > 0) are synced to them.
	ContentMediaIDs []int64
}

// DuplicatePostTx creates a copy of a post in one transaction (#354): the new
// row, the caller's byline, the source's taxonomy terms and featured image,
// and the content media links of the copy's block_doc. Nothing else is
// copied: no versions, no Yjs state (post_ydoc_state; the collab server seeds
// the copy from its block_doc on first open), no other meta.
func (store *SQLStore) DuplicatePostTx(ctx context.Context, arg DuplicatePostTxParams) (Post, error) {
	var post Post
	err := store.execTx(ctx, func(q *Queries) error {
		var err error
		post, err = q.CreatePosts(ctx, arg.CreatePostsParams)
		if err != nil {
			return err
		}
		if _, err := q.CreateUserPost(ctx, CreateUserPostParams{PostID: post.ID, UserID: arg.UserID, Order: 0}); err != nil {
			return err
		}
		copyArgs := CopyPostTaxonomyTermsParams{NewPostID: post.ID, SourcePostID: arg.SourceID}
		if err := q.CopyPostTaxonomyTerms(ctx, copyArgs); err != nil {
			return err
		}
		if err := q.CopyPostFeaturedImage(ctx, CopyPostFeaturedImageParams(copyArgs)); err != nil {
			return err
		}
		if err := q.CopyPostFeaturedImageMeta(ctx, CopyPostFeaturedImageMetaParams(copyArgs)); err != nil {
			return err
		}
		return q.SyncPostContentMedia(ctx, SyncPostContentMediaParams{PostID: post.ID, MediaIds: arg.ContentMediaIDs})
	})
	return post, err
}
