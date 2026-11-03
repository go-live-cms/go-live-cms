package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// How a post uses each media (#176): post_media.blocks lists the content
// blocks showing it, next to the featured image's order 0.

type usageBlock struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// mediaBlocks returns the post's links as media id -> blocks.
func mediaBlocks(t *testing.T, q DBTX, postID int64) map[int64][]usageBlock {
	t.Helper()
	rows, err := q.QueryContext(context.Background(), `SELECT media_id, blocks FROM post_media WHERE post_id = $1`, postID)
	require.NoError(t, err)
	defer rows.Close()
	links := map[int64][]usageBlock{}
	for rows.Next() {
		var mediaID int64
		var raw json.RawMessage
		require.NoError(t, rows.Scan(&mediaID, &raw))
		blocks := []usageBlock{}
		require.NoError(t, json.Unmarshal(raw, &blocks))
		links[mediaID] = blocks
	}
	require.NoError(t, rows.Err())
	return links
}

func imageBlock(id string) usageBlock { return usageBlock{ID: id, Type: "image"} }

// docWithBlocks is a Block Spec v1 doc of image blocks, block id -> media id,
// in the given order.
func docWithBlocks(blocks ...ContentMediaUse) json.RawMessage {
	order := []string{}
	byID := map[string]any{}
	for _, b := range blocks {
		order = append(order, b.BlockID)
		byID[b.BlockID] = map[string]any{"type": "image", "attrs": map[string]any{"mediaId": b.MediaID}}
	}
	doc, _ := json.Marshal(map[string]any{"doc_version": 1, "blocks_order": order, "blocks": byID})
	return doc
}

func storeContent(t *testing.T, postID int64, uses ...ContentMediaUse) {
	t.Helper()
	_, err := testStore.StorePostCollabTx(context.Background(), StorePostCollabTxParams{
		PostID:       postID,
		State:        []byte{1},
		Epoch:        uuid.New(),
		BlockDoc:     docWithBlocks(uses...),
		ContentMedia: uses,
	})
	require.NoError(t, err)
}

// The collab store records each block showing a media, the featured image's
// too, and a block removed from the doc removes its use.
func TestSyncPostContentMediaRecordsBlocks(t *testing.T) {
	f := createSettingsFixture(t) // a draft with f.media as its featured image
	featured := f.media
	_, inline := createTestMedia(t)

	use := func(m Medium, block string) ContentMediaUse {
		return ContentMediaUse{MediaID: m.ID, BlockID: block, BlockType: "image"}
	}
	storeContent(t, f.post.ID, use(inline, "a1"), use(featured, "f1"), use(inline, "a2"))
	require.Equal(t, map[int64][]usageBlock{
		inline.ID:   {imageBlock("a1"), imageBlock("a2")},
		featured.ID: {imageBlock("f1")},
	}, mediaBlocks(t, testQueries.db, f.post.ID))
	require.Equal(t, map[int64]int32{featured.ID: 0, inline.ID: 1}, contentMediaOrder(t, f.post.ID))

	// GET /media/:id/posts reads them.
	rows, err := testQueries.GetPostsByMedia(context.Background(), featured.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "featured", rows[0].RelationshipType)
	require.JSONEq(t, `[{"id":"f1","type":"image"}]`, string(rows[0].Blocks))

	// One block of the inline image removed, and the featured image's block.
	storeContent(t, f.post.ID, use(inline, "a2"))
	require.Equal(t, map[int64][]usageBlock{
		inline.ID:   {imageBlock("a2")},
		featured.ID: {}, // still the featured image, in no block
	}, mediaBlocks(t, testQueries.db, f.post.ID))
	require.Equal(t, map[int64]int32{featured.ID: 0, inline.ID: 1}, contentMediaOrder(t, f.post.ID))

	// Its last block removed: the inline image is no longer used.
	storeContent(t, f.post.ID)
	require.Equal(t, map[int64][]usageBlock{featured.ID: {}}, mediaBlocks(t, testQueries.db, f.post.ID))
	rows, err = testQueries.GetPostsByMedia(context.Background(), inline.ID)
	require.NoError(t, err)
	require.Empty(t, rows)
}

// Unsetting the featured image removes only that use: an image also in the
// body stays linked as a content image with its blocks.
func TestUnlinkPostFeaturedMediaKeepsBlockUse(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, inline := createTestMedia(t)
	storeContent(t, f.post.ID,
		ContentMediaUse{MediaID: inline.ID, BlockID: "a", BlockType: "image"},
		ContentMediaUse{MediaID: f.media.ID, BlockID: "f", BlockType: "image"},
	)

	require.NoError(t, testQueries.UnlinkPostFeaturedMedia(ctx, f.post.ID))
	_, err := testQueries.GetFeaturedImage(ctx, f.post.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)
	order := contentMediaOrder(t, f.post.ID)
	require.Equal(t, int32(1), order[inline.ID])
	require.Greater(t, order[f.media.ID], int32(1), "moved after the other content links")
	require.Equal(t, []usageBlock{imageBlock("f")}, mediaBlocks(t, testQueries.db, f.post.ID)[f.media.ID])

	rows, err := testQueries.GetPostsByMedia(ctx, f.media.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "gallery", rows[0].RelationshipType)

	// The next store puts it back at its document position.
	storeContent(t, f.post.ID,
		ContentMediaUse{MediaID: inline.ID, BlockID: "a", BlockType: "image"},
		ContentMediaUse{MediaID: f.media.ID, BlockID: "f", BlockType: "image"},
	)
	require.Equal(t, map[int64]int32{inline.ID: 1, f.media.ID: 2}, contentMediaOrder(t, f.post.ID))

	// Setting it featured again keeps its block; unsetting a featured image
	// that is in no block removes its link.
	setFeaturedImageMeta(t, f.post.ID, f.media)
	require.Equal(t, int32(0), contentMediaOrder(t, f.post.ID)[f.media.ID])
	require.Equal(t, []usageBlock{imageBlock("f")}, mediaBlocks(t, testQueries.db, f.post.ID)[f.media.ID])

	_, other := createTestMedia(t)
	setFeaturedImageMeta(t, f.post.ID, other)
	require.Equal(t, int32(0), contentMediaOrder(t, f.post.ID)[other.ID])
	require.NoError(t, testQueries.UnlinkPostFeaturedMedia(ctx, f.post.ID))
	require.NotContains(t, contentMediaOrder(t, f.post.ID), other.ID)
}

// Publish syncs the blocks from the published body, like the collab store.
func TestPublishPostTxRecordsBlocks(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, inline := createTestMedia(t)
	uses := []ContentMediaUse{{MediaID: inline.ID, BlockID: "p1", BlockType: "image"}}
	writeBlockDocAround(t, f.post.ID, docWithBlocks(uses...))
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{
		PostID:       f.post.ID,
		ContentMedia: func(json.RawMessage) []ContentMediaUse { return uses },
	})
	require.NoError(t, err)
	require.Equal(t, map[int64][]usageBlock{
		inline.ID:  {imageBlock("p1")},
		f.media.ID: {},
	}, mediaBlocks(t, testQueries.db, f.post.ID))
}

// The migration's backfill (000028), run inside a transaction that is rolled
// back so the shared test database is left alone: a draft's blocks come from
// its working copy, a published post's from its published body, and links no
// image block shows stay [].
func TestPostMediaBlocksBackfillMigration(t *testing.T) {
	ctx := context.Background()
	up, err := os.ReadFile("../migration/000028_post_media_blocks.up.sql")
	require.NoError(t, err)
	backfill := string(up)
	start := strings.Index(backfill, "-- Backfill from")
	require.GreaterOrEqual(t, start, 0)
	backfill = backfill[start:]

	_, featured := createTestMedia(t)
	_, inline := createTestMedia(t)
	_, attached := createTestMedia(t)

	draft := createSettingsFixture(t)
	setFeaturedImageMeta(t, draft.post.ID, featured)
	for mediaID, order := range map[int64]int32{inline.ID: 1, attached.ID: 2} {
		_, err := testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: draft.post.ID, MediaID: mediaID, Order: order})
		require.NoError(t, err)
	}
	// The featured image is in the body too, after the inline image's two
	// blocks; a paragraph, a non-numeric mediaId and a missing block are skipped.
	writeBlockDocAround(t, draft.post.ID, json.RawMessage(`{"doc_version":1,
		"blocks_order":["i1","p","f1","i2","bad","gone"],
		"blocks":{
			"i1":{"type":"image","attrs":{"mediaId":`+jsonInt(inline.ID)+`}},
			"p":{"type":"paragraph"},
			"f1":{"type":"image","attrs":{"mediaId":`+jsonInt(featured.ID)+`}},
			"i2":{"type":"image","attrs":{"mediaId":`+jsonInt(inline.ID)+`}},
			"bad":{"type":"image","attrs":{"mediaId":"`+jsonInt(attached.ID)+`"}}}}`))

	// A published post: its working copy moved on, its links follow the
	// published body.
	published := createSettingsFixture(t)
	_, err = testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: published.post.ID, MediaID: inline.ID, Order: 1})
	require.NoError(t, err)
	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID: published.post.ID,
		PublishedBlockDoc: pqtype.NullRawMessage{Valid: true, RawMessage: docWithBlocks(
			ContentMediaUse{MediaID: inline.ID, BlockID: "pub"},
		)},
	}))
	writeBlockDocAround(t, published.post.ID, docWithBlocks(ContentMediaUse{MediaID: inline.ID, BlockID: "working"}))
	_, err = testQueries.db.ExecContext(ctx, `UPDATE posts SET post_status = 'published' WHERE id = $1`, published.post.ID)
	require.NoError(t, err)

	// A post whose block_doc is the empty {}.
	empty := createSettingsFixture(t)
	writeBlockDocAround(t, empty.post.ID, json.RawMessage(`{}`))

	tx, err := testStore.(*SQLStore).db.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer tx.Rollback() //nolint:errcheck
	_, err = tx.ExecContext(ctx, `UPDATE post_media SET blocks = '[]' WHERE post_id IN ($1, $2, $3)`,
		draft.post.ID, published.post.ID, empty.post.ID)
	require.NoError(t, err)

	_, err = tx.ExecContext(ctx, backfill)
	require.NoError(t, err)

	require.Equal(t, map[int64][]usageBlock{
		featured.ID: {imageBlock("f1")},
		inline.ID:   {imageBlock("i1"), imageBlock("i2")},
		attached.ID: {},
	}, mediaBlocks(t, tx, draft.post.ID))
	require.Equal(t, map[int64][]usageBlock{
		published.media.ID: {},
		inline.ID:          {imageBlock("pub")},
	}, mediaBlocks(t, tx, published.post.ID))
	require.Equal(t, map[int64][]usageBlock{empty.media.ID: {}}, mediaBlocks(t, tx, empty.post.ID))
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
