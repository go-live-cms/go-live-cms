package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Parent and slug rules the admin's Taxonomies screen relies on (#167): a
// parent must be in the same hierarchical type and can't create a cycle,
// parent_id 0 moves a term to the top level, slugs are normalized, and a
// duplicate slug answers 409 with code "slug_taken".
func TestTaxonomyTermParentAndSlugRules(t *testing.T) {
	category := db.TaxonomyType{ID: 1, Name: "category", Label: "Categories", Hierarchical: true}
	tag := db.TaxonomyType{ID: 2, Name: "tag", Label: "Tags", Hierarchical: false}

	// news (10) > world (11) > europe (12); sport (13) is a root
	news := db.TaxonomyTerm{ID: 10, Name: "News", Slug: "news", TaxonomyTypeID: category.ID}
	world := db.TaxonomyTerm{ID: 11, Name: "World", Slug: "world", TaxonomyTypeID: category.ID,
		ParentID: sql.NullInt64{Int64: 10, Valid: true}}
	europe := db.TaxonomyTerm{ID: 12, Name: "Europe", Slug: "europe", TaxonomyTypeID: category.ID,
		ParentID: sql.NullInt64{Int64: 11, Valid: true}}
	sport := db.TaxonomyTerm{ID: 13, Name: "Sport", Slug: "sport", TaxonomyTypeID: category.ID}
	golang := db.TaxonomyTerm{ID: 20, Name: "Go", Slug: "go", TaxonomyTypeID: tag.ID}

	terms := map[int64]db.TaxonomyTerm{10: news, 11: world, 12: europe, 13: sport, 20: golang}
	types := map[int64]db.TaxonomyType{1: category, 2: tag}

	// Every term and type lookup answers from the fixtures above.
	stubLookups := func(store *mockdb.MockStore) {
		store.EXPECT().GetTaxonomyTerm(gomock.Any(), gomock.Any()).AnyTimes().
			DoAndReturn(func(_ any, id int64) (db.TaxonomyTerm, error) {
				if term, ok := terms[id]; ok {
					return term, nil
				}
				return db.TaxonomyTerm{}, sql.ErrNoRows
			})
		store.EXPECT().GetTaxonomyTypeByID(gomock.Any(), gomock.Any()).AnyTimes().
			DoAndReturn(func(_ any, id int64) (db.TaxonomyType, error) {
				if tt, ok := types[id]; ok {
					return tt, nil
				}
				return db.TaxonomyType{}, sql.ErrNoRows
			})
	}

	// The update is echoed back, so responses show what was written.
	echoUpdate := func(store *mockdb.MockStore, check func(arg db.UpdateTaxonomyTermParams)) {
		store.EXPECT().UpdateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(1).
			DoAndReturn(func(_ any, arg db.UpdateTaxonomyTermParams) (db.TaxonomyTerm, error) {
				check(arg)
				return db.TaxonomyTerm{ID: arg.ID, Name: arg.Name, Slug: arg.Slug, ParentID: arg.ParentID}, nil
			})
	}
	noUpdate := func(store *mockdb.MockStore) {
		store.EXPECT().UpdateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
		store.EXPECT().CreateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
	}

	testCases := []struct {
		name       string
		method     string
		path       string
		body       gin.H
		buildStubs func(t *testing.T, store *mockdb.MockStore)
		wantStatus int
		wantError  string
		wantCode   string
	}{
		{
			name:   "UpdateMovesUnderSibling",
			method: http.MethodPut,
			path:   "/api/v1/taxonomy/terms/13",
			body:   gin.H{"parent_id": 10},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				echoUpdate(store, func(arg db.UpdateTaxonomyTermParams) {
					require.Equal(t, sql.NullInt64{Int64: 10, Valid: true}, arg.ParentID)
				})
			},
			wantStatus: http.StatusOK,
		},
		{
			name:   "UpdateParentZeroMovesToTop",
			method: http.MethodPut,
			path:   "/api/v1/taxonomy/terms/12",
			body:   gin.H{"parent_id": 0},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				echoUpdate(store, func(arg db.UpdateTaxonomyTermParams) {
					require.False(t, arg.ParentID.Valid)
				})
			},
			wantStatus: http.StatusOK,
		},
		{
			name:   "UpdateWithoutParentKeepsIt",
			method: http.MethodPut,
			path:   "/api/v1/taxonomy/terms/12",
			body:   gin.H{"name": "Europe & Co"},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				echoUpdate(store, func(arg db.UpdateTaxonomyTermParams) {
					require.Equal(t, europe.ParentID, arg.ParentID)
				})
			},
			wantStatus: http.StatusOK,
		},
		{
			name:   "UpdateNormalizesSlug",
			method: http.MethodPut,
			path:   "/api/v1/taxonomy/terms/13",
			body:   gin.H{"name": "Sport", "slug": "  Team_Sports  News "},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				echoUpdate(store, func(arg db.UpdateTaxonomyTermParams) {
					require.Equal(t, "team-sports-news", arg.Slug)
				})
			},
			wantStatus: http.StatusOK,
		},
		{
			name:   "UpdateEmptyDescriptionClearsIt",
			method: http.MethodPut,
			path:   "/api/v1/taxonomy/terms/13",
			body:   gin.H{"description": ""},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				echoUpdate(store, func(arg db.UpdateTaxonomyTermParams) {
					require.Equal(t, sql.NullString{String: "", Valid: true}, arg.Description)
				})
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "UpdateSelfAsParent",
			method:     http.MethodPut,
			path:       "/api/v1/taxonomy/terms/13",
			body:       gin.H{"parent_id": 13},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "a term can't be its own parent",
		},
		{
			name:       "UpdateUnderOwnDescendant",
			method:     http.MethodPut,
			path:       "/api/v1/taxonomy/terms/10",
			body:       gin.H{"parent_id": 12},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "a term can't be moved under one of its own children",
		},
		{
			name:       "UpdateParentFromOtherType",
			method:     http.MethodPut,
			path:       "/api/v1/taxonomy/terms/13",
			body:       gin.H{"parent_id": 20},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "parent term must belong to the same taxonomy type",
		},
		{
			name:       "UpdateParentMissing",
			method:     http.MethodPut,
			path:       "/api/v1/taxonomy/terms/13",
			body:       gin.H{"parent_id": 999},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "parent term not found",
		},
		{
			name:       "UpdateFlatTypeRejectsParent",
			method:     http.MethodPut,
			path:       "/api/v1/taxonomy/terms/20",
			body:       gin.H{"parent_id": 10},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "terms of this taxonomy type can't have a parent",
		},
		{
			name:       "UpdateBlankSlug",
			method:     http.MethodPut,
			path:       "/api/v1/taxonomy/terms/13",
			body:       gin.H{"name": "  ", "slug": "   "},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "slug can't be empty",
		},
		{
			name:   "UpdateSlugTaken",
			method: http.MethodPut,
			path:   "/api/v1/taxonomy/terms/13",
			body:   gin.H{"slug": "news"},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().UpdateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(1).
					Return(db.TaxonomyTerm{}, errors.New(`pq: duplicate key value violates unique constraint "taxonomy_terms_slug_key"`))
			},
			wantStatus: http.StatusConflict,
			wantCode:   "slug_taken",
		},
		{
			name:   "CreateParentZeroIsTopLevel",
			method: http.MethodPost,
			path:   "/api/v1/taxonomy/terms",
			body:   gin.H{"name": "Tech", "taxonomy_type_id": 1, "parent_id": 0},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().CreateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(1).
					DoAndReturn(func(_ any, arg db.CreateTaxonomyTermParams) (db.TaxonomyTerm, error) {
						require.False(t, arg.ParentID.Valid)
						require.Equal(t, "tech", arg.Slug)
						return db.TaxonomyTerm{ID: 30, Name: arg.Name, Slug: arg.Slug, TaxonomyTypeID: 1}, nil
					})
			},
			wantStatus: http.StatusCreated,
		},
		{
			name:       "CreateParentFromOtherType",
			method:     http.MethodPost,
			path:       "/api/v1/taxonomy/terms",
			body:       gin.H{"name": "Tech", "taxonomy_type_id": 1, "parent_id": 20},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "parent term must belong to the same taxonomy type",
		},
		{
			name:       "CreateFlatTypeRejectsParent",
			method:     http.MethodPost,
			path:       "/api/v1/taxonomy/terms",
			body:       gin.H{"name": "Golang", "taxonomy_type_id": 2, "parent_id": 20},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) { noUpdate(store) },
			wantStatus: http.StatusBadRequest,
			wantError:  "terms of this taxonomy type can't have a parent",
		},
		{
			name:   "CreateSlugTaken",
			method: http.MethodPost,
			path:   "/api/v1/taxonomy/terms",
			body:   gin.H{"name": "News", "taxonomy_type_id": 1},
			buildStubs: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().CreateTaxonomyTerm(gomock.Any(), gomock.Any()).Times(1).
					Return(db.TaxonomyTerm{}, errors.New(`pq: duplicate key value violates unique constraint "taxonomy_terms_slug_key"`))
			},
			wantStatus: http.StatusConflict,
			wantCode:   "slug_taken",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			stubLookups(store)
			tc.buildStubs(t, store)
			editor := randomUserNew()
			editor.Role = RoleEditor
			stubRoleLookup(store, editor)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)
			request, err := http.NewRequest(tc.method, tc.path, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)

			server.router.ServeHTTP(recorder, request)

			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			var body struct {
				Error string `json:"error"`
				Code  string `json:"code"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			if tc.wantError != "" {
				require.Equal(t, tc.wantError, body.Error)
			}
			if tc.wantCode != "" {
				require.Equal(t, tc.wantCode, body.Code)
			}
		})
	}
}

// PUT/DELETE /posts/:id/taxonomy-terms/:term_id change one assignment and never
// touch the post row or its other terms (the mock fails on any other call).
func TestPostTaxonomyTermAssignment(t *testing.T) {
	post := db.Post{ID: 251, Title: "A post"}
	term := db.TaxonomyTerm{ID: 7, Name: "News", Slug: "news", TaxonomyTypeID: 1}
	duplicate := errors.New(`pq: duplicate key value violates unique constraint "unique_post_taxonomy_term"`)
	link := db.AddPostToTaxonomyTermParams{PostID: post.ID, TaxonomyTermID: term.ID}

	testCases := []struct {
		name       string
		method     string
		path       string
		role       string
		buildStubs func(store *mockdb.MockStore)
		wantStatus int
	}{
		{
			name:   "AddOK",
			method: http.MethodPut,
			path:   "/api/v1/posts/251/taxonomy-terms/7",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
				store.EXPECT().GetTaxonomyTerm(gomock.Any(), term.ID).Return(term, nil)
				store.EXPECT().AddPostToTaxonomyTerm(gomock.Any(), link).Return(db.PostTaxonomyRelationship{}, nil)
			},
			wantStatus: http.StatusOK,
		},
		{
			name:   "AddAlreadyAssigned",
			method: http.MethodPut,
			path:   "/api/v1/posts/251/taxonomy-terms/7",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
				store.EXPECT().GetTaxonomyTerm(gomock.Any(), term.ID).Return(term, nil)
				store.EXPECT().AddPostToTaxonomyTerm(gomock.Any(), link).Return(db.PostTaxonomyRelationship{}, duplicate)
			},
			wantStatus: http.StatusOK,
		},
		{
			name:   "AddPostNotFound",
			method: http.MethodPut,
			path:   "/api/v1/posts/251/taxonomy-terms/7",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), post.ID).Return(db.Post{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "AddTermNotFound",
			method: http.MethodPut,
			path:   "/api/v1/posts/251/taxonomy-terms/7",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
				store.EXPECT().GetTaxonomyTerm(gomock.Any(), term.ID).Return(db.TaxonomyTerm{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "AddInvalidTermID",
			method:     http.MethodPut,
			path:       "/api/v1/posts/251/taxonomy-terms/abc",
			buildStubs: func(store *mockdb.MockStore) {},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "RemoveOK",
			method: http.MethodDelete,
			path:   "/api/v1/posts/251/taxonomy-terms/7",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
				store.EXPECT().RemovePostFromTaxonomyTerm(gomock.Any(), db.RemovePostFromTaxonomyTermParams(link)).Return(nil)
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "ContributorForbidden",
			method:     http.MethodPut,
			path:       "/api/v1/posts/251/taxonomy-terms/7",
			role:       RoleContributor,
			buildStubs: func(store *mockdb.MockStore) {},
			wantStatus: http.StatusForbidden,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			caller := randomUserNew()
			caller.Role = RoleEditor
			if tc.role != "" {
				caller.Role = tc.role
			}
			stubRoleLookup(store, caller)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()
			request, err := http.NewRequest(tc.method, tc.path, nil)
			require.NoError(t, err)
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)

			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
		})
	}
}

// A contributor can read terms but not write them.
func TestTaxonomyTermWritesRequireContentEditor(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			contributor := randomUserNew()
			contributor.Role = RoleContributor
			stubRoleLookup(store, contributor)
			store.EXPECT().GetTaxonomyTerm(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().GetTaxonomyTypeByID(gomock.Any(), gomock.Any()).Times(0)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			path := "/api/v1/taxonomy/terms"
			if method != http.MethodPost {
				path = fmt.Sprintf("%s/%d", path, 13)
			}
			request, err := http.NewRequest(method, path, bytes.NewReader([]byte(`{"name":"News","taxonomy_type_id":1}`)))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")
			addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, contributor.ID, contributor.Username, time.Minute)

			server.router.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusForbidden, recorder.Code)
		})
	}
}
