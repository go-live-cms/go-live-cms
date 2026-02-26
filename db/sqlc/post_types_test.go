package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/stretchr/testify/require"
)

func createTestPostType(t *testing.T) PostType {
	gofakeit.Seed(0)

	supports := []string{"title", "content", "description", "author"}
	supportsJSON, err := json.Marshal(supports)
	require.NoError(t, err)

	arg := CreatePostTypeParams{
		Name:         fmt.Sprintf("%s_type_%d", gofakeit.Word(), time.Now().UnixNano()),
		Label:        gofakeit.Sentence(2),
		Description:  sql.NullString{String: gofakeit.Sentence(10), Valid: true},
		Public:       gofakeit.Bool(),
		Hierarchical: gofakeit.Bool(),
		HasArchive:   gofakeit.Bool(),
		MenuPosition: sql.NullInt32{Int32: int32(gofakeit.Number(0, 100)), Valid: true},
		Supports:     json.RawMessage(supportsJSON),
	}

	postType, err := testQueries.CreatePostType(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, postType)
	require.Equal(t, arg.Name, postType.Name)
	require.Equal(t, arg.Label, postType.Label)
	require.Equal(t, arg.Description, postType.Description)
	require.Equal(t, arg.Public, postType.Public)
	require.Equal(t, arg.Hierarchical, postType.Hierarchical)
	require.Equal(t, arg.HasArchive, postType.HasArchive)
	require.Equal(t, arg.MenuPosition, postType.MenuPosition)
	require.NotZero(t, postType.ID)
	require.NotZero(t, postType.CreatedAt)

	return postType
}

func TestCreatePostType(t *testing.T) {
	postType := createTestPostType(t)
	require.NotEmpty(t, postType)
}

func TestGetPostType(t *testing.T) {
	postType1 := createTestPostType(t)

	postType2, err := testQueries.GetPostType(context.Background(), postType1.Name)
	require.NoError(t, err)
	require.NotEmpty(t, postType2)
	require.Equal(t, postType1.ID, postType2.ID)
	require.Equal(t, postType1.Name, postType2.Name)
	require.Equal(t, postType1.Label, postType2.Label)
	require.Equal(t, postType1.Description, postType2.Description)
	require.Equal(t, postType1.Public, postType2.Public)
	require.Equal(t, postType1.Hierarchical, postType2.Hierarchical)
	require.Equal(t, postType1.HasArchive, postType2.HasArchive)
	require.Equal(t, postType1.MenuPosition, postType2.MenuPosition)
}

func TestGetPostTypeByID(t *testing.T) {
	postType1 := createTestPostType(t)

	postType2, err := testQueries.GetPostTypeByID(context.Background(), postType1.ID)
	require.NoError(t, err)
	require.NotEmpty(t, postType2)
	require.Equal(t, postType1.ID, postType2.ID)
	require.Equal(t, postType1.Name, postType2.Name)
	require.Equal(t, postType1.Label, postType2.Label)
}

func TestListPostTypes(t *testing.T) {
	// Create several test post types
	for i := 0; i < 5; i++ {
		createTestPostType(t)
	}

	postTypes, err := testQueries.ListPostTypes(context.Background())
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(postTypes), 5) // Should include our created types plus default ones

	// Verify they are ordered by menu_position ASC, name ASC
	for i := 1; i < len(postTypes); i++ {
		prev := postTypes[i-1]
		curr := postTypes[i]

		if prev.MenuPosition.Valid && curr.MenuPosition.Valid {
			if prev.MenuPosition.Int32 == curr.MenuPosition.Int32 {
				require.LessOrEqual(t, prev.Name, curr.Name, "When menu_position is equal, should be ordered by name")
			} else {
				require.LessOrEqual(t, prev.MenuPosition.Int32, curr.MenuPosition.Int32, "Should be ordered by menu_position")
			}
		}
	}
}

func TestUpdatePostType(t *testing.T) {
	postType1 := createTestPostType(t)

	newLabel := gofakeit.Sentence(3)
	newDescription := gofakeit.Sentence(15)
	newSupports := []string{"title", "content", "media", "taxonomies"}
	newSupportsJSON, err := json.Marshal(newSupports)
	require.NoError(t, err)

	arg := UpdatePostTypeParams{
		Label:        newLabel,
		Description:  sql.NullString{String: newDescription, Valid: true},
		Public:       !postType1.Public,       // flip the boolean
		Hierarchical: !postType1.Hierarchical, // flip the boolean
		HasArchive:   !postType1.HasArchive,   // flip the boolean
		MenuPosition: sql.NullInt32{Int32: 50, Valid: true},
		Supports:     json.RawMessage(newSupportsJSON),
		Name:         postType1.Name,
	}

	postType2, err := testQueries.UpdatePostType(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, postType2)
	require.Equal(t, postType1.ID, postType2.ID)
	require.Equal(t, postType1.Name, postType2.Name) // Name should not change
	require.Equal(t, newLabel, postType2.Label)
	require.Equal(t, arg.Description, postType2.Description)
	require.Equal(t, arg.Public, postType2.Public)
	require.Equal(t, arg.Hierarchical, postType2.Hierarchical)
	require.Equal(t, arg.HasArchive, postType2.HasArchive)
	require.Equal(t, arg.MenuPosition, postType2.MenuPosition)

	// Compare JSON supports semantically rather than byte-for-byte
	var expectedSupports, actualSupports []string
	err = json.Unmarshal(arg.Supports, &expectedSupports)
	require.NoError(t, err)
	err = json.Unmarshal(postType2.Supports, &actualSupports)
	require.NoError(t, err)
	require.ElementsMatch(t, expectedSupports, actualSupports)
}

func TestDeletePostType(t *testing.T) {
	postType := createTestPostType(t)

	err := testQueries.DeletePostType(context.Background(), postType.Name)
	require.NoError(t, err)

	// Verify it's deleted
	deletedPostType, err := testQueries.GetPostType(context.Background(), postType.Name)
	require.Error(t, err)
	require.EqualError(t, err, sql.ErrNoRows.Error())
	require.Empty(t, deletedPostType)
}

// Post Meta Tests

func createTestPostMeta(t *testing.T, postID int64, key string, value string) PostMetum {
	arg := CreatePostMetaParams{
		PostID:    postID,
		MetaKey:   key,
		MetaValue: sql.NullString{String: value, Valid: true},
	}

	meta, err := testQueries.CreatePostMeta(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, meta)
	require.Equal(t, arg.PostID, meta.PostID)
	require.Equal(t, arg.MetaKey, meta.MetaKey)
	require.Equal(t, arg.MetaValue, meta.MetaValue)
	require.NotZero(t, meta.ID)
	require.NotZero(t, meta.CreatedAt)

	return meta
}

func TestCreatePostMeta(t *testing.T) {
	user, post := createTestUserWithPosts(t)

	key := gofakeit.Word()
	value := gofakeit.Sentence(5)

	meta := createTestPostMeta(t, post.Post.ID, key, value)
	require.NotEmpty(t, meta)
	require.Equal(t, user.ID, post.Post.UserID) // Sanity check
}

func TestGetPostMeta(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	// Create multiple meta entries for the post
	metaEntries := []struct {
		key   string
		value string
	}{
		{"featured_image", "image1.jpg"},
		{"seo_title", "SEO optimized title"},
		{"custom_field", "custom value"},
		{"another_field", "another value"},
	}

	for _, entry := range metaEntries {
		createTestPostMeta(t, post.Post.ID, entry.key, entry.value)
	}

	// Get all meta for the post
	metas, err := testQueries.GetPostMeta(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(metas), len(metaEntries))

	// Verify they are ordered by meta_key ASC
	for i := 1; i < len(metas); i++ {
		require.LessOrEqual(t, metas[i-1].MetaKey, metas[i].MetaKey, "Meta should be ordered by key")
	}

	// Verify our created metas are in the results
	metaMap := make(map[string]string)
	for _, meta := range metas {
		if meta.MetaValue.Valid {
			metaMap[meta.MetaKey] = meta.MetaValue.String
		}
	}

	for _, entry := range metaEntries {
		require.Equal(t, entry.value, metaMap[entry.key], "Meta value should match for key: %s", entry.key)
	}
}

func TestGetPostMetaByKey(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	key := "featured_image"
	value := "hero-image.jpg"

	meta1 := createTestPostMeta(t, post.Post.ID, key, value)

	meta2, err := testQueries.GetPostMetaByKey(context.Background(), GetPostMetaByKeyParams{
		PostID:  post.Post.ID,
		MetaKey: key,
	})
	require.NoError(t, err)
	require.NotEmpty(t, meta2)
	require.Equal(t, meta1.ID, meta2.ID)
	require.Equal(t, meta1.PostID, meta2.PostID)
	require.Equal(t, meta1.MetaKey, meta2.MetaKey)
	require.Equal(t, meta1.MetaValue, meta2.MetaValue)
}

func TestUpdatePostMeta(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	key := "custom_field"
	originalValue := "original value"
	newValue := "updated value"

	meta1 := createTestPostMeta(t, post.Post.ID, key, originalValue)

	arg := UpdatePostMetaParams{
		PostID:    post.Post.ID,
		MetaKey:   key,
		MetaValue: sql.NullString{String: newValue, Valid: true},
	}

	meta2, err := testQueries.UpdatePostMeta(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, meta2)
	require.Equal(t, meta1.ID, meta2.ID)
	require.Equal(t, meta1.PostID, meta2.PostID)
	require.Equal(t, meta1.MetaKey, meta2.MetaKey)
	require.Equal(t, arg.MetaValue, meta2.MetaValue)
	require.NotEqual(t, meta1.MetaValue, meta2.MetaValue)
}

func TestUpsertPostMeta(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	key := "upsert_field"
	value1 := "first value"
	value2 := "updated value"

	// First upsert - should create new
	arg1 := UpsertPostMetaParams{
		PostID:    post.Post.ID,
		MetaKey:   key,
		MetaValue: sql.NullString{String: value1, Valid: true},
	}

	meta1, err := testQueries.UpsertPostMeta(context.Background(), arg1)
	require.NoError(t, err)
	require.NotEmpty(t, meta1)
	require.Equal(t, arg1.PostID, meta1.PostID)
	require.Equal(t, arg1.MetaKey, meta1.MetaKey)
	require.Equal(t, arg1.MetaValue, meta1.MetaValue)

	// Second upsert - should update existing
	arg2 := UpsertPostMetaParams{
		PostID:    post.Post.ID,
		MetaKey:   key,
		MetaValue: sql.NullString{String: value2, Valid: true},
	}

	meta2, err := testQueries.UpsertPostMeta(context.Background(), arg2)
	require.NoError(t, err)
	require.NotEmpty(t, meta2)
	require.Equal(t, meta1.ID, meta2.ID) // Should be same ID (updated, not created)
	require.Equal(t, arg2.PostID, meta2.PostID)
	require.Equal(t, arg2.MetaKey, meta2.MetaKey)
	require.Equal(t, arg2.MetaValue, meta2.MetaValue)
	require.NotEqual(t, meta1.MetaValue, meta2.MetaValue)

	// Verify only one entry exists
	metas, err := testQueries.GetPostMeta(context.Background(), post.Post.ID)
	require.NoError(t, err)

	keyCount := 0
	for _, meta := range metas {
		if meta.MetaKey == key {
			keyCount++
			require.Equal(t, value2, meta.MetaValue.String)
		}
	}
	require.Equal(t, 1, keyCount, "Should have exactly one meta entry for the key")
}

func TestDeletePostMeta(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	key := "delete_test"
	value := "to be deleted"

	meta := createTestPostMeta(t, post.Post.ID, key, value)

	err := testQueries.DeletePostMeta(context.Background(), DeletePostMetaParams{
		PostID:  post.Post.ID,
		MetaKey: key,
	})
	require.NoError(t, err)

	// Verify it's deleted
	deletedMeta, err := testQueries.GetPostMetaByKey(context.Background(), GetPostMetaByKeyParams{
		PostID:  post.Post.ID,
		MetaKey: key,
	})
	require.Error(t, err)
	require.EqualError(t, err, sql.ErrNoRows.Error())
	require.Empty(t, deletedMeta)
	require.NotEqual(t, meta.ID, deletedMeta.ID)
}

func TestDeleteAllPostMeta(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	// Create multiple meta entries
	keys := []string{"meta1", "meta2", "meta3", "meta4"}
	for _, key := range keys {
		createTestPostMeta(t, post.Post.ID, key, gofakeit.Sentence(3))
	}

	// Verify they exist
	metasBefore, err := testQueries.GetPostMeta(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(metasBefore), len(keys))

	// Delete all meta for the post
	err = testQueries.DeleteAllPostMeta(context.Background(), post.Post.ID)
	require.NoError(t, err)

	// Verify all are deleted
	metasAfter, err := testQueries.GetPostMeta(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, metasAfter, 0)
}

func TestPostMetaWithNullValue(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	key := "nullable_field"

	arg := CreatePostMetaParams{
		PostID:    post.Post.ID,
		MetaKey:   key,
		MetaValue: sql.NullString{Valid: false}, // NULL value
	}

	meta, err := testQueries.CreatePostMeta(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, meta)
	require.Equal(t, arg.PostID, meta.PostID)
	require.Equal(t, arg.MetaKey, meta.MetaKey)
	require.False(t, meta.MetaValue.Valid)
	require.Equal(t, "", meta.MetaValue.String)

	// Verify we can retrieve it
	retrievedMeta, err := testQueries.GetPostMetaByKey(context.Background(), GetPostMetaByKeyParams{
		PostID:  post.Post.ID,
		MetaKey: key,
	})
	require.NoError(t, err)
	require.Equal(t, meta.ID, retrievedMeta.ID)
	require.False(t, retrievedMeta.MetaValue.Valid)
}

func TestPostTypeWithMinimalData(t *testing.T) {
	name := fmt.Sprintf("%s_minimal_%d", gofakeit.Word(), time.Now().UnixNano())
	label := gofakeit.Sentence(2)

	supports := []string{"title"}
	supportsJSON, err := json.Marshal(supports)
	require.NoError(t, err)

	arg := CreatePostTypeParams{
		Name:         name,
		Label:        label,
		Description:  sql.NullString{Valid: false}, // NULL description
		Public:       true,
		Hierarchical: false,
		HasArchive:   true,
		MenuPosition: sql.NullInt32{Valid: false}, // NULL menu position
		Supports:     json.RawMessage(supportsJSON),
	}

	postType, err := testQueries.CreatePostType(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, postType)
	require.Equal(t, name, postType.Name)
	require.Equal(t, label, postType.Label)
	require.False(t, postType.Description.Valid)
	require.False(t, postType.MenuPosition.Valid)
	require.True(t, postType.Public)
	require.False(t, postType.Hierarchical)
	require.True(t, postType.HasArchive)
}

func TestPostTypeSupportsJSONHandling(t *testing.T) {
	// Test with complex supports structure
	supports := map[string]interface{}{
		"basic": []string{"title", "content", "description"},
		"advanced": map[string]bool{
			"taxonomies": true,
			"media":      true,
			"comments":   false,
		},
		"custom": map[string]interface{}{
			"max_length": 1000,
			"required":   true,
		},
	}

	supportsJSON, err := json.Marshal(supports)
	require.NoError(t, err)

	arg := CreatePostTypeParams{
		Name:         fmt.Sprintf("%s_complex_%d", gofakeit.Word(), time.Now().UnixNano()),
		Label:        gofakeit.Sentence(2),
		Description:  sql.NullString{String: gofakeit.Sentence(5), Valid: true},
		Public:       true,
		Hierarchical: false,
		HasArchive:   true,
		MenuPosition: sql.NullInt32{Int32: 25, Valid: true},
		Supports:     json.RawMessage(supportsJSON),
	}

	postType, err := testQueries.CreatePostType(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, postType)

	// Verify JSON is preserved
	var retrievedSupports map[string]interface{}
	err = json.Unmarshal(postType.Supports, &retrievedSupports)
	require.NoError(t, err)

	// Verify structure is preserved
	require.Contains(t, retrievedSupports, "basic")
	require.Contains(t, retrievedSupports, "advanced")
	require.Contains(t, retrievedSupports, "custom")
}
