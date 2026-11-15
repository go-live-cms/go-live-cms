package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// A video's captions (#507, 000059): media.captions_media_id is another media row (the
// WebVTT file). Deleting the captions file clears it; deleting the video leaves the file.

func setCaptions(t *testing.T, videoID, captionsID int64, lang string) Medium {
	t.Helper()
	updated, err := testQueries.UpdateMediaMetadata(context.Background(), UpdateMediaMetadataParams{
		ID:              videoID,
		SetCaptions:     true,
		CaptionsMediaID: sql.NullInt64{Int64: captionsID, Valid: true},
		CaptionsLang:    sql.NullString{String: lang, Valid: true},
	})
	require.NoError(t, err)
	return updated
}

func TestMediaCaptionsSetKeepAndClear(t *testing.T) {
	ctx := context.Background()
	user, video := createTestMedia(t)
	captions := createTestMediaFor(t, user)
	require.False(t, video.CaptionsMediaID.Valid)
	require.Equal(t, "", video.CaptionsLang)

	updated := setCaptions(t, video.ID, captions.ID, "pt-BR")
	require.Equal(t, sql.NullInt64{Int64: captions.ID, Valid: true}, updated.CaptionsMediaID)
	require.Equal(t, "pt-BR", updated.CaptionsLang)

	// Another edit (the alt text) keeps them.
	kept, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{ID: video.ID, Alt: sql.NullString{String: "x", Valid: true}})
	require.NoError(t, err)
	require.Equal(t, updated.CaptionsMediaID, kept.CaptionsMediaID)
	require.Equal(t, "pt-BR", kept.CaptionsLang)

	// The language alone.
	lang, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{ID: video.ID, CaptionsLang: sql.NullString{String: "en", Valid: true}})
	require.NoError(t, err)
	require.Equal(t, updated.CaptionsMediaID, lang.CaptionsMediaID)
	require.Equal(t, "en", lang.CaptionsLang)

	cleared, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{ID: video.ID, SetCaptions: true, CaptionsLang: sql.NullString{String: "", Valid: true}})
	require.NoError(t, err)
	require.False(t, cleared.CaptionsMediaID.Valid)
	require.Equal(t, "", cleared.CaptionsLang)
}

func TestMediaCaptionsConstraints(t *testing.T) {
	ctx := context.Background()
	_, video := createTestMedia(t)

	// Not its own captions.
	_, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{
		ID: video.ID, SetCaptions: true, CaptionsMediaID: sql.NullInt64{Int64: video.ID, Valid: true},
	})
	require.Error(t, err)

	// A media row that doesn't exist (FK).
	_, err = testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{
		ID: video.ID, SetCaptions: true, CaptionsMediaID: sql.NullInt64{Int64: 1 << 50, Valid: true},
	})
	require.Error(t, err)
}

func TestMediaCaptionsOnDelete(t *testing.T) {
	ctx := context.Background()
	user, video := createTestMedia(t)
	captions := createTestMediaFor(t, user)
	setCaptions(t, video.ID, captions.ID, "en-US")

	// Deleting the captions file clears captions_media_id (ON DELETE SET NULL).
	require.NoError(t, testQueries.DeleteMedia(ctx, captions.ID))
	got, err := testQueries.GetMedia(ctx, video.ID)
	require.NoError(t, err)
	require.False(t, got.CaptionsMediaID.Valid)

	// Deleting the video leaves its captions file in the library.
	other := createTestMediaFor(t, user)
	setCaptions(t, video.ID, other.ID, "en-US")
	require.NoError(t, testQueries.DeleteMedia(ctx, video.ID))
	_, err = testQueries.GetMedia(ctx, other.ID)
	require.NoError(t, err)
}

func TestGetPostsByCaptionsMedia(t *testing.T) {
	ctx := context.Background()
	user, video := createTestMedia(t)
	captions := createTestMediaFor(t, user)
	setCaptions(t, video.ID, captions.ID, "en-US")
	post := createBylinePost(t, user)

	_, err := testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: post.ID, MediaID: video.ID, Order: 1})
	require.NoError(t, err)
	_, err = testStore.(*SQLStore).db.ExecContext(ctx,
		`UPDATE post_media SET blocks = $3 WHERE post_id = $1 AND media_id = $2`,
		post.ID, video.ID, `[{"id":"video-0001","type":"video"}]`)
	require.NoError(t, err)

	rows, err := testQueries.GetPostsByCaptionsMedia(ctx, captions.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, post.ID, rows[0].ID)
	require.Equal(t, video.ID, rows[0].VideoID)
	var blocks []map[string]string
	require.NoError(t, json.Unmarshal(rows[0].Blocks, &blocks))
	require.Equal(t, []map[string]string{{"id": "video-0001", "type": "video"}}, blocks)

	// Nothing for a file that captions nothing.
	none, err := testQueries.GetPostsByCaptionsMedia(ctx, video.ID)
	require.NoError(t, err)
	require.Empty(t, none)
}
