package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/stretchr/testify/require"
)

func createTestTaxonomy(t *testing.T) Taxonomy {
	gofakeit.Seed(0)

	arg := CreateTaxonomyParams{
		Name:        gofakeit.Word(),
		Description: gofakeit.Sentence(10),
	}

	taxonomy, err := testQueries.CreateTaxonomy(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, taxonomy)
	require.Equal(t, arg.Name, taxonomy.Name)
	require.Equal(t, arg.Description, taxonomy.Description)
	require.NotZero(t, taxonomy.ID)

	return taxonomy
}

func TestListTaxonomies(t *testing.T) {
	for range 10 {
		createTestTaxonomy(t)
	}

	taxonomies, err := testQueries.ListTaxonomies(context.Background(), ListTaxonomiesParams{
		SortBy:      "",
		OffsetCount: 5,
		LimitCount:  5,
	})
	require.NoError(t, err)
	require.Len(t, taxonomies, 5)

	for _, taxonomy := range taxonomies {
		require.NotEmpty(t, taxonomy)
		require.NotZero(t, taxonomy.ID)
		require.NotEmpty(t, taxonomy.Name)
		require.NotEmpty(t, taxonomy.Description)
	}
}

func TestUpdateTaxonomy(t *testing.T) {
	taxonomy1 := createTestTaxonomy(t)

	newName := gofakeit.Word()
	newDescription := gofakeit.Sentence(15)

	arg := UpdateTaxonomyParams{
		ID:          taxonomy1.ID,
		Name:        newName,
		Description: newDescription,
	}

	taxonomy2, err := testQueries.UpdateTaxonomy(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, taxonomy2)
	require.Equal(t, taxonomy1.ID, taxonomy2.ID)
	require.Equal(t, newName, taxonomy2.Name)
	require.Equal(t, newDescription, taxonomy2.Description)
}

func TestPostTaxonomyRelationship(t *testing.T) {
	taxonomy := createTestTaxonomy(t)
	_, post := createTestUserWithPosts(t)

	relationship, err := testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)
	require.Equal(t, post.Post.ID, relationship.PostID)
	require.Equal(t, taxonomy.ID, relationship.TaxonomyID)

	postTaxonomies, err := testQueries.GetPostTaxonomies(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTaxonomies, 1)
	require.Equal(t, taxonomy.ID, postTaxonomies[0].ID)

	taxonomyPosts, err := testQueries.GetTaxonomyPosts(context.Background(), GetTaxonomyPostsParams{
		TaxonomyID: taxonomy.ID,
		Limit:      10,
		Offset:     0,
	})
	require.NoError(t, err)
	require.Len(t, taxonomyPosts, 1)
	require.Equal(t, post.Post.ID, taxonomyPosts[0].ID)

	err = testQueries.DeletePostTaxonomy(context.Background(), DeletePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)

	postTaxonomies, err = testQueries.GetPostTaxonomies(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTaxonomies, 0)
}

func TestCreatePostWithTaxonomiesTx(t *testing.T) {
	user := createTestUser(t)
	taxonomy1 := createTestTaxonomy(t)

	gofakeit.Seed(1)
	taxonomy2 := createTestTaxonomy(t)

	title := gofakeit.Sentence(3)
	slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

	arg := CreatePostWithTaxonomiesTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", slug),
		},
		AuthorIDs:   []int64{user.ID},
		TaxonomyIDs: []int64{taxonomy1.ID, taxonomy2.ID},
	}

	result, err := testStore.CreatePostWithTaxonomiesTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.Post)
	require.Len(t, result.UserPosts, 1)
	require.Len(t, result.PostTaxonomies, 2)

	postTaxonomies, err := testQueries.GetPostTaxonomies(context.Background(), result.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTaxonomies, 2)
}

func TestDeleteTaxonomyTx(t *testing.T) {
	taxonomy := createTestTaxonomy(t)
	_, post := createTestUserWithPosts(t)

	_, err := testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)

	err = testStore.DeleteTaxonomyTx(context.Background(), taxonomy.ID)
	require.NoError(t, err)

	deletedTaxonomy, err := testQueries.GetTaxonomy(context.Background(), taxonomy.ID)
	require.Error(t, err)
	require.Empty(t, deletedTaxonomy)

	postTaxonomies, err := testQueries.GetPostTaxonomies(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTaxonomies, 0)
}

func TestUpdatePostTaxonomiesTx(t *testing.T) {
	taxonomy1 := createTestTaxonomy(t)

	gofakeit.Seed(1)
	taxonomy2 := createTestTaxonomy(t)

	gofakeit.Seed(2)
	taxonomy3 := createTestTaxonomy(t)

	_, post := createTestUserWithPosts(t)

	_, err := testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: taxonomy1.ID,
	})
	require.NoError(t, err)

	err = testStore.UpdatePostTaxonomiesTx(context.Background(), UpdatePostTaxonomiesTxParams{
		PostID:      post.Post.ID,
		TaxonomyIDs: []int64{taxonomy2.ID, taxonomy3.ID},
	})
	require.NoError(t, err)

	postTaxonomies, err := testQueries.GetPostTaxonomies(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTaxonomies, 2)

	taxonomyIDs := make([]int64, len(postTaxonomies))
	for i, pt := range postTaxonomies {
		taxonomyIDs[i] = pt.ID
	}
	require.ElementsMatch(t, []int64{taxonomy2.ID, taxonomy3.ID}, taxonomyIDs)
}

func TestCreateTaxonomyAndLinkTx(t *testing.T) {
	_, post := createTestUserWithPosts(t)

	arg := CreateTaxonomyAndLinkTxParams{
		Name:        "Technology",
		Description: "Tech-related posts",
		PostID:      post.Post.ID,
	}

	result, err := testStore.CreateTaxonomyAndLinkTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.Taxonomy)
	require.Equal(t, arg.Name, result.Taxonomy.Name)
	require.Equal(t, arg.Description, result.Taxonomy.Description)
	require.Equal(t, post.Post.ID, result.PostTaxonomy.PostID)
	require.Equal(t, result.Taxonomy.ID, result.PostTaxonomy.TaxonomyID)

	postTaxonomies, err := testQueries.GetPostTaxonomies(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTaxonomies, 1)
	require.Equal(t, result.Taxonomy.ID, postTaxonomies[0].ID)
}

func TestCreateTaxonomyAndLinkTx_ExistingTaxonomy(t *testing.T) {
	existingTaxonomy := createTestTaxonomy(t)
	_, post := createTestUserWithPosts(t)

	arg := CreateTaxonomyAndLinkTxParams{
		Name:        existingTaxonomy.Name,
		Description: "Different description",
		PostID:      post.Post.ID,
	}

	result, err := testStore.CreateTaxonomyAndLinkTx(context.Background(), arg)
	require.NoError(t, err)
	require.Equal(t, existingTaxonomy.ID, result.Taxonomy.ID)
	require.Equal(t, existingTaxonomy.Name, result.Taxonomy.Name)
	require.Equal(t, existingTaxonomy.Description, result.Taxonomy.Description)
}

func TestCreateTaxonomyAndLinkTx_DuplicateLink(t *testing.T) {
	taxonomy := createTestTaxonomy(t)
	_, post := createTestUserWithPosts(t)

	_, err := testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)

	arg := CreateTaxonomyAndLinkTxParams{
		Name:        taxonomy.Name,
		Description: taxonomy.Description,
		PostID:      post.Post.ID,
	}

	result, err := testStore.CreateTaxonomyAndLinkTx(context.Background(), arg)
	require.NoError(t, err)
	require.Equal(t, taxonomy.ID, result.Taxonomy.ID)

	postTaxonomies, err := testQueries.GetPostTaxonomies(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postTaxonomies, 1)
}

func TestSearchTaxonomiesByName(t *testing.T) {

	gofakeit.Seed(time.Now().UnixNano())
	suffix := gofakeit.LetterN(5)

	js := createTaxonomyWithName(t, fmt.Sprintf("JavaScript_%s", suffix), "JS programming posts")
	java := createTaxonomyWithName(t, fmt.Sprintf("Java_%s", suffix), "Java programming posts")
	tech := createTaxonomyWithName(t, fmt.Sprintf("Technology_%s", suffix), "Tech-related posts")
	health := createTaxonomyWithName(t, fmt.Sprintf("Health_%s", suffix), "Health and wellness")

	t.Logf("Created taxonomies: %s, %s, %s, %s", js.Name, java.Name, tech.Name, health.Name)

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
			results, err := testQueries.SearchTaxonomiesByName(context.Background(), SearchTaxonomiesByNameParams{
				Column1:     sql.NullString{String: tc.searchTerm, Valid: true},
				SortBy:      "",
				OffsetCount: 0,
				LimitCount:  10,
			})
			require.NoError(t, err)

			t.Logf("Search term: '%s', Found %d results: %+v", tc.searchTerm, len(results), results)

			require.Len(t, results, tc.expectedCount, "Search term: '%s'. Expected %d results, got %d", tc.searchTerm, tc.expectedCount, len(results))

			if tc.expectedCount > 0 {
				actualNames := make([]string, len(results))
				for i, taxonomy := range results {
					actualNames[i] = taxonomy.Name
				}
				require.ElementsMatch(t, tc.expectedNames, actualNames)
			}
		})
	}
}

func TestListTaxonomiesWithPostCount(t *testing.T) {

	timestamp := time.Now().Format("20060102150405")

	tech := createTaxonomyWithName(t, fmt.Sprintf("Technology_%s", timestamp), "Tech posts")
	design := createTaxonomyWithName(t, fmt.Sprintf("Design_%s", timestamp), "Design posts")
	unused := createTaxonomyWithName(t, fmt.Sprintf("Unused_%s", timestamp), "Never used")

	_, post1 := createTestUserWithPosts(t)
	_, post2 := createTestUserWithPosts(t)

	_, err := testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post1.Post.ID,
		TaxonomyID: tech.ID,
	})
	require.NoError(t, err)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post2.Post.ID,
		TaxonomyID: tech.ID,
	})
	require.NoError(t, err)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post1.Post.ID,
		TaxonomyID: design.ID,
	})
	require.NoError(t, err)

	results, err := testQueries.ListTaxonomiesWithPostCount(context.Background(), ListTaxonomiesWithPostCountParams{
		SortBy:      "",
		OffsetCount: 0,
		LimitCount:  50,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(results), 3)

	taxonomyCountMap := make(map[string]int64)
	for _, result := range results {
		taxonomyCountMap[result.Name] = result.PostCount
	}

	require.Equal(t, int64(2), taxonomyCountMap[tech.Name], "Technology taxonomy should have 2 posts")
	require.Equal(t, int64(1), taxonomyCountMap[design.Name], "Design taxonomy should have 1 post")
	require.Equal(t, int64(0), taxonomyCountMap[unused.Name], "Unused taxonomy should have 0 posts")

	t.Logf("Tech (%s): %d posts", tech.Name, taxonomyCountMap[tech.Name])
	t.Logf("Design (%s): %d posts", design.Name, taxonomyCountMap[design.Name])
	t.Logf("Unused (%s): %d posts", unused.Name, taxonomyCountMap[unused.Name])
}

func TestGetPopularTaxonomies(t *testing.T) {

	timestamp := time.Now().Format("20060102150405")

	popular := createTaxonomyWithName(t, fmt.Sprintf("Popular_%s", timestamp), "Most used")
	moderate := createTaxonomyWithName(t, fmt.Sprintf("Moderate_%s", timestamp), "Some usage")

	_, post1 := createTestUserWithPosts(t)
	_, post2 := createTestUserWithPosts(t)
	_, post3 := createTestUserWithPosts(t)

	for _, post := range []CreatePostTxResult{post1, post2, post3} {
		_, err := testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
			PostID:     post.Post.ID,
			TaxonomyID: popular.ID,
		})
		require.NoError(t, err)
	}

	_, err := testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post1.Post.ID,
		TaxonomyID: moderate.ID,
	})
	require.NoError(t, err)

	results, err := testQueries.GetPopularTaxonomies(context.Background(), 50)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(results), 2)

	var popularResult, moderateResult *GetPopularTaxonomiesRow
	for i := range results {
		if results[i].Name == popular.Name {
			popularResult = &results[i]
		}
		if results[i].Name == moderate.Name {
			moderateResult = &results[i]
		}
	}

	t.Logf("Found %d popular taxonomies:", len(results))
	for i, result := range results {
		t.Logf("  %d: %s (%d posts)", i+1, result.Name, result.PostCount)
	}

	require.NotNil(t, popularResult, "Popular taxonomy (%s) should be in results", popular.Name)
	require.NotNil(t, moderateResult, "Moderate taxonomy (%s) should be in results", moderate.Name)
	require.Equal(t, int64(3), popularResult.PostCount, "Popular taxonomy should have 3 posts")
	require.Equal(t, int64(1), moderateResult.PostCount, "Moderate taxonomy should have 1 post")

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
		require.Less(t, popularIndex, moderateIndex, "Popular taxonomy should appear before moderate taxonomy in results")
	}

	t.Logf("Popular taxonomy found at index %d with %d posts", popularIndex, popularResult.PostCount)
	t.Logf("Moderate taxonomy found at index %d with %d posts", moderateIndex, moderateResult.PostCount)
}

func TestGetTaxonomyPostCount(t *testing.T) {

	timestamp := time.Now().Format("20060102150405")

	taxonomy := createTaxonomyWithName(t, fmt.Sprintf("TestTag_%s", timestamp), "Test taxonomy")

	count, err := testQueries.GetTaxonomyPostCount(context.Background(), taxonomy.ID)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)

	_, post1 := createTestUserWithPosts(t)
	_, post2 := createTestUserWithPosts(t)
	_, post3 := createTestUserWithPosts(t)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post1.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.GetTaxonomyPostCount(context.Background(), taxonomy.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post2.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post3.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.GetTaxonomyPostCount(context.Background(), taxonomy.ID)
	require.NoError(t, err)
	require.Equal(t, int64(3), count)

	err = testQueries.DeletePostTaxonomy(context.Background(), DeletePostTaxonomyParams{
		PostID:     post2.Post.ID,
		TaxonomyID: taxonomy.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.GetTaxonomyPostCount(context.Background(), taxonomy.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
}

func createTaxonomyWithName(t *testing.T, name, description string) Taxonomy {
	arg := CreateTaxonomyParams{
		Name:        name,
		Description: description,
	}

	taxonomy, err := testQueries.CreateTaxonomy(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, taxonomy)
	require.Equal(t, arg.Name, taxonomy.Name)
	require.Equal(t, arg.Description, taxonomy.Description)
	require.NotZero(t, taxonomy.ID)

	return taxonomy
}

func TestGetPostTaxonomyCount(t *testing.T) {

	timestamp := time.Now().Format("20060102150405")

	tax1 := createTaxonomyWithName(t, fmt.Sprintf("Tag1_%s", timestamp), "First tag")
	tax2 := createTaxonomyWithName(t, fmt.Sprintf("Tag2_%s", timestamp), "Second tag")
	tax3 := createTaxonomyWithName(t, fmt.Sprintf("Tag3_%s", timestamp), "Third tag")

	_, post := createTestUserWithPosts(t)

	count, err := testQueries.GetPostTaxonomyCount(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: tax1.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.GetPostTaxonomyCount(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: tax2.ID,
	})
	require.NoError(t, err)

	_, err = testQueries.CreatePostTaxonomy(context.Background(), CreatePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: tax3.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.GetPostTaxonomyCount(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Equal(t, int64(3), count)

	err = testQueries.DeletePostTaxonomy(context.Background(), DeletePostTaxonomyParams{
		PostID:     post.Post.ID,
		TaxonomyID: tax2.ID,
	})
	require.NoError(t, err)

	count, err = testQueries.GetPostTaxonomyCount(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
}
