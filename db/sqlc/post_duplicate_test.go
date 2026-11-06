package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// DuplicatePostTx (#354): the copy gets its own row, the caller's byline, the
// source's terms and featured image and the content links of its own
// block_doc; never the source's versions, Yjs state, other meta or bylines.
func TestDuplicatePostTx(t *testing.T) {
	ctx := context.Background()
	owner := createTestUser(t)
	coAuthor := createTestUser(t)
	caller := createTestUser(t)
	ts := time.Now().UnixNano()

	source, err := testStore.CreatePostTx(ctx, CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       "Source",
			Description: "The source post",
			UserID:      owner.ID,
			Username:    owner.Username,
			Url:         fmt.Sprintf("https://example.com/post/dup-source-%d", ts),
			PostType:    "post",
			PostStatus:  "published",
			Slug:        fmt.Sprintf("dup-source-%d", ts),
			BlockDoc:    json.RawMessage(`{"doc_version":1,"blocks_order":["blk-source-0001"],"blocks":{"blk-source-0001":{"id":"blk-source-0001","type":"paragraph","version":1,"attrs":{"text":"hi"}}}}`),
		},
		AuthorIDs: []int64{owner.ID, coAuthor.ID},
	})
	require.NoError(t, err)
	src := source.Post

	// Terms, a featured image (+ its meta), a content image, other meta.
	taxType := createTestTaxonomyType(t, fmt.Sprintf("dup_tags_%d", ts), "Tags", false)
	term1 := createTestTaxonomyTerm(t, taxType.ID)
	term2 := createTestTaxonomyTerm(t, taxType.ID)
	for _, term := range []TaxonomyTerm{term1, term2} {
		_, err := testQueries.AddPostToTaxonomyTerm(ctx, AddPostToTaxonomyTermParams{PostID: src.ID, TaxonomyTermID: term.ID})
		require.NoError(t, err)
	}
	_, featured := createTestMedia(t)
	_, sourceContent := createTestMedia(t)
	_, copyContent := createTestMedia(t)
	_, err = testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: src.ID, MediaID: featured.ID, Order: 0})
	require.NoError(t, err)
	_, err = testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: src.ID, MediaID: sourceContent.ID, Order: 1})
	require.NoError(t, err)
	for key, value := range map[string]string{
		"_thumbnail_id":  strconv.FormatInt(featured.ID, 10),
		"_thumbnail_url": "/uploads/media/featured.jpg",
		"seo_title":      "Not copied",
	} {
		_, err := testQueries.UpsertPostMeta(ctx, UpsertPostMetaParams{PostID: src.ID, MetaKey: key, MetaValue: sql.NullString{String: value, Valid: true}})
		require.NoError(t, err)
	}

	// A published version and a Yjs state.
	version, err := testQueries.InsertPostVersion(ctx, InsertPostVersionParams{PostID: src.ID, VersionNo: 1, BlockDoc: src.BlockDoc, CreatedBy: sql.NullInt64{Int64: owner.ID, Valid: true}})
	require.NoError(t, err)
	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID:                 src.ID,
		PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: src.BlockDoc, Valid: true},
	}))
	require.NoError(t, testQueries.UpsertPostYdocState(ctx, UpsertPostYdocStateParams{PostID: src.ID, State: []byte{1, 2, 3}, Epoch: uuid.New(), BlockRevision: src.BlockRevision}))

	copyDoc := json.RawMessage(`{"doc_version":1,"blocks_order":["blk-copy-00001"],"blocks":{"blk-copy-00001":{"id":"blk-copy-00001","type":"image","version":2,"attrs":{"mediaId":1}}}}`)
	dup, err := testStore.DuplicatePostTx(ctx, DuplicatePostTxParams{
		SourceID: src.ID,
		CreatePostsParams: CreatePostsParams{
			Title:       "Source (copy)",
			Description: src.Description,
			UserID:      caller.ID,
			Username:    caller.Username,
			Url:         fmt.Sprintf("https://example.com/post/dup-source-%d-copy", ts),
			PostType:    src.PostType,
			PostStatus:  "draft",
			Slug:        fmt.Sprintf("dup-source-%d-copy", ts),
			BlockDoc:    copyDoc,
		},
		// An id without a media row is skipped, like the collab store's sync.
		ContentMedia: []ContentMediaUse{{MediaID: copyContent.ID, BlockID: "blk-copy-00001", BlockType: "image"}, {MediaID: -1, BlockID: "blk-gone", BlockType: "image"}},
	})
	require.NoError(t, err)

	require.NotEqual(t, src.ID, dup.ID)
	require.Equal(t, "draft", dup.PostStatus)
	require.Equal(t, caller.ID, dup.UserID)
	require.JSONEq(t, string(copyDoc), string(dup.BlockDoc))
	require.False(t, dup.PublishedVersionID.Valid, "no publish date or published version")
	require.False(t, dup.PublishedBlockDoc.Valid)

	// Byline: the caller only.
	var bylines []int64
	rows, err := testQueries.db.QueryContext(ctx, `SELECT user_id FROM user_posts WHERE post_id = $1 ORDER BY "order"`, dup.ID)
	require.NoError(t, err)
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		bylines = append(bylines, id)
	}
	require.NoError(t, rows.Close())
	require.Equal(t, []int64{caller.ID}, bylines)

	terms, err := testQueries.GetPostTaxonomyTerms(ctx, dup.ID)
	require.NoError(t, err)
	termIDs := []int64{}
	for _, term := range terms {
		termIDs = append(termIDs, term.ID)
	}
	// The source (a post) also had the default category (#331), which the copy keeps.
	termIDs = withoutDefaultCategory(t, termIDs)
	require.ElementsMatch(t, []int64{term1.ID, term2.ID}, termIDs)

	// The featured image and the copy's own content image, not the source's.
	media, err := testQueries.GetMediaByPostWithOrder(ctx, dup.ID)
	require.NoError(t, err)
	links := map[int64]int32{}
	for _, m := range media {
		links[m.ID] = m.MediaOrder
	}
	require.Equal(t, map[int64]int32{featured.ID: 0, copyContent.ID: 1}, links)

	meta, err := testQueries.GetPostMeta(ctx, dup.ID)
	require.NoError(t, err)
	metaValues := map[string]string{}
	for _, m := range meta {
		metaValues[m.MetaKey] = m.MetaValue.String
	}
	require.Equal(t, map[string]string{"_thumbnail_id": strconv.FormatInt(featured.ID, 10), "_thumbnail_url": "/uploads/media/featured.jpg"}, metaValues)

	// The post row LEFT JOIN its versions: one row, without a version.
	versions, err := testQueries.GetPostVersions(ctx, dup.ID)
	require.NoError(t, err)
	for _, v := range versions {
		require.False(t, v.VersionID.Valid, "a version was copied")
	}

	// No Yjs state: the collab server's load seeds the copy from block_doc.
	collab, err := testQueries.GetPostCollab(ctx, dup.ID)
	require.NoError(t, err)
	require.Nil(t, collab.YdocState)
	require.False(t, collab.YdocBlockRevision.Valid)
	require.JSONEq(t, string(copyDoc), string(collab.BlockDoc))

	// The source is untouched.
	after, err := testQueries.GetPost(ctx, src.ID)
	require.NoError(t, err)
	require.Equal(t, "published", after.PostStatus)
	require.JSONEq(t, string(src.BlockDoc), string(after.BlockDoc))
	srcCollab, err := testQueries.GetPostCollab(ctx, src.ID)
	require.NoError(t, err)
	require.Equal(t, []byte{1, 2, 3}, srcCollab.YdocState)
}

// A failure after the insert rolls the whole copy back: posts.user_id has no
// foreign key, user_posts.user_id has, so an unknown owner fails the byline.
func TestDuplicatePostTxRollsBack(t *testing.T) {
	ctx := context.Background()
	existing := createPostWithTransaction(t).Post
	slug := fmt.Sprintf("dup-rollback-%d", time.Now().UnixNano())

	_, err := testStore.DuplicatePostTx(ctx, DuplicatePostTxParams{
		SourceID: existing.ID,
		CreatePostsParams: CreatePostsParams{
			Title:       "Rollback (copy)",
			Description: existing.Description,
			UserID:      -1,
			Username:    "nobody",
			Url:         "https://example.com/post/" + slug,
			PostType:    "post",
			PostStatus:  "draft",
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
		},
	})
	require.Error(t, err)

	_, err = testQueries.GetPostBySlug(ctx, slug)
	require.ErrorIs(t, err, sql.ErrNoRows)
}
