package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// Settings snapshots (#358): publish saves the title, excerpt, featured image and
// terms with the blocks, and the public site reads only the published ones.

type settingsFixture struct {
	post  Post
	media Medium
	terms []TaxonomyTerm
}

// createSettingsFixture is a draft with a title, an excerpt, a featured image
// (set the way POST /posts/:id/featured-image sets it) and two terms.
func createSettingsFixture(t *testing.T) settingsFixture {
	ctx := context.Background()
	owner := createRandomUser(t)
	slug := fmt.Sprintf("settings-%d", time.Now().UnixNano())
	post, err := testQueries.CreatePosts(ctx, CreatePostsParams{
		Title:       "Original title",
		Description: "Original excerpt",
		UserID:      owner.ID,
		Username:    owner.Username,
		Url:         "https://example.com/" + slug,
		PostType:    "post",
		PostStatus:  "draft",
		Slug:        slug,
		BlockDoc:    searchDoc("body"),
	})
	require.NoError(t, err)

	_, media := createTestMedia(t)
	setFeaturedImageMeta(t, post.ID, media)

	taxonomy := createTestTaxonomyType(t, fmt.Sprintf("settings_%d", time.Now().UnixNano()), "Settings", false)
	terms := []TaxonomyTerm{createTestTaxonomyTerm(t, taxonomy.ID), createTestTaxonomyTerm(t, taxonomy.ID)}
	linkTerms(t, post, terms...)
	return settingsFixture{post: post, media: media, terms: terms}
}

func setFeaturedImageMeta(t *testing.T, postID int64, media Medium) {
	ctx := context.Background()
	require.NoError(t, testQueries.DeletePostMediaByOrder(ctx, DeletePostMediaByOrderParams{PostID: postID, Order: 0}))
	_, err := testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: postID, MediaID: media.ID, Order: 0})
	require.NoError(t, err)
	_, err = testQueries.UpsertPostMeta(ctx, UpsertPostMetaParams{PostID: postID, MetaKey: "_thumbnail_id", MetaValue: sql.NullString{String: fmt.Sprint(media.ID), Valid: true}})
	require.NoError(t, err)
	_, err = testQueries.UpsertPostMeta(ctx, UpsertPostMetaParams{PostID: postID, MetaKey: "_thumbnail_url", MetaValue: sql.NullString{String: media.MediaPath, Valid: true}})
	require.NoError(t, err)
}

type testSettings struct {
	Title         string `json:"title"`
	Description   string `json:"description"`
	FeaturedImage *struct {
		ID  *int64 `json:"id"`
		URL string `json:"url"`
	} `json:"featured_image"`
	TermIDs []int64 `json:"term_ids"`
}

func decodeTestSettings(t *testing.T, raw []byte) testSettings {
	t.Helper()
	var s testSettings
	require.NoError(t, json.Unmarshal(raw, &s))
	return s
}

func termIDs(terms ...TaxonomyTerm) []int64 {
	ids := []int64{}
	for _, term := range terms {
		ids = append(ids, term.ID)
	}
	return ids
}

func publishedTermIDs(t *testing.T, postID int64) []int64 {
	rows, err := testQueries.GetPublishedPostTaxonomyTerms(context.Background(), postID)
	require.NoError(t, err)
	ids := []int64{}
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func TestPublishPostTxSnapshotsSettings(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)

	result, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID, Label: sql.NullString{String: "first", Valid: true}})
	require.NoError(t, err)
	require.Equal(t, int32(1), result.VersionNo)
	require.JSONEq(t, string(searchDoc("body")), string(result.BlockDoc))

	version, err := testQueries.GetPostVersion(ctx, GetPostVersionParams{PostID: f.post.ID, VersionNo: 1})
	require.NoError(t, err)
	require.True(t, version.Settings.Valid)
	settings := decodeTestSettings(t, version.Settings.RawMessage)
	require.Equal(t, "Original title", settings.Title)
	require.Equal(t, "Original excerpt", settings.Description)
	require.NotNil(t, settings.FeaturedImage)
	require.Equal(t, f.media.ID, *settings.FeaturedImage.ID)
	require.Equal(t, f.media.MediaPath, settings.FeaturedImage.URL)
	require.ElementsMatch(t, termIDs(f.terms...), settings.TermIDs)

	post, err := testQueries.GetPost(ctx, f.post.ID)
	require.NoError(t, err)
	require.Equal(t, "published", post.PostStatus)
	require.Equal(t, result.VersionID, post.PublishedVersionID.Int64)
	require.JSONEq(t, string(version.Settings.RawMessage), string(post.PublishedSettings.RawMessage))
	require.ElementsMatch(t, termIDs(f.terms...), publishedTermIDs(t, f.post.ID))

	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, state.Changed)
}

func TestSettingsEditsWaitForUpdate(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)

	// Edit every setting on the published post.
	_, err = testQueries.db.ExecContext(ctx, `UPDATE posts SET title = 'New title', description = 'New excerpt' WHERE id = $1`, f.post.ID)
	require.NoError(t, err)
	_, other := createTestMedia(t)
	setFeaturedImageMeta(t, f.post.ID, other)
	require.NoError(t, testQueries.RemovePostFromTaxonomyTerm(ctx, RemovePostFromTaxonomyTermParams{PostID: f.post.ID, TaxonomyTermID: f.terms[0].ID}))

	// The published settings and terms haven't moved.
	post, err := testQueries.GetPost(ctx, f.post.ID)
	require.NoError(t, err)
	published := decodeTestSettings(t, post.PublishedSettings.RawMessage)
	require.Equal(t, "Original title", published.Title)
	require.Equal(t, "Original excerpt", published.Description)
	require.Equal(t, f.media.ID, *published.FeaturedImage.ID)
	require.ElementsMatch(t, termIDs(f.terms...), publishedTermIDs(t, f.post.ID))

	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.True(t, state.Changed)
	require.Equal(t, "New title", decodeTestSettings(t, state.Working).Title)

	// Update publishes them.
	result, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)
	require.Equal(t, int32(2), result.VersionNo)
	post, err = testQueries.GetPost(ctx, f.post.ID)
	require.NoError(t, err)
	published = decodeTestSettings(t, post.PublishedSettings.RawMessage)
	require.Equal(t, "New title", published.Title)
	require.Equal(t, "New excerpt", published.Description)
	require.Equal(t, other.ID, *published.FeaturedImage.ID)
	require.Equal(t, []int64{f.terms[1].ID}, publishedTermIDs(t, f.post.ID))
	state, err = testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, state.Changed)

	// Version 1 keeps what it published.
	v1, err := testQueries.GetPostVersion(ctx, GetPostVersionParams{PostID: f.post.ID, VersionNo: 1})
	require.NoError(t, err)
	require.Equal(t, "Original title", decodeTestSettings(t, v1.Settings.RawMessage).Title)
}

func TestUnpublishClearsPublishedSettings(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)

	unpublished, err := testQueries.UnpublishPost(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, unpublished.PublishedSettings.Valid)
	require.Empty(t, publishedTermIDs(t, f.post.ID))
	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, state.Changed, "a draft has nothing waiting for Update")
	require.False(t, state.PublishedSettings.Valid)

	// A draft edit, then publishing again: the new settings go out.
	_, err = testQueries.db.ExecContext(ctx, `UPDATE posts SET title = 'Republished' WHERE id = $1`, f.post.ID)
	require.NoError(t, err)
	_, err = testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)
	post, err := testQueries.GetPost(ctx, f.post.ID)
	require.NoError(t, err)
	require.Equal(t, "Republished", decodeTestSettings(t, post.PublishedSettings.RawMessage).Title)
	require.ElementsMatch(t, termIDs(f.terms...), publishedTermIDs(t, f.post.ID))
}

func TestPublishPostTxMissingPost(t *testing.T) {
	_, err := testStore.PublishPostTx(context.Background(), PublishPostTxParams{PostID: -1})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// A post created as published (and the dev seed) gets its settings through
// SetPublishedVersionOnPost without a version.
func TestSetPublishedVersionOnPostWithoutVersion(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID:                f.post.ID,
		PublishedBlockDoc: pqtype.NullRawMessage{RawMessage: searchDoc("body"), Valid: true},
	}))
	post, err := testQueries.GetPost(ctx, f.post.ID)
	require.NoError(t, err)
	require.Equal(t, "Original title", decodeTestSettings(t, post.PublishedSettings.RawMessage).Title)
	require.ElementsMatch(t, termIDs(f.terms...), publishedTermIDs(t, f.post.ID))
}

func thumbnailURL(media Medium) string { return "/restored" + media.MediaPath }

func TestRestorePostSettingsTx(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)

	// Change everything and publish that as version 2.
	_, err = testQueries.db.ExecContext(ctx, `UPDATE posts SET title = 'Second title', description = 'Second excerpt' WHERE id = $1`, f.post.ID)
	require.NoError(t, err)
	_, other := createTestMedia(t)
	setFeaturedImageMeta(t, f.post.ID, other)
	require.NoError(t, testQueries.RemoveAllPostTaxonomies(ctx, f.post.ID))
	_, err = testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)

	// Restore version 1's settings; one of its terms has been deleted since.
	require.NoError(t, testQueries.DeleteTaxonomyTerm(ctx, f.terms[0].ID))
	v1, err := testQueries.GetPostVersion(ctx, GetPostVersionParams{PostID: f.post.ID, VersionNo: 1})
	require.NoError(t, err)
	s := decodeTestSettings(t, v1.Settings.RawMessage)
	post, err := testStore.RestorePostSettingsTx(ctx, RestorePostSettingsTxParams{
		PostID: f.post.ID,
		Settings: RestoredPostSettings{
			Title: s.Title, Description: s.Description, FeaturedImageID: s.FeaturedImage.ID,
			TermIDs: s.TermIDs, ThumbnailURL: thumbnailURL,
		},
	})
	require.NoError(t, err)
	require.Equal(t, "Original title", post.Title)
	require.Equal(t, "Original excerpt", post.Description)

	// The working copy has version 1's settings (minus the deleted term)...
	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	working := decodeTestSettings(t, state.Working)
	require.Equal(t, "Original title", working.Title)
	require.Equal(t, f.media.ID, *working.FeaturedImage.ID)
	require.Equal(t, thumbnailURL(f.media), working.FeaturedImage.URL)
	require.Equal(t, []int64{f.terms[1].ID}, working.TermIDs)
	featured, err := testQueries.GetFeaturedImage(ctx, f.post.ID)
	require.NoError(t, err)
	require.Equal(t, f.media.ID, featured.MediaID)

	// ...and the site still shows version 2 until Update.
	require.True(t, state.Changed)
	require.Equal(t, "Second title", decodeTestSettings(t, state.PublishedSettings.RawMessage).Title)
	require.Empty(t, publishedTermIDs(t, f.post.ID))

	// A version without a featured image clears it; a deleted image is skipped.
	_, err = testStore.RestorePostSettingsTx(ctx, RestorePostSettingsTxParams{
		PostID:   f.post.ID,
		Settings: RestoredPostSettings{Title: "No image", Description: "x", ThumbnailURL: thumbnailURL},
	})
	require.NoError(t, err)
	_, err = testQueries.GetFeaturedImage(ctx, f.post.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)
	missing := int64(-5)
	_, err = testStore.RestorePostSettingsTx(ctx, RestorePostSettingsTxParams{
		PostID:   f.post.ID,
		Settings: RestoredPostSettings{Title: "Gone image", Description: "x", FeaturedImageID: &missing, ThumbnailURL: thumbnailURL},
	})
	require.NoError(t, err)
	state, err = testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.Nil(t, decodeTestSettings(t, state.Working).FeaturedImage)

	_, err = testStore.RestorePostSettingsTx(ctx, RestorePostSettingsTxParams{PostID: -1, Settings: RestoredPostSettings{ThumbnailURL: thumbnailURL}})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// The featured image keys of a list row's meta come from the snapshot.
func TestPublicPostMeta(t *testing.T) {
	ctx := context.Background()
	var got []byte
	meta := `{"_thumbnail_id": "1", "_thumbnail_url": "/live.jpg", "other": "kept"}`
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT golive_public_post_meta($1::jsonb, NULL)`, meta).Scan(&got))
	require.JSONEq(t, meta, string(got))
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT golive_public_post_meta($1::jsonb, '{"featured_image": {"id": 7, "url": "/published.jpg"}}')`, meta).Scan(&got))
	require.JSONEq(t, `{"_thumbnail_id": "7", "_thumbnail_url": "/published.jpg", "other": "kept"}`, string(got))
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT golive_public_post_meta($1::jsonb, '{"featured_image": null}')`, meta).Scan(&got))
	require.JSONEq(t, `{"other": "kept"}`, string(got))
}

// The migration's backfill (000027): run its statements on a post in the
// pre-#358 state (published, no settings recorded), inside a transaction that
// is rolled back so the shared test database is left alone.
func TestPostSettingsBackfillMigration(t *testing.T) {
	ctx := context.Background()
	up, err := os.ReadFile("../migration/000027_post_settings_snapshot.up.sql")
	require.NoError(t, err)
	backfill := string(up)
	start := strings.Index(backfill, "-- Backfill:")
	require.GreaterOrEqual(t, start, 0)
	backfill = strings.TrimSuffix(strings.TrimSpace(backfill[start:]), "COMMIT;")

	f := createSettingsFixture(t)
	_, err = testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)
	// A post created as published: a snapshot without a version.
	seeded := createSettingsFixture(t)
	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID: seeded.post.ID, PublishedBlockDoc: pqtype.NullRawMessage{RawMessage: searchDoc("seed"), Valid: true},
	}))
	draft := createSettingsFixture(t)

	tx, err := testStore.(*SQLStore).db.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer tx.Rollback() //nolint:errcheck
	ids := []int64{f.post.ID, seeded.post.ID, draft.post.ID}
	_, err = tx.ExecContext(ctx, `UPDATE post_versions SET settings = NULL WHERE post_id = ANY($1)`, pq.Array(ids))
	require.NoError(t, err)
	_, err = tx.ExecContext(ctx, `UPDATE posts SET published_settings = NULL WHERE id = ANY($1)`, pq.Array(ids))
	require.NoError(t, err)
	var terms int
	require.NoError(t, tx.QueryRowContext(ctx, `SELECT count(*) FROM post_published_terms WHERE post_id = ANY($1)`, pq.Array(ids)).Scan(&terms))
	require.Zero(t, terms)

	_, err = tx.ExecContext(ctx, backfill)
	require.NoError(t, err)

	read := func(query string, id int64) testSettings {
		var raw []byte
		require.NoError(t, tx.QueryRowContext(ctx, query, id).Scan(&raw))
		return decodeTestSettings(t, raw)
	}
	for _, id := range []int64{f.post.ID, seeded.post.ID} {
		published := read(`SELECT published_settings FROM posts WHERE id = $1`, id)
		require.Equal(t, "Original title", published.Title)
		require.Len(t, published.TermIDs, 2)
	}
	version := read(`SELECT v.settings FROM post_versions v JOIN posts p ON p.published_version_id = v.id WHERE p.id = $1`, f.post.ID)
	require.Equal(t, "Original title", version.Title)
	require.NoError(t, tx.QueryRowContext(ctx, `SELECT count(*) FROM post_published_terms WHERE post_id = ANY($1)`, pq.Array(ids)).Scan(&terms))
	require.Equal(t, 4, terms, "both published posts' two terms, none of the draft's")
	var draftSettings sql.NullString
	require.NoError(t, tx.QueryRowContext(ctx, `SELECT published_settings FROM posts WHERE id = $1`, draft.post.ID).Scan(&draftSettings))
	require.False(t, draftSettings.Valid)
}

// A term deleted after the publish is gone from what the site shows and from what
// can be published, so it isn't a pending settings change.
func TestSettingsStateIgnoresDeletedTerms(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: f.post.ID})
	require.NoError(t, err)

	require.NoError(t, testQueries.DeleteTaxonomyTerm(ctx, f.terms[0].ID))
	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, state.Changed)
	require.Equal(t, []int64{f.terms[1].ID}, publishedTermIDs(t, f.post.ID))

	// A real change still counts.
	require.NoError(t, testQueries.RemoveAllPostTaxonomies(ctx, f.post.ID))
	state, err = testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.True(t, state.Changed)
}

// The admin search finds a published post by its working title too: the list
// shows it, while the index (and the public search) has the published one.
func TestAdminSearchMatchesWorkingTitle(t *testing.T) {
	ctx := context.Background()
	owner := createRandomUser(t)
	oldWord, newWord := searchWord(t), searchWord(t)
	post := createSearchPost(t, owner, searchPostSpec{title: "Title " + oldWord, description: "plain excerpt"})
	publishSearchPost(t, post, searchDoc("plain body"))
	_, err := testQueries.db.ExecContext(ctx, `UPDATE posts SET title = $2 WHERE id = $1`, post.ID, "Title "+newWord)
	require.NoError(t, err)

	for _, word := range []string{oldWord, newWord} {
		rows, err := testQueries.SearchPostsWithMeta(ctx, SearchPostsWithMetaParams{Query: word, LimitCount: 10})
		require.NoError(t, err)
		require.Len(t, rows, 1, word)
		require.Equal(t, post.ID, rows[0].ID)
		total, err := testQueries.CountSearchPosts(ctx, CountSearchPostsParams{Query: word})
		require.NoError(t, err)
		require.Equal(t, int64(1), total, word)
	}
	require.Empty(t, publicSearchIDs(t, newWord, ""))
}

// The dev seed publishes posts before linking their terms and images, then
// refreshes their published settings; drafts are left alone.
func TestRefreshPublishedSettings(t *testing.T) {
	ctx := context.Background()
	published := createSettingsFixture(t)
	require.NoError(t, testQueries.RemoveAllPostTaxonomies(ctx, published.post.ID))
	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID: published.post.ID, PublishedBlockDoc: pqtype.NullRawMessage{RawMessage: searchDoc("seed"), Valid: true},
	}))
	require.Empty(t, publishedTermIDs(t, published.post.ID))
	linkTerms(t, published.post, published.terms...)
	draft := createSettingsFixture(t)

	require.NoError(t, testQueries.RefreshPublishedSettings(ctx, []int64{published.post.ID, draft.post.ID}))
	require.ElementsMatch(t, termIDs(published.terms...), publishedTermIDs(t, published.post.ID))
	post, err := testQueries.GetPost(ctx, draft.post.ID)
	require.NoError(t, err)
	require.False(t, post.PublishedSettings.Valid)
}
