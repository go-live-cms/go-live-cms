package db

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func createTestMenu(t *testing.T, location string) Menu {
	t.Helper()
	loc := sql.NullString{String: location, Valid: location != ""}
	menu, err := testStore.SaveMenuTx(context.Background(), SaveMenuTxParams{Name: "Menu " + location, Location: loc})
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = testQueries.DeleteMenu(context.Background(), menu.ID) })
	return menu
}

func uniqueLocation(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

func TestSaveMenuTxMovesLocation(t *testing.T) {
	ctx := context.Background()
	location := uniqueLocation("primary")
	first := createTestMenu(t, location)
	second := createTestMenu(t, "")

	moved, err := testStore.SaveMenuTx(ctx, SaveMenuTxParams{ID: second.ID, Name: "Main", Location: sql.NullString{String: location, Valid: true}})
	require.NoError(t, err)
	require.Equal(t, "Main", moved.Name)
	require.Equal(t, location, moved.Location.String)

	byLocation, err := testQueries.GetMenuByLocation(ctx, sql.NullString{String: location, Valid: true})
	require.NoError(t, err)
	require.Equal(t, second.ID, byLocation.ID)

	old, err := testQueries.GetMenu(ctx, first.ID)
	require.NoError(t, err)
	require.False(t, old.Location.Valid)

	_, err = testStore.SaveMenuTx(ctx, SaveMenuTxParams{ID: -1, Name: "Gone"})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

func TestReplaceMenuItemsTxResolvesTargets(t *testing.T) {
	ctx := context.Background()
	menu := createTestMenu(t, uniqueLocation("footer"))
	post := createPostWithTransaction(t).Post
	taxonomy := createTestTaxonomyType(t, "menu_tax", "Menu taxonomy", false)
	term := createTestTaxonomyTerm(t, taxonomy.ID)

	items, err := testStore.ReplaceMenuItemsTx(ctx, ReplaceMenuItemsTxParams{MenuID: menu.ID, Items: []MenuItemInput{
		{ParentIndex: -1, ItemType: "post", PostID: sql.NullInt64{Int64: post.ID, Valid: true}},
		{ParentIndex: 0, ItemType: "term", TermID: sql.NullInt64{Int64: term.ID, Valid: true}},
		{ParentIndex: 0, ItemType: "custom", Label: "Docs", Url: "/docs"},
		{ParentIndex: -1, ItemType: "archive", PostType: sql.NullString{String: "post", Valid: true}},
	}})
	require.NoError(t, err)
	require.Len(t, items, 4)
	require.Equal(t, items[0].ID, items[1].ParentID.Int64)
	require.Equal(t, items[0].ID, items[2].ParentID.Int64)
	require.False(t, items[3].ParentID.Valid)

	rows, err := testQueries.ListMenuItemsWithTargets(ctx, menu.ID)
	require.NoError(t, err)
	require.Len(t, rows, 4)
	require.Equal(t, post.Slug, rows[0].PostSlug.String)
	require.Equal(t, "published", rows[0].PostStatus.String)
	require.True(t, rows[0].PostTypePublic.Bool)
	require.Equal(t, term.Slug, rows[1].TermSlug.String)
	require.Equal(t, taxonomy.Name, rows[1].TaxonomyName.String)
	require.Equal(t, "/docs", rows[2].Url)
	require.True(t, rows[3].ArchiveLabel.Valid)

	// A slug change shows up on the next read: nothing about the URL is stored.
	newSlug := fmt.Sprintf("renamed-%d", time.Now().UnixNano())
	_, err = testQueries.UpdatePostSlug(ctx, UpdatePostSlugParams{ID: post.ID, Slug: newSlug})
	require.NoError(t, err)
	rows, err = testQueries.ListMenuItemsWithTargets(ctx, menu.ID)
	require.NoError(t, err)
	require.Equal(t, newSlug, rows[0].PostSlug.String)

	// Unpublishing keeps the item; the API hides it by its status.
	_, err = testQueries.UnpublishPost(ctx, post.ID)
	require.NoError(t, err)
	rows, err = testQueries.ListMenuItemsWithTargets(ctx, menu.ID)
	require.NoError(t, err)
	require.Equal(t, "draft", rows[0].PostStatus.String)

	// Deleting the post deletes its item; the children move up in place.
	require.NoError(t, testStore.DeletePostTx(ctx, post.ID))
	rows, err = testQueries.ListMenuItemsWithTargets(ctx, menu.ID)
	require.NoError(t, err)
	require.Len(t, rows, 3)
	require.Equal(t, "term", rows[0].ItemType)
	require.False(t, rows[0].ParentID.Valid)
	require.Equal(t, "custom", rows[1].ItemType)

	// A replace starts over.
	items, err = testStore.ReplaceMenuItemsTx(ctx, ReplaceMenuItemsTxParams{MenuID: menu.ID, Items: []MenuItemInput{
		{ParentIndex: -1, ItemType: "custom", Label: "Home", Url: "/"},
	}})
	require.NoError(t, err)
	require.Len(t, items, 1)
	list, err := testQueries.ListMenus(ctx)
	require.NoError(t, err)
	for _, m := range list {
		if m.ID == menu.ID {
			require.Equal(t, int64(1), m.ItemCount)
		}
	}
}

func TestReplaceMenuItemsTxRejects(t *testing.T) {
	ctx := context.Background()
	menu := createTestMenu(t, "")

	_, err := testStore.ReplaceMenuItemsTx(ctx, ReplaceMenuItemsTxParams{MenuID: menu.ID, Items: []MenuItemInput{
		{ParentIndex: -1, ItemType: "post", PostID: sql.NullInt64{Int64: -42, Valid: true}},
	}})
	require.ErrorContains(t, err, "violates foreign key constraint")

	_, err = testStore.ReplaceMenuItemsTx(ctx, ReplaceMenuItemsTxParams{MenuID: menu.ID, Items: []MenuItemInput{
		{ParentIndex: -1, ItemType: "custom", Label: "A", Url: "/a"},
		{ParentIndex: 0, ItemType: "custom", Label: "B", Url: "/b"},
		{ParentIndex: 1, ItemType: "custom", Label: "C", Url: "/c"},
	}})
	require.ErrorIs(t, err, ErrMenuItemParent)

	// A custom item needs its URL (the target CHECK).
	_, err = testStore.ReplaceMenuItemsTx(ctx, ReplaceMenuItemsTxParams{MenuID: menu.ID, Items: []MenuItemInput{
		{ParentIndex: -1, ItemType: "custom", Label: "Nowhere"},
	}})
	require.ErrorContains(t, err, "menu_items_target")

	_, err = testStore.ReplaceMenuItemsTx(ctx, ReplaceMenuItemsTxParams{MenuID: -1})
	require.ErrorIs(t, err, sql.ErrNoRows)

	rows, err := testQueries.ListMenuItemsWithTargets(ctx, menu.ID)
	require.NoError(t, err)
	require.Empty(t, rows)
}
