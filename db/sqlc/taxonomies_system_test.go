package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/stretchr/testify/require"
)

func createTestTaxonomyType(t *testing.T, name, label string, hierarchical bool) TaxonomyType {

	timestamp := time.Now().Format("20060102150405")
	uniqueName := fmt.Sprintf("%s_%s", name, timestamp)

	arg := CreateTaxonomyTypeParams{
		Name:         uniqueName,
		Label:        label,
		Description:  sql.NullString{String: fmt.Sprintf("Test %s taxonomy", label), Valid: true},
		Hierarchical: hierarchical,
		Public:       true,
		ShowUi:       true,
		ShowInMenu:   true,
	}

	taxonomyType, err := testQueries.CreateTaxonomyType(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, taxonomyType)
	require.Equal(t, arg.Name, taxonomyType.Name)
	require.Equal(t, arg.Label, taxonomyType.Label)

	return taxonomyType
}

func createTestTaxonomyTerm(t *testing.T, taxonomyTypeID int64) TaxonomyTerm {
	gofakeit.Seed(0)

	name := gofakeit.Word()
	slug := strings.ToLower(name)

	arg := CreateTaxonomyTermParams{
		Name:           name,
		Slug:           slug,
		Description:    sql.NullString{String: gofakeit.Sentence(10), Valid: true},
		TaxonomyTypeID: taxonomyTypeID,
		SortOrder:      sql.NullInt32{Int32: 0, Valid: true},
	}

	taxonomyTerm, err := testQueries.CreateTaxonomyTerm(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, taxonomyTerm)
	require.Equal(t, arg.Name, taxonomyTerm.Name)
	require.Equal(t, arg.Slug, taxonomyTerm.Slug)
	require.Equal(t, arg.TaxonomyTypeID, taxonomyTerm.TaxonomyTypeID)

	return taxonomyTerm
}

func TestListTaxonomyTermsByType(t *testing.T) {

	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(8)

	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_category_%s", suffix), "Test Category", true)

	for range 10 {
		createTestTaxonomyTerm(t, taxonomyType.ID)
	}

	terms, err := testQueries.ListTaxonomyTermsByType(context.Background(), ListTaxonomyTermsByTypeParams{
		Name:        taxonomyType.Name,
		SortBy:      "",
		OffsetCount: 5,
		LimitCount:  5,
	})
	require.NoError(t, err)
	require.Len(t, terms, 5)

	for _, term := range terms {
		require.NotEmpty(t, term)
		require.NotZero(t, term.ID)
		require.NotEmpty(t, term.Name)
		require.Equal(t, taxonomyType.ID, term.TaxonomyTypeID)
	}
}

func TestUpdateTaxonomyTerm(t *testing.T) {
	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(8)

	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_tag_%s", suffix), "Test Tag", false)
	term1 := createTestTaxonomyTerm(t, taxonomyType.ID)

	newName := gofakeit.Word()
	newSlug := strings.ToLower(newName)
	newDescription := gofakeit.Sentence(15)

	arg := UpdateTaxonomyTermParams{
		ID:          term1.ID,
		Name:        newName,
		Slug:        newSlug,
		Description: sql.NullString{String: newDescription, Valid: true},
	}

	term2, err := testQueries.UpdateTaxonomyTerm(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, term2)
	require.Equal(t, term1.ID, term2.ID)
	require.Equal(t, newName, term2.Name)
	require.Equal(t, newSlug, term2.Slug)
	require.Equal(t, newDescription, term2.Description.String)
}

func TestPostTaxonomyRelationship(t *testing.T) {
	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(8)

	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_category_%s", suffix), "Test Category", true)
	term := createTestTaxonomyTerm(t, taxonomyType.ID)
	_, post := createTestUserWithPosts(t)

	relationship, err := testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post.Post.ID,
		TaxonomyTermID: term.ID,
	})
	require.NoError(t, err)
	require.Equal(t, post.Post.ID, relationship.PostID)
	require.Equal(t, term.ID, relationship.TaxonomyTermID)

	postTerms, err := testQueries.GetPostTaxonomyTerms(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTerms, 1)
	require.Equal(t, term.ID, postTerms[0].ID)

	termPosts, err := testQueries.GetPostsByTaxonomyTerm(context.Background(), GetPostsByTaxonomyTermParams{
		TaxonomyTermID: term.ID,
		Column2:        "",
		SortBy:         "",
		OffsetCount:    0,
		LimitCount:     10,
	})
	require.NoError(t, err)
	require.Len(t, termPosts, 1)
	require.Equal(t, post.Post.ID, termPosts[0].ID)

	err = testQueries.RemovePostFromTaxonomyTerm(context.Background(), RemovePostFromTaxonomyTermParams{
		PostID:         post.Post.ID,
		TaxonomyTermID: term.ID,
	})
	require.NoError(t, err)

	postTerms, err = testQueries.GetPostTaxonomyTerms(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTerms, 0)
}

func TestCreatePostWithTaxonomyTermsTx(t *testing.T) {
	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(8)

	user := createTestUser(t)
	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_category_%s", suffix), "Test Category", true)
	term1 := createTestTaxonomyTerm(t, taxonomyType.ID)

	gofakeit.Seed(1)
	term2 := createTestTaxonomyTerm(t, taxonomyType.ID)

	title := gofakeit.Sentence(3)
	slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

	arg := CreatePostWithTaxonomyTermsTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", slug),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{},
			MenuOrder:   0,
		},
		AuthorIDs:       []int64{user.ID},
		TaxonomyTermIDs: []int64{term1.ID, term2.ID},
	}

	result, err := testStore.CreatePostWithTaxonomyTermsTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.Post)
	require.Len(t, result.UserPosts, 1)
	require.Len(t, result.PostTaxonomyRelationships, 2)

	postTerms, err := testQueries.GetPostTaxonomyTerms(context.Background(), result.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTerms, 2)
}

func TestDeleteTaxonomyTermTx(t *testing.T) {
	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(8)

	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_category_%s", suffix), "Test Category", true)
	term := createTestTaxonomyTerm(t, taxonomyType.ID)
	_, post := createTestUserWithPosts(t)

	_, err := testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post.Post.ID,
		TaxonomyTermID: term.ID,
	})
	require.NoError(t, err)

	err = testStore.DeleteTaxonomyTermTx(context.Background(), term.ID)
	require.NoError(t, err)

	deletedTerm, err := testQueries.GetTaxonomyTerm(context.Background(), term.ID)
	require.Error(t, err)
	require.Empty(t, deletedTerm)

	postTerms, err := testQueries.GetPostTaxonomyTerms(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTerms, 0)
}

func TestUpdatePostTaxonomyTermsTx(t *testing.T) {
	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(8)

	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_category_%s", suffix), "Test Category", true)
	term1 := createTestTaxonomyTerm(t, taxonomyType.ID)

	gofakeit.Seed(1)
	term2 := createTestTaxonomyTerm(t, taxonomyType.ID)

	gofakeit.Seed(2)
	term3 := createTestTaxonomyTerm(t, taxonomyType.ID)

	_, post := createTestUserWithPosts(t)

	_, err := testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post.Post.ID,
		TaxonomyTermID: term1.ID,
	})
	require.NoError(t, err)

	err = testStore.UpdatePostTaxonomyTermsTx(context.Background(), UpdatePostTaxonomyTermsTxParams{
		PostID:          post.Post.ID,
		TaxonomyTermIDs: []int64{term2.ID, term3.ID},
	})
	require.NoError(t, err)

	postTerms, err := testQueries.GetPostTaxonomyTerms(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTerms, 2)

	termIDs := make([]int64, len(postTerms))
	for i, pt := range postTerms {
		termIDs[i] = pt.ID
	}
	require.ElementsMatch(t, []int64{term2.ID, term3.ID}, termIDs)
}

func TestCreateTaxonomyTermAndLinkTx(t *testing.T) {
	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(8)

	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_category_%s", suffix), "Test Category", true)
	_, post := createTestUserWithPosts(t)

	name := "Technology"
	slug := "technology"
	description := "Tech-related posts"

	arg := CreateTaxonomyTermAndLinkTxParams{
		CreateTaxonomyTermParams: CreateTaxonomyTermParams{
			Name:           name,
			Slug:           slug,
			Description:    sql.NullString{String: description, Valid: true},
			TaxonomyTypeID: taxonomyType.ID,
			SortOrder:      sql.NullInt32{Int32: 0, Valid: true},
		},
		PostID: post.Post.ID,
	}

	result, err := testStore.CreateTaxonomyTermAndLinkTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.TaxonomyTerm)
	require.Equal(t, name, result.TaxonomyTerm.Name)
	require.Equal(t, slug, result.TaxonomyTerm.Slug)
	require.Equal(t, description, result.TaxonomyTerm.Description.String)
	require.Equal(t, post.Post.ID, result.PostTaxonomyRelationship.PostID)
	require.Equal(t, result.TaxonomyTerm.ID, result.PostTaxonomyRelationship.TaxonomyTermID)

	postTerms, err := testQueries.GetPostTaxonomyTerms(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTerms, 1)
	require.Equal(t, result.TaxonomyTerm.ID, postTerms[0].ID)
}

func TestSearchTaxonomyTerms(t *testing.T) {
	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(5)

	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_search_%s", suffix), "Test Search", false)

	js := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("JavaScript_%s", suffix), "JS programming posts")
	java := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Java_%s", suffix), "Java programming posts")
	tech := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Technology_%s", suffix), "Tech-related posts")
	health := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Health_%s", suffix), "Health and wellness")

	t.Logf("Created taxonomy terms: %s, %s, %s, %s", js.Name, java.Name, tech.Name, health.Name)

	testCases := []struct {
		name          string
		searchTerm    string
		expectedCount int
		expectedNames []string
	}{
		{
			name:          "Search for suffix should find all 4",
			searchTerm:    suffix,
			expectedCount: 4,
			expectedNames: []string{js.Name, java.Name, tech.Name, health.Name},
		},
		{
			name:          "Search for 'JavaScript' with suffix should find JavaScript only",
			searchTerm:    fmt.Sprintf("javascript_%s", suffix),
			expectedCount: 1,
			expectedNames: []string{js.Name},
		},
		{
			name:          "Search for 'Java_' with suffix should find Java only",
			searchTerm:    fmt.Sprintf("java_%s", suffix),
			expectedCount: 1,
			expectedNames: []string{java.Name},
		},
		{
			name:          "Search for 'Technology' with suffix should find Technology",
			searchTerm:    fmt.Sprintf("technology_%s", suffix),
			expectedCount: 1,
			expectedNames: []string{tech.Name},
		},
		{
			name:          "Search for 'Health' with suffix should find Health",
			searchTerm:    fmt.Sprintf("health_%s", suffix),
			expectedCount: 1,
			expectedNames: []string{health.Name},
		},
		{
			name:          "Search for 'xyz' should find nothing",
			searchTerm:    "xyz_nonexistent_12345",
			expectedCount: 0,
			expectedNames: []string{},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			results, err := testQueries.SearchTaxonomyTerms(context.Background(), SearchTaxonomyTermsParams{
				Name:        taxonomyType.Name,
				Column2:     sql.NullString{String: tc.searchTerm, Valid: true},
				OffsetCount: 0,
				LimitCount:  10,
			})
			require.NoError(t, err)

			t.Logf("Search term: '%s', Found %d results: %+v", tc.searchTerm, len(results), results)

			require.Len(t, results, tc.expectedCount, "Search term: '%s'. Expected %d results, got %d", tc.searchTerm, tc.expectedCount, len(results))

			if tc.expectedCount > 0 {
				actualNames := make([]string, len(results))
				for i, term := range results {
					actualNames[i] = term.Name
				}
				require.ElementsMatch(t, tc.expectedNames, actualNames)
			}
		})
	}
}

func TestTaxonomyTermsWithPostCount(t *testing.T) {
	timestamp := time.Now().Format("20060102150405")
	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_count_%s", timestamp), "Test Count", false)

	tech := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Technology_%s", timestamp), "Tech posts")
	design := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Design_%s", timestamp), "Design posts")
	unused := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Unused_%s", timestamp), "Never used")

	_, post1 := createTestUserWithPosts(t)
	_, post2 := createTestUserWithPosts(t)

	_, err := testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post1.Post.ID,
		TaxonomyTermID: tech.ID,
	})
	require.NoError(t, err)

	_, err = testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post2.Post.ID,
		TaxonomyTermID: tech.ID,
	})
	require.NoError(t, err)

	_, err = testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post1.Post.ID,
		TaxonomyTermID: design.ID,
	})
	require.NoError(t, err)

	results, err := testQueries.GetTaxonomyTermsWithPostCount(context.Background(), GetTaxonomyTermsWithPostCountParams{
		Name:        taxonomyType.Name,
		OffsetCount: 0,
		LimitCount:  50,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(results), 3)

	termCountMap := make(map[string]int64)
	for _, result := range results {
		termCountMap[result.Name] = result.PostCount
	}

	require.Equal(t, int64(2), termCountMap[tech.Name], "Technology term should have 2 posts")
	require.Equal(t, int64(1), termCountMap[design.Name], "Design term should have 1 post")
	require.Equal(t, int64(0), termCountMap[unused.Name], "Unused term should have 0 posts")

	t.Logf("Tech (%s): %d posts", tech.Name, termCountMap[tech.Name])
	t.Logf("Design (%s): %d posts", design.Name, termCountMap[design.Name])
	t.Logf("Unused (%s): %d posts", unused.Name, termCountMap[unused.Name])
}

func TestPopularTaxonomyTerms(t *testing.T) {
	timestamp := time.Now().Format("20060102150405")
	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_popular_%s", timestamp), "Test Popular", false)

	popular := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Popular_%s", timestamp), "Most used")
	moderate := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("Moderate_%s", timestamp), "Some usage")

	_, post1 := createTestUserWithPosts(t)
	_, post2 := createTestUserWithPosts(t)
	_, post3 := createTestUserWithPosts(t)

	for _, post := range []CreatePostTxResult{post1, post2, post3} {
		_, err := testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
			PostID:         post.Post.ID,
			TaxonomyTermID: popular.ID,
		})
		require.NoError(t, err)
	}

	_, err := testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post1.Post.ID,
		TaxonomyTermID: moderate.ID,
	})
	require.NoError(t, err)

	results, err := testQueries.GetPopularTaxonomyTerms(context.Background(), GetPopularTaxonomyTermsParams{
		Name:  taxonomyType.Name,
		Limit: 50,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(results), 2)

	var popularResult, moderateResult *GetPopularTaxonomyTermsRow
	for i := range results {
		if results[i].Name == popular.Name {
			popularResult = &results[i]
		}
		if results[i].Name == moderate.Name {
			moderateResult = &results[i]
		}
	}

	t.Logf("Found %d popular taxonomy terms:", len(results))
	for i, result := range results {
		t.Logf("  %d: %s (%d posts)", i+1, result.Name, result.PostCount)
	}

	require.NotNil(t, popularResult, "Popular term (%s) should be in results", popular.Name)
	require.NotNil(t, moderateResult, "Moderate term (%s) should be in results", moderate.Name)
	require.Equal(t, int64(3), popularResult.PostCount, "Popular term should have 3 posts")
	require.Equal(t, int64(1), moderateResult.PostCount, "Moderate term should have 1 post")

	popularIndex := -1
	moderateIndex := -1
	for i, result := range results {
		if result.Name == popular.Name {
			popularIndex = i
		}
		if result.Name == moderate.Name {
			moderateIndex = i
		}
	}

	if popularIndex != -1 && moderateIndex != -1 {
		require.Less(t, popularIndex, moderateIndex, "Popular term should appear before moderate term in results")
	}

	t.Logf("Popular term found at index %d with %d posts", popularIndex, popularResult.PostCount)
	t.Logf("Moderate term found at index %d with %d posts", moderateIndex, moderateResult.PostCount)
}

func TestCountPostsByTaxonomyTerm(t *testing.T) {
	timestamp := time.Now().Format("20060102150405")
	taxonomyType := createTestTaxonomyType(t, fmt.Sprintf("test_count_posts_%s", timestamp), "Test Count Posts", false)

	term := createTaxonomyTermWithName(t, taxonomyType.ID, fmt.Sprintf("TestTag_%s", timestamp), "Test term")

	count, err := testQueries.CountPostsByTaxonomyTerm(context.Background(), term.ID)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)

	_, post1 := createTestUserWithPosts(t)
	_, post2 := createTestUserWithPosts(t)
	_, post3 := createTestUserWithPosts(t)

	_, err = testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post1.Post.ID,
		TaxonomyTermID: term.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.CountPostsByTaxonomyTerm(context.Background(), term.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	_, err = testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post2.Post.ID,
		TaxonomyTermID: term.ID,
	})
	require.NoError(t, err)

	_, err = testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
		PostID:         post3.Post.ID,
		TaxonomyTermID: term.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.CountPostsByTaxonomyTerm(context.Background(), term.ID)
	require.NoError(t, err)
	require.Equal(t, int64(3), count)

	err = testQueries.RemovePostFromTaxonomyTerm(context.Background(), RemovePostFromTaxonomyTermParams{
		PostID:         post2.Post.ID,
		TaxonomyTermID: term.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.CountPostsByTaxonomyTerm(context.Background(), term.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
}

func createTaxonomyTermWithName(t *testing.T, taxonomyTypeID int64, name, description string) TaxonomyTerm {
	slug := strings.ToLower(strings.ReplaceAll(name, "_", "-"))

	arg := CreateTaxonomyTermParams{
		Name:           name,
		Slug:           slug,
		Description:    sql.NullString{String: description, Valid: true},
		TaxonomyTypeID: taxonomyTypeID,
		SortOrder:      sql.NullInt32{Int32: 0, Valid: true},
	}

	term, err := testQueries.CreateTaxonomyTerm(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, term)
	require.Equal(t, name, term.Name)
	require.Equal(t, slug, term.Slug)
	require.Equal(t, description, term.Description.String)

	return term
}
