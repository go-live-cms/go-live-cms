package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// createChildTerm creates a term under parent (nil for a root term).
func createChildTerm(t *testing.T, typeID int64, name string, parent *TaxonomyTerm, sortOrder int32) TaxonomyTerm {
	t.Helper()
	unique := fmt.Sprintf("%s-%d", name, time.Now().UnixNano())
	arg := CreateTaxonomyTermParams{
		Name:           unique,
		Slug:           unique,
		TaxonomyTypeID: typeID,
		SortOrder:      sql.NullInt32{Int32: sortOrder, Valid: true},
	}
	if parent != nil {
		arg.ParentID = sql.NullInt64{Int64: parent.ID, Valid: true}
	}
	term, err := testQueries.CreateTaxonomyTerm(context.Background(), arg)
	require.NoError(t, err)
	return term
}

// TestTaxonomyTermHierarchy builds root > child > grandchild and checks the
// parent/child lookups and the recursive tree query used for category menus.
func TestTaxonomyTermHierarchy(t *testing.T) {
	ctx := context.Background()
	taxType := createTestTaxonomyType(t, fmt.Sprintf("tree%d", time.Now().UnixNano()), "Tree", true)

	root := createChildTerm(t, taxType.ID, "root", nil, 0)
	childB := createChildTerm(t, taxType.ID, "b-child", &root, 2)
	childA := createChildTerm(t, taxType.ID, "a-child", &root, 1)
	grandchild := createChildTerm(t, taxType.ID, "grandchild", &childA, 0)

	children, err := testQueries.GetTermChildren(ctx, sql.NullInt64{Int64: root.ID, Valid: true})
	require.NoError(t, err)
	require.Len(t, children, 2)
	require.Equal(t, childA.ID, children[0].ID, "children are ordered by sort_order")
	require.Equal(t, childB.ID, children[1].ID)

	parents, err := testQueries.GetTermParents(ctx, grandchild.ID)
	require.NoError(t, err)
	require.Len(t, parents, 1)
	require.Equal(t, childA.ID, parents[0].ID)

	parents, err = testQueries.GetTermParents(ctx, root.ID)
	require.NoError(t, err)
	require.Empty(t, parents)

	tree, err := testQueries.GetTaxonomyTermTree(ctx, taxType.Name)
	require.NoError(t, err)
	require.Len(t, tree, 4)

	levels := map[int64]int32{}
	for i, row := range tree {
		levels[row.ID] = row.Level
		require.Equal(t, taxType.Name, row.TaxonomyTypeName)
		if i > 0 {
			require.GreaterOrEqual(t, row.Level, tree[i-1].Level, "tree is ordered by level")
		}
	}
	require.Equal(t, map[int64]int32{root.ID: 0, childA.ID: 1, childB.ID: 1, grandchild.ID: 2}, levels)

	// Deleting a parent promotes its children to roots (FK ON DELETE SET NULL)
	// instead of leaving them pointing at a missing row.
	require.NoError(t, testStore.DeleteTaxonomyTermTx(ctx, childA.ID))
	promoted, err := testQueries.GetTaxonomyTerm(ctx, grandchild.ID)
	require.NoError(t, err)
	require.False(t, promoted.ParentID.Valid)
}

// TestUpdatePostMediaTxOrdering covers how a post's media list is replaced:
// the new order follows the given IDs, the old links are gone, and an unknown
// media ID rolls the whole change back.
func TestUpdatePostMediaTxOrdering(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	owner := createTestUser(t)

	m1 := createMediaWithName(t, owner.ID, fmt.Sprintf("m1-%d.jpg", time.Now().UnixNano()), "first media item")
	m2 := createMediaWithName(t, owner.ID, fmt.Sprintf("m2-%d.jpg", time.Now().UnixNano()), "second media item")
	m3 := createMediaWithName(t, owner.ID, fmt.Sprintf("m3-%d.jpg", time.Now().UnixNano()), "third media item")

	orderOf := func() []int64 {
		rows, err := testQueries.GetMediaByPostWithOrder(ctx, post.ID)
		require.NoError(t, err)
		ids := make([]int64, len(rows))
		for i, r := range rows {
			require.Equal(t, int32(i), r.MediaOrder)
			ids[i] = r.ID
		}
		return ids
	}

	require.NoError(t, testStore.UpdatePostMediaTx(ctx, UpdatePostMediaTxParams{PostID: post.ID, MediaIDs: []int64{m3.ID, m1.ID, m2.ID}}))
	require.Equal(t, []int64{m3.ID, m1.ID, m2.ID}, orderOf())

	require.NoError(t, testStore.UpdatePostMediaTx(ctx, UpdatePostMediaTxParams{PostID: post.ID, MediaIDs: []int64{m2.ID}}))
	require.Equal(t, []int64{m2.ID}, orderOf())

	count, err := testQueries.GetPostMediaCount(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	// An unknown media ID fails the transaction; the previous list survives.
	err = testStore.UpdatePostMediaTx(ctx, UpdatePostMediaTxParams{PostID: post.ID, MediaIDs: []int64{m1.ID, -42}})
	require.Error(t, err)
	require.Contains(t, err.Error(), "media -42 not found")
	require.Equal(t, []int64{m2.ID}, orderOf())

	err = testStore.UpdatePostMediaTx(ctx, UpdatePostMediaTxParams{PostID: -1, MediaIDs: []int64{m1.ID}})
	require.Error(t, err)
	require.Contains(t, err.Error(), "post -1 not found")

	// An empty list clears the links.
	require.NoError(t, testStore.UpdatePostMediaTx(ctx, UpdatePostMediaTxParams{PostID: post.ID}))
	require.Empty(t, orderOf())
}

// TestCreateMediaAndLinkTx: uploading straight into a post creates the media
// row and its link together, or neither.
func TestCreateMediaAndLinkTx(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	owner := createTestUser(t)

	arg := CreateMediaAndLinkTxParams{
		Name:             "linked",
		Description:      "linked upload",
		Alt:              "linked alt",
		MediaPath:        fmt.Sprintf("/uploads/media/linked-%d.png", time.Now().UnixNano()),
		UserID:           owner.ID,
		FileSize:         1234,
		MimeType:         "image/png",
		OriginalFilename: "linked.png",
		PostID:           post.ID,
		Order:            3,
	}

	result, err := testStore.CreateMediaAndLinkTx(ctx, arg)
	require.NoError(t, err)
	require.Equal(t, post.ID, result.PostMedia.PostID)
	require.Equal(t, result.Media.ID, result.PostMedia.MediaID)
	require.Equal(t, int32(3), result.PostMedia.Order)

	rows, err := testQueries.GetMediaByPostWithOrder(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, result.Media.ID, rows[0].ID)

	// A missing post rolls back the media row too.
	arg.PostID = -1
	arg.MediaPath = fmt.Sprintf("/uploads/media/orphan-%d.png", time.Now().UnixNano())
	_, err = testStore.CreateMediaAndLinkTx(ctx, arg)
	require.Error(t, err)

	var orphans int
	require.NoError(t, testStore.(*SQLStore).db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM media WHERE media_path = $1", arg.MediaPath).Scan(&orphans))
	require.Zero(t, orphans)
}

// TestThemeActivation pins the activation contract the themes handler uses:
// at most one active theme (a partial unique index), so activation must
// deactivate the current theme first.
func TestThemeActivation(t *testing.T) {
	ctx := context.Background()

	previous, prevErr := testQueries.GetActiveTheme(ctx)
	t.Cleanup(func() {
		// Leave the shared test DB with the theme that was active before.
		_ = testQueries.DeactivateAllThemes(ctx)
		if prevErr == nil {
			_, _ = testQueries.ActivateTheme(ctx, previous.ID)
		}
	})

	slug := fmt.Sprintf("test-theme-%d", time.Now().UnixNano())
	theme, err := testQueries.CreateTheme(ctx, CreateThemeParams{
		Name:    "Test Theme",
		Slug:    slug,
		Version: "1.0.0",
		Config:  json.RawMessage(`{"layouts":{}}`),
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = testQueries.DeleteTheme(ctx, theme.ID) })
	require.False(t, theme.Active)

	if prevErr == nil {
		// Activating without deactivating first violates the index.
		_, err = testQueries.ActivateTheme(ctx, theme.ID)
		require.Error(t, err)
	}

	require.NoError(t, testQueries.DeactivateAllThemes(ctx))
	activated, err := testQueries.ActivateTheme(ctx, theme.ID)
	require.NoError(t, err)
	require.True(t, activated.Active)

	active, err := testQueries.GetActiveTheme(ctx)
	require.NoError(t, err)
	require.Equal(t, theme.ID, active.ID)

	bySlug, err := testQueries.GetThemeBySlug(ctx, slug)
	require.NoError(t, err)
	require.True(t, bySlug.Active)

	// Theme settings are per theme and upsert in place.
	_, err = testQueries.UpsertThemeSetting(ctx, UpsertThemeSettingParams{ThemeID: theme.ID, SettingKey: "layout", SettingValue: json.RawMessage(`{"post":"wide"}`)})
	require.NoError(t, err)
	setting, err := testQueries.UpsertThemeSetting(ctx, UpsertThemeSettingParams{ThemeID: theme.ID, SettingKey: "layout", SettingValue: json.RawMessage(`{"post":"sidebar"}`)})
	require.NoError(t, err)
	require.JSONEq(t, `{"post":"sidebar"}`, string(setting.SettingValue))

	settings, err := testQueries.ListThemeSettings(ctx, theme.ID)
	require.NoError(t, err)
	require.Len(t, settings, 1)

	// Activating a theme that doesn't exist reports no rows.
	_, err = testQueries.ActivateTheme(ctx, -1)
	require.ErrorIs(t, err, sql.ErrNoRows)
}
