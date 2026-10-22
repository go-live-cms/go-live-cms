package devModeUtil

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// recordTerms makes CreateTaxonomyTerm succeed and returns the terms created,
// keyed by type id and name.
func recordTerms(store *mockdb.MockStore) map[int64]map[string]db.CreateTaxonomyTermParams {
	created := map[int64]map[string]db.CreateTaxonomyTermParams{}
	var nextID int64 = 100
	store.EXPECT().
		CreateTaxonomyTerm(gomock.Any(), gomock.Any()).
		AnyTimes().
		DoAndReturn(func(_ context.Context, arg db.CreateTaxonomyTermParams) (db.TaxonomyTerm, error) {
			if created[arg.TaxonomyTypeID] == nil {
				created[arg.TaxonomyTypeID] = map[string]db.CreateTaxonomyTermParams{}
			}
			created[arg.TaxonomyTypeID][arg.Name] = arg
			nextID++
			return db.TaxonomyTerm{ID: nextID, Name: arg.Name, TaxonomyTypeID: arg.TaxonomyTypeID}, nil
		})
	return created
}

// The init migration inserts category, tag and page_category. The seeder
// must reuse them and attach each term to the type with the right name.
func TestCreateDummyTaxonomiesReusesMigrationTypes(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)

	existing := map[string]db.TaxonomyType{
		"category":      {ID: 1, Name: "category", Label: "Categories"},
		"tag":           {ID: 2, Name: "tag", Label: "Tags"},
		"page_category": {ID: 3, Name: "page_category", Label: "Page Categories"},
	}
	for name, taxonomyType := range existing {
		store.EXPECT().GetTaxonomyType(gomock.Any(), gomock.Eq(name)).Times(1).Return(taxonomyType, nil)
	}
	store.EXPECT().CreateTaxonomyType(gomock.Any(), gomock.Any()).Times(0)
	created := recordTerms(store)

	types, terms := createDummyTaxonomies(store)
	require.Len(t, types, 3)
	require.Len(t, terms, 4+12+30+4)

	require.Contains(t, created[1], "Technology")
	require.Contains(t, created[1], "Programming")
	require.True(t, created[1]["Programming"].ParentID.Valid)
	require.Contains(t, created[2], "tutorial")
	require.NotContains(t, created[2], "Technology")
	require.Contains(t, created[3], "Company")
	require.Contains(t, created[3], "Legal")
	require.Len(t, created[1], 16)
	require.Len(t, created[2], 30)
	require.Len(t, created[3], 4)

	// taxonomy_terms.slug is unique across all types, and slugs end up in URLs.
	slugs := map[string]string{}
	for _, byName := range created {
		for name, term := range byName {
			require.Regexp(t, `^[a-z0-9]+(-[a-z0-9]+)*$`, term.Slug, name)
			other, dup := slugs[term.Slug]
			require.False(t, dup, "slug %q used by %q and %q", term.Slug, other, name)
			slugs[term.Slug] = name
		}
	}
	require.Equal(t, "ui-ux", created[1]["UI/UX"].Slug)
}

// A missing type is created; the others are still matched by name, not by
// their position in the result.
func TestCreateDummyTaxonomiesCreatesMissingType(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)

	store.EXPECT().GetTaxonomyType(gomock.Any(), gomock.Eq("category")).Times(1).Return(db.TaxonomyType{}, sql.ErrNoRows)
	store.EXPECT().
		CreateTaxonomyType(gomock.Any(), gomock.Any()).
		Times(1).
		DoAndReturn(func(_ context.Context, arg db.CreateTaxonomyTypeParams) (db.TaxonomyType, error) {
			require.Equal(t, "category", arg.Name)
			require.True(t, arg.Hierarchical)
			return db.TaxonomyType{ID: 7, Name: arg.Name, Label: arg.Label}, nil
		})
	// A lookup failure other than "not found" skips that type, and only it.
	store.EXPECT().GetTaxonomyType(gomock.Any(), gomock.Eq("tag")).Times(1).Return(db.TaxonomyType{}, errors.New("boom"))
	store.EXPECT().GetTaxonomyType(gomock.Any(), gomock.Eq("page_category")).Times(1).
		Return(db.TaxonomyType{ID: 3, Name: "page_category"}, nil)
	created := recordTerms(store)

	types, _ := createDummyTaxonomies(store)
	require.Len(t, types, 2)
	require.Len(t, created[7], 16)
	require.Contains(t, created[7], "Technology")
	require.Len(t, created[3], 4)
	require.Contains(t, created[3], "Company")
	require.Len(t, created, 2)
}
