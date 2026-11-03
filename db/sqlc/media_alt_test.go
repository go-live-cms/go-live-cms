package db

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Missing alt text (#325): ListMedia's missing_alt filter, CountMedia and
// CountMissingAltMedia share one rule. Missing = an image (any image/* type,
// SVG included), not decorative, whose alt is empty or only whitespace.

func createAltTestMedia(t *testing.T, user User, mime, alt string, decorative bool) Medium {
	t.Helper()
	ext := map[string]string{"image/png": "png", "image/svg+xml": "svg", "application/pdf": "pdf"}[mime]
	media, err := testQueries.CreateMedia(context.Background(), CreateMediaParams{
		Name:             fmt.Sprintf("alt-%d", time.Now().UnixNano()),
		Description:      "alt text test",
		Alt:              alt,
		MediaPath:        fmt.Sprintf("/uploads/media/alt-%d.%s", time.Now().UnixNano(), ext),
		UserID:           user.ID,
		MimeType:         mime,
		OriginalFilename: "alt." + ext,
		Decorative:       decorative,
	})
	require.NoError(t, err)
	require.Equal(t, decorative, media.Decorative)
	return media
}

func linkAltTestMedia(t *testing.T, post Post, media Medium, order int32) {
	t.Helper()
	_, err := testQueries.CreatePostMedia(context.Background(), CreatePostMediaParams{PostID: post.ID, MediaID: media.ID, Order: order})
	require.NoError(t, err)
}

func TestMissingAltMedia(t *testing.T) {
	ctx := context.Background()
	before, err := testQueries.CountMissingAltMedia(ctx)
	require.NoError(t, err)

	user := createTestUser(t)
	noAlt := createAltTestMedia(t, user, "image/png", "", false)
	whitespaceAlt := createAltTestMedia(t, user, "image/png", " \t\n ", false)
	vectorNoAlt := createAltTestMedia(t, user, "image/svg+xml", "", false)
	withAlt := createAltTestMedia(t, user, "image/png", "A red roof on a green hill", false)
	decorative := createAltTestMedia(t, user, "image/png", "", true)
	pdf := createAltTestMedia(t, user, "application/pdf", "", false)

	published := createRelatedTestPost(t, user, "post", "published", time.Now())
	linkAltTestMedia(t, published, noAlt, 0)         // featured image
	linkAltTestMedia(t, published, whitespaceAlt, 1) // image block, same post
	draft := createRelatedTestPost(t, user, "post", "draft", time.Now())
	linkAltTestMedia(t, draft, vectorNoAlt, 1) // used only in a draft
	linkAltTestMedia(t, draft, noAlt, 1)
	otherPublished := createRelatedTestPost(t, user, "post", "published", time.Now())
	linkAltTestMedia(t, otherPublished, withAlt, 0)    // has alt text: not counted
	linkAltTestMedia(t, otherPublished, decorative, 1) // decorative: not counted
	linkAltTestMedia(t, otherPublished, pdf, 2)        // not an image: not counted

	t.Run("ListFilter", func(t *testing.T) {
		rows, err := testQueries.ListMedia(ctx, ListMediaParams{
			Column1: "", Column2: user.ID, Column3: "", Column4: "date_asc",
			Limit: 50, Offset: 0, Column7: true,
		})
		require.NoError(t, err)
		got := map[int64]ListMediaRow{}
		for _, row := range rows {
			got[row.ID] = row
		}
		require.Len(t, got, 3)
		require.Contains(t, got, noAlt.ID)
		require.Contains(t, got, whitespaceAlt.ID)
		require.Contains(t, got, vectorNoAlt.ID)

		// Used in a published post and a draft: only the published one counts.
		require.Equal(t, int64(2), got[noAlt.ID].PostCount)
		require.Equal(t, int64(1), got[noAlt.ID].PublishedPostCount)
		require.Equal(t, int64(1), got[whitespaceAlt.ID].PublishedPostCount)
		// Draft-only use is no published use.
		require.Equal(t, int64(1), got[vectorNoAlt.ID].PostCount)
		require.Equal(t, int64(0), got[vectorNoAlt.ID].PublishedPostCount)

		total, err := testQueries.CountMedia(ctx, CountMediaParams{UserID: user.ID, MissingAlt: true})
		require.NoError(t, err)
		require.Equal(t, int64(3), total, "the total follows the filter")
	})

	t.Run("ListUnfiltered", func(t *testing.T) {
		rows, err := testQueries.ListMedia(ctx, ListMediaParams{
			Column1: "", Column2: user.ID, Column3: "", Column4: "date_asc", Limit: 50,
		})
		require.NoError(t, err)
		require.Len(t, rows, 6)
		for _, row := range rows {
			if row.ID == withAlt.ID {
				require.Equal(t, int64(1), row.PublishedPostCount)
			}
		}

		total, err := testQueries.CountMedia(ctx, CountMediaParams{UserID: user.ID})
		require.NoError(t, err)
		require.Equal(t, int64(6), total)
		images, err := testQueries.CountMedia(ctx, CountMediaParams{UserID: user.ID, MimePrefix: "image/"})
		require.NoError(t, err)
		require.Equal(t, int64(5), images)
	})

	t.Run("Summary", func(t *testing.T) {
		after, err := testQueries.CountMissingAltMedia(ctx)
		require.NoError(t, err)
		require.Equal(t, before.MediaCount+3, after.MediaCount)
		// published (two missing images, one post); the draft and
		// otherPublished (nothing missing) don't count.
		require.Equal(t, before.PublishedPostCount+1, after.PublishedPostCount)
	})

	t.Run("FixingAltAndDecorative", func(t *testing.T) {
		_, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{
			ID:  noAlt.ID,
			Alt: sql.NullString{String: "A house with a red roof", Valid: true},
		})
		require.NoError(t, err)
		marked, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{
			ID:         whitespaceAlt.ID,
			Decorative: sql.NullBool{Bool: true, Valid: true},
		})
		require.NoError(t, err)
		require.True(t, marked.Decorative)
		require.Equal(t, " \t\n ", marked.Alt, "decorative keeps the stored alt")

		after, err := testQueries.CountMissingAltMedia(ctx)
		require.NoError(t, err)
		require.Equal(t, before.MediaCount+1, after.MediaCount, "only the draft's vector is left")
		require.Equal(t, before.PublishedPostCount, after.PublishedPostCount)

		// NULL keeps decorative; '' clears alt, which brings the image back.
		cleared, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{
			ID:  noAlt.ID,
			Alt: sql.NullString{String: "", Valid: true},
		})
		require.NoError(t, err)
		require.Equal(t, "", cleared.Alt)
		require.False(t, cleared.Decorative)
		kept, err := testQueries.UpdateMediaMetadata(ctx, UpdateMediaMetadataParams{ID: whitespaceAlt.ID})
		require.NoError(t, err)
		require.True(t, kept.Decorative)

		total, err := testQueries.CountMedia(ctx, CountMediaParams{UserID: user.ID, MissingAlt: true})
		require.NoError(t, err)
		require.Equal(t, int64(2), total)
	})
}
