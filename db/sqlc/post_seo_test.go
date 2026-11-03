package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// SEO settings (#357, 000031): typed columns that golive_post_settings snapshots,
// so they follow the publish rule of the other settings (#358).

type testSEOSettings struct {
	SEOTitle       string `json:"seo_title"`
	SEODescription string `json:"seo_description"`
	SocialImageID  *int64 `json:"social_image_id"`
	Noindex        bool   `json:"noindex"`
	CanonicalURL   string `json:"canonical_url"`
}

func decodeTestSEO(t *testing.T, raw []byte) testSEOSettings {
	t.Helper()
	var s testSEOSettings
	require.NoError(t, json.Unmarshal(raw, &s))
	return s
}

func setTestSEO(t *testing.T, postID int64, socialImage *Medium) Post {
	t.Helper()
	params := UpdatePostSEOParams{
		ID:             postID,
		SeoTitle:       "SEO title",
		SeoDescription: "SEO description",
		Noindex:        true,
		CanonicalUrl:   "https://example.com/original",
	}
	if socialImage != nil {
		params.SocialImageID = sql.NullInt64{Int64: socialImage.ID, Valid: true}
	}
	post, err := testQueries.UpdatePostSEO(context.Background(), params)
	require.NoError(t, err)
	return post
}

func TestPostSEOWaitsForUpdate(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, social := createTestMedia(t)

	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)

	post := setTestSEO(t, f.post.ID, &social)
	require.Equal(t, "SEO title", post.SeoTitle)
	require.Equal(t, social.ID, post.SocialImageID.Int64)
	require.True(t, post.Noindex)

	// The working copy changed; the published settings didn't.
	published := decodeTestSEO(t, post.PublishedSettings.RawMessage)
	require.Equal(t, testSEOSettings{}, published, "nothing public until Update")
	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.True(t, state.Changed, "an SEO edit is a pending settings change")
	working := decodeTestSEO(t, state.Working)
	require.Equal(t, "SEO title", working.SEOTitle)
	require.Equal(t, social.ID, *working.SocialImageID)

	// Update publishes them, into the version too.
	result, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)
	post, err = testQueries.GetPost(ctx, f.post.ID)
	require.NoError(t, err)
	want := testSEOSettings{
		SEOTitle: "SEO title", SEODescription: "SEO description", SocialImageID: &social.ID,
		Noindex: true, CanonicalURL: "https://example.com/original",
	}
	require.Equal(t, want, decodeTestSEO(t, post.PublishedSettings.RawMessage))
	version, err := testQueries.GetPostVersion(ctx, GetPostVersionParams{PostID: f.post.ID, VersionNo: result.VersionNo})
	require.NoError(t, err)
	require.Equal(t, want, decodeTestSEO(t, version.Settings.RawMessage))
	state, err = testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, state.Changed)
}

func TestRestorePostSettingsTxRestoresSEO(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, social := createTestMedia(t)

	setTestSEO(t, f.post.ID, &social)
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)
	// Cleared afterwards, then version 1 is restored.
	_, err = testQueries.UpdatePostSEO(ctx, UpdatePostSEOParams{ID: f.post.ID})
	require.NoError(t, err)

	post, err := testStore.RestorePostSettingsTx(ctx, RestorePostSettingsTxParams{PostID: f.post.ID, Settings: RestoredPostSettings{
		Title: "Original title", Description: "Original excerpt", ThumbnailURL: func(m Medium) string { return m.MediaPath },
		SEOTitle: "SEO title", SEODescription: "SEO description", SocialImageID: &social.ID,
		Noindex: true, CanonicalURL: "https://example.com/original",
	}})
	require.NoError(t, err)
	require.Equal(t, "SEO title", post.SeoTitle, "the returned row has the restored SEO")
	require.Equal(t, "SEO description", post.SeoDescription)
	require.Equal(t, social.ID, post.SocialImageID.Int64)
	require.True(t, post.Noindex)
	require.Equal(t, "https://example.com/original", post.CanonicalUrl)

	// A social image deleted since is left out, not an error.
	require.NoError(t, testQueries.DeleteMedia(ctx, social.ID))
	post, err = testStore.RestorePostSettingsTx(ctx, RestorePostSettingsTxParams{PostID: f.post.ID, Settings: RestoredPostSettings{
		Title: "Original title", ThumbnailURL: func(m Medium) string { return m.MediaPath }, SocialImageID: &social.ID,
	}})
	require.NoError(t, err)
	require.False(t, post.SocialImageID.Valid)
	require.Empty(t, post.SeoTitle)
}

func TestPostSettingsStateIgnoresDeletedSocialImage(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, social := createTestMedia(t)

	setTestSEO(t, f.post.ID, &social)
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)

	// Deleting the media clears the working column (ON DELETE SET NULL); the
	// published snapshot still names it, but that's no change waiting for Update.
	require.NoError(t, testQueries.DeleteMedia(ctx, social.ID))
	post, err := testQueries.GetPost(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, post.SocialImageID.Valid)
	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, state.Changed)
}

func TestListImageMediaAfterFindsMissingSocialCrop(t *testing.T) {
	ctx := context.Background()
	owner := createRandomUser(t)
	media, err := testQueries.CreateMedia(ctx, CreateMediaParams{
		Name: "wide", Description: "a wide image", MediaPath: "/uploads/media/wide-" + owner.Username + ".jpg",
		UserID: owner.ID, FileSize: 1000, MimeType: "image/jpeg", Width: 2000, Height: 1000, OriginalFilename: "wide.jpg",
	})
	require.NoError(t, err)
	_, err = testQueries.SetMediaVariants(ctx, SetMediaVariantsParams{
		ID: media.ID, Variants: json.RawMessage(`{"thumb": {"path": "t.jpg", "width": 320, "height": 160}}`),
	})
	require.NoError(t, err)

	found := func() bool {
		rows, err := testQueries.ListImageMediaAfter(ctx, ListImageMediaAfterParams{AfterID: media.ID - 1, OnlyMissing: true, MinLongEdge: 320, PageSize: 1})
		require.NoError(t, err)
		return len(rows) == 1 && rows[0].ID == media.ID
	}
	require.True(t, found(), "variants from before #357 have no social crop")

	_, err = testQueries.SetMediaVariants(ctx, SetMediaVariantsParams{
		ID: media.ID, Variants: json.RawMessage(`{"thumb": {"path": "t.jpg"}, "social": {"path": "s.jpg"}}`),
	})
	require.NoError(t, err)
	require.False(t, found())
}
