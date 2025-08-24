package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

func randomTaxonomyType() db.TaxonomyType {
	gofakeit.Seed(0)
	return db.TaxonomyType{
		ID:           gofakeit.Int64(),
		Name:         gofakeit.BuzzWord(),
		Label:        gofakeit.Word(),
		Description:  sql.NullString{String: gofakeit.Sentence(10), Valid: true},
		Hierarchical: gofakeit.Bool(),
		Public:       gofakeit.Bool(),
		ShowUi:       gofakeit.Bool(),
		ShowInMenu:   gofakeit.Bool(),
		CreatedAt:    time.Now(),
	}
}

func randomTaxonomyTerm() db.TaxonomyTerm {
	gofakeit.Seed(0)
	metaJSON, _ := json.Marshal(map[string]interface{}{
		"color": gofakeit.HexColor(),
		"icon":  gofakeit.Emoji(),
	})
	return db.TaxonomyTerm{
		ID:             gofakeit.Int64(),
		Name:           gofakeit.BuzzWord(),
		Slug:           gofakeit.Word(),
		Description:    sql.NullString{String: gofakeit.Sentence(10), Valid: true},
		ParentID:       sql.NullInt64{Int64: 0, Valid: false},
		TaxonomyTypeID: gofakeit.Int64(),
		SortOrder:      sql.NullInt32{Int32: int32(gofakeit.Number(1, 100)), Valid: true},
		Meta:           pqtype.NullRawMessage{RawMessage: metaJSON, Valid: true},
		CreatedAt:      time.Now(),
	}
}

func TestCreateTaxonomyTypeAPI(t *testing.T) {
	taxonomyType := randomTaxonomyType()
	user := randomUserNew()

	testCases := []struct {
		name          string
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: gin.H{
				"name":         taxonomyType.Name,
				"label":        taxonomyType.Label,
				"description":  taxonomyType.Description.String,
				"hierarchical": taxonomyType.Hierarchical,
				"public":       taxonomyType.Public,
				"show_ui":      taxonomyType.ShowUi,
				"show_in_menu": taxonomyType.ShowInMenu,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Eq(taxonomyType.Name)).
					Times(1).
					Return(db.TaxonomyType{}, sql.ErrNoRows)

				arg := db.CreateTaxonomyTypeParams{
					Name:         taxonomyType.Name,
					Label:        taxonomyType.Label,
					Description:  taxonomyType.Description,
					Hierarchical: taxonomyType.Hierarchical,
					Public:       taxonomyType.Public,
					ShowUi:       taxonomyType.ShowUi,
					ShowInMenu:   taxonomyType.ShowInMenu,
				}
				store.EXPECT().
					CreateTaxonomyType(gomock.Any(), gomock.Eq(arg)).
					Times(1).
					Return(taxonomyType, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				requireBodyMatchTaxonomyType(t, recorder.Body.String(), taxonomyType)
			},
		},
		{
			name: "NoAuthorization",
			body: gin.H{
				"name":  taxonomyType.Name,
				"label": taxonomyType.Label,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// No authorization
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "DuplicateName",
			body: gin.H{
				"name":  taxonomyType.Name,
				"label": taxonomyType.Label,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Eq(taxonomyType.Name)).
					Times(1).
					Return(taxonomyType, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name: "InvalidName",
			body: gin.H{
				"name":  "A",
				"label": taxonomyType.Label,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "InvalidLabel",
			body: gin.H{
				"name":  taxonomyType.Name,
				"label": "A",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := "/api/v1/taxonomy-types"
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetTaxonomyTypesAPI(t *testing.T) {
	n := 5
	taxonomyTypes := make([]db.TaxonomyType, n)
	for i := 0; i < n; i++ {
		taxonomyTypes[i] = randomTaxonomyType()
	}

	testCases := []struct {
		name          string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListTaxonomyTypes(gomock.Any()).
					Times(1).
					Return(taxonomyTypes, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchTaxonomyTypes(t, recorder.Body.String(), taxonomyTypes)
			},
		},
		{
			name: "InternalError",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListTaxonomyTypes(gomock.Any()).
					Times(1).
					Return([]db.TaxonomyType{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := "/api/v1/taxonomy-types"
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetTaxonomyTypeAPI(t *testing.T) {
	taxonomyType := randomTaxonomyType()

	testCases := []struct {
		name          string
		typeName      string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:     "OK",
			typeName: taxonomyType.Name,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Eq(taxonomyType.Name)).
					Times(1).
					Return(taxonomyType, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchTaxonomyType(t, recorder.Body.String(), taxonomyType)
			},
		},
		{
			name:     "NotFound",
			typeName: taxonomyType.Name,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Eq(taxonomyType.Name)).
					Times(1).
					Return(db.TaxonomyType{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:     "InternalError",
			typeName: taxonomyType.Name,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Eq(taxonomyType.Name)).
					Times(1).
					Return(db.TaxonomyType{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/taxonomy-types/%s", tc.typeName)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestCreateTaxonomyTermAPI(t *testing.T) {
	taxonomyTerm := randomTaxonomyTerm()
	taxonomyType := randomTaxonomyType()
	user := randomUserNew()

	testCases := []struct {
		name          string
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: gin.H{
				"name":             taxonomyTerm.Name,
				"slug":             taxonomyTerm.Slug,
				"description":      taxonomyTerm.Description.String,
				"taxonomy_type_id": taxonomyTerm.TaxonomyTypeID,
				"sort_order":       taxonomyTerm.SortOrder.Int32,
				"meta":             map[string]interface{}{"color": "#ff0000"},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTypeByID(gomock.Any(), gomock.Eq(taxonomyTerm.TaxonomyTypeID)).
					Times(1).
					Return(taxonomyType, nil)

				store.EXPECT().
					CreateTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(1).
					Return(taxonomyTerm, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				requireBodyMatchTaxonomyTerm(t, recorder.Body.String(), taxonomyTerm)
			},
		},
		{
			name: "NoAuthorization",
			body: gin.H{
				"name":             taxonomyTerm.Name,
				"taxonomy_type_id": taxonomyTerm.TaxonomyTypeID,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// No authorization
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTypeByID(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InvalidTaxonomyType",
			body: gin.H{
				"name":             taxonomyTerm.Name,
				"taxonomy_type_id": taxonomyTerm.TaxonomyTypeID,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTypeByID(gomock.Any(), gomock.Eq(taxonomyTerm.TaxonomyTypeID)).
					Times(1).
					Return(db.TaxonomyType{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "InvalidName",
			body: gin.H{
				"name":             "A",
				"taxonomy_type_id": taxonomyTerm.TaxonomyTypeID,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTypeByID(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "WithParent",
			body: gin.H{
				"name":             taxonomyTerm.Name,
				"taxonomy_type_id": taxonomyTerm.TaxonomyTypeID,
				"parent_id":        int64(123),
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTypeByID(gomock.Any(), gomock.Eq(taxonomyTerm.TaxonomyTypeID)).
					Times(1).
					Return(taxonomyType, nil)

				parentTerm := randomTaxonomyTerm()
				parentTerm.ID = 123
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(int64(123))).
					Times(1).
					Return(parentTerm, nil)

				termWithParent := taxonomyTerm
				termWithParent.ParentID = sql.NullInt64{Int64: 123, Valid: true}
				store.EXPECT().
					CreateTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(1).
					Return(termWithParent, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
			},
		},
		{
			name: "InvalidParent",
			body: gin.H{
				"name":             taxonomyTerm.Name,
				"taxonomy_type_id": taxonomyTerm.TaxonomyTypeID,
				"parent_id":        int64(999),
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTypeByID(gomock.Any(), gomock.Eq(taxonomyTerm.TaxonomyTypeID)).
					Times(1).
					Return(taxonomyType, nil)

				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(int64(999))).
					Times(1).
					Return(db.TaxonomyTerm{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := "/api/v1/taxonomy-terms"
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetTaxonomyTermByIDAPI(t *testing.T) {
	taxonomyTerm := randomTaxonomyTerm()

	testCases := []struct {
		name          string
		termID        int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			termID: taxonomyTerm.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(taxonomyTerm, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchTaxonomyTerm(t, recorder.Body.String(), taxonomyTerm)
			},
		},
		{
			name:   "NotFound",
			termID: taxonomyTerm.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(db.TaxonomyTerm{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			termID: taxonomyTerm.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(db.TaxonomyTerm{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "InvalidID",
			termID: 0, // This will be overridden in the URL generation
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			var url string
			if tc.name == "InvalidID" {
				url = "/api/v1/taxonomy-terms/invalid_id"
			} else {
				url = fmt.Sprintf("/api/v1/taxonomy-terms/%d", tc.termID)
			}
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetTaxonomyTermsByTypeAPI(t *testing.T) {
	taxonomyType := randomTaxonomyType()
	n := 5
	taxonomyTerms := make([]db.ListTaxonomyTermsByTypeRow, n)
	for i := 0; i < n; i++ {
		term := randomTaxonomyTerm()
		taxonomyTerms[i] = db.ListTaxonomyTermsByTypeRow{
			ID:               term.ID,
			Name:             term.Name,
			Slug:             term.Slug,
			Description:      term.Description,
			ParentID:         term.ParentID,
			TaxonomyTypeID:   term.TaxonomyTypeID,
			TaxonomyTypeName: taxonomyType.Name,
			SortOrder:        term.SortOrder,
			Meta:             term.Meta,
			CreatedAt:        term.CreatedAt,
		}
	}

	testCases := []struct {
		name          string
		typeName      string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:     "OK",
			typeName: taxonomyType.Name,
			query:    "?limit=10&offset=0&sort=name_asc",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Eq(taxonomyType.Name)).
					Times(1).
					Return(taxonomyType, nil)

				store.EXPECT().
					ListTaxonomyTermsByType(gomock.Any(), gomock.Any()).
					Times(1).
					Return(taxonomyTerms, nil)

				store.EXPECT().
					CountTaxonomyTerms(gomock.Any(), gomock.Eq(taxonomyType.Name)).
					Times(1).
					Return(int64(len(taxonomyTerms)), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchTaxonomyTermsByType(t, recorder.Body.String(), taxonomyTerms)
			},
		},
		{
			name:     "TaxonomyTypeNotFound",
			typeName: "nonexistent",
			query:    "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Eq("nonexistent")).
					Times(1).
					Return(db.TaxonomyType{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:     "InvalidLimit",
			typeName: taxonomyType.Name,
			query:    "?limit=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "InvalidSort",
			typeName: taxonomyType.Name,
			query:    "?sort=invalid_sort",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyType(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/taxonomy-terms/type/%s%s", tc.typeName, tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetPopularTaxonomyTermsAPI(t *testing.T) {
	taxonomyType := randomTaxonomyType()
	n := 3
	popularTerms := make([]db.GetPopularTaxonomyTermsRow, n)
	for i := 0; i < n; i++ {
		term := randomTaxonomyTerm()
		popularTerms[i] = db.GetPopularTaxonomyTermsRow{
			ID:               term.ID,
			Name:             term.Name,
			Slug:             term.Slug,
			Description:      term.Description,
			ParentID:         term.ParentID,
			TaxonomyTypeID:   term.TaxonomyTypeID,
			TaxonomyTypeName: taxonomyType.Name,
			SortOrder:        term.SortOrder,
			Meta:             term.Meta,
			CreatedAt:        term.CreatedAt,
			PostCount:        int64(10 - i), // Descending order
		}
	}

	testCases := []struct {
		name          string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK",
			query: fmt.Sprintf("?type=%s&limit=5", taxonomyType.Name),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPopularTaxonomyTerms(gomock.Any(), gomock.Any()).
					Times(1).
					Return(popularTerms, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchPopularTaxonomyTerms(t, recorder.Body.String(), popularTerms)
			},
		},
		{
			name:  "MissingType",
			query: "?limit=5",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPopularTaxonomyTerms(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:  "InvalidLimit",
			query: fmt.Sprintf("?type=%s&limit=0", taxonomyType.Name),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPopularTaxonomyTerms(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/taxonomy-terms/popular%s", tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestSearchTaxonomyTermsAPI(t *testing.T) {
	taxonomyType := randomTaxonomyType()
	n := 3
	searchResults := make([]db.SearchTaxonomyTermsRow, n)
	for i := 0; i < n; i++ {
		term := randomTaxonomyTerm()
		searchResults[i] = db.SearchTaxonomyTermsRow{
			ID:               term.ID,
			Name:             term.Name,
			Slug:             term.Slug,
			Description:      term.Description,
			ParentID:         term.ParentID,
			TaxonomyTypeID:   term.TaxonomyTypeID,
			TaxonomyTypeName: taxonomyType.Name,
			SortOrder:        term.SortOrder,
			Meta:             term.Meta,
			CreatedAt:        term.CreatedAt,
		}
	}

	testCases := []struct {
		name          string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK",
			query: fmt.Sprintf("?type=%s&q=test&limit=10&offset=0", taxonomyType.Name),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					SearchTaxonomyTerms(gomock.Any(), gomock.Any()).
					Times(1).
					Return(searchResults, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchSearchTaxonomyTerms(t, recorder.Body.String(), searchResults)
			},
		},
		{
			name:  "MissingType",
			query: "?q=test",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					SearchTaxonomyTerms(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:  "MissingQuery",
			query: fmt.Sprintf("?type=%s", taxonomyType.Name),
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					SearchTaxonomyTerms(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/taxonomy-terms/search%s", tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpdateTaxonomyTermAPI(t *testing.T) {
	taxonomyTerm := randomTaxonomyTerm()
	user := randomUserNew()

	testCases := []struct {
		name          string
		termID        int64
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			termID: taxonomyTerm.ID,
			body: gin.H{
				"name":        "Updated Name",
				"description": "Updated description",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(taxonomyTerm, nil)

				updatedTerm := taxonomyTerm
				updatedTerm.Name = "Updated Name"
				updatedTerm.Description = sql.NullString{String: "Updated description", Valid: true}

				store.EXPECT().
					UpdateTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(1).
					Return(updatedTerm, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "NoAuthorization",
			termID: taxonomyTerm.ID,
			body: gin.H{
				"name": "Updated Name",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// No authorization
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "NotFound",
			termID: taxonomyTerm.ID,
			body: gin.H{
				"name": "Updated Name",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(db.TaxonomyTerm{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InvalidID",
			termID: 0, // This will be overridden in the URL generation
			body: gin.H{
				"name": "Updated Name",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			var url string
			if tc.name == "InvalidID" {
				url = "/api/v1/taxonomy-terms/invalid_id"
			} else {
				url = fmt.Sprintf("/api/v1/taxonomy-terms/%d", tc.termID)
			}
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestDeleteTaxonomyTermAPI(t *testing.T) {
	taxonomyTerm := randomTaxonomyTerm()
	user := randomUserNew()

	testCases := []struct {
		name          string
		termID        int64
		query         string
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			termID: taxonomyTerm.ID,
			query:  "",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(taxonomyTerm, nil)

				store.EXPECT().
					CountPostsByTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(int64(0), nil)

				store.EXPECT().
					DeleteTaxonomyTermTx(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "ForceDelete",
			termID: taxonomyTerm.ID,
			query:  "?force=true",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(taxonomyTerm, nil)

				store.EXPECT().
					CountPostsByTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(int64(5), nil)

				store.EXPECT().
					DeleteTaxonomyTermTx(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "TermInUse",
			termID: taxonomyTerm.ID,
			query:  "",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(taxonomyTerm, nil)

				store.EXPECT().
					CountPostsByTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(int64(5), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name:   "NotFound",
			termID: taxonomyTerm.ID,
			query:  "",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Eq(taxonomyTerm.ID)).
					Times(1).
					Return(db.TaxonomyTerm{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "NoAuthorization",
			termID: taxonomyTerm.ID,
			query:  "",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// No authorization
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTaxonomyTerm(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/taxonomy-terms/%d%s", tc.termID, tc.query)
			request, err := http.NewRequest(http.MethodDelete, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// Helper functions for response validation
func requireBodyMatchTaxonomyType(t *testing.T, body string, taxonomyType db.TaxonomyType) {
	var response struct {
		TaxonomyType TaxonomyTypeResponse `json:"taxonomy_type"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, taxonomyType.ID, response.TaxonomyType.ID)
	require.Equal(t, taxonomyType.Name, response.TaxonomyType.Name)
	require.Equal(t, taxonomyType.Label, response.TaxonomyType.Label)
	require.Equal(t, taxonomyType.Description.String, response.TaxonomyType.Description)
	require.Equal(t, taxonomyType.Hierarchical, response.TaxonomyType.Hierarchical)
	require.Equal(t, taxonomyType.Public, response.TaxonomyType.Public)
	require.Equal(t, taxonomyType.ShowUi, response.TaxonomyType.ShowUI)
	require.Equal(t, taxonomyType.ShowInMenu, response.TaxonomyType.ShowInMenu)
}

func requireBodyMatchTaxonomyTypes(t *testing.T, body string, taxonomyTypes []db.TaxonomyType) {
	var response struct {
		TaxonomyTypes []TaxonomyTypeResponse `json:"taxonomy_types"`
		Meta          struct {
			Count int `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(taxonomyTypes), len(response.TaxonomyTypes))
	require.Equal(t, len(taxonomyTypes), response.Meta.Count)
	for i, taxonomyType := range taxonomyTypes {
		require.Equal(t, taxonomyType.ID, response.TaxonomyTypes[i].ID)
		require.Equal(t, taxonomyType.Name, response.TaxonomyTypes[i].Name)
		require.Equal(t, taxonomyType.Label, response.TaxonomyTypes[i].Label)
	}
}

func requireBodyMatchTaxonomyTerm(t *testing.T, body string, taxonomyTerm db.TaxonomyTerm) {
	var response struct {
		TaxonomyTerm TaxonomyTermResponse `json:"taxonomy_term"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, taxonomyTerm.ID, response.TaxonomyTerm.ID)
	require.Equal(t, taxonomyTerm.Name, response.TaxonomyTerm.Name)
	require.Equal(t, taxonomyTerm.Slug, response.TaxonomyTerm.Slug)
	require.Equal(t, taxonomyTerm.Description.String, response.TaxonomyTerm.Description)
	require.Equal(t, taxonomyTerm.TaxonomyTypeID, response.TaxonomyTerm.TaxonomyTypeID)
}

func requireBodyMatchTaxonomyTermsByType(t *testing.T, body string, taxonomyTerms []db.ListTaxonomyTermsByTypeRow) {
	var response struct {
		TaxonomyTerms []TaxonomyTermResponse `json:"taxonomy_terms"`
		Meta          struct {
			Count int `json:"count"`
			Limit int `json:"limit"`
			Total int `json:"total"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(taxonomyTerms), len(response.TaxonomyTerms))
	require.Equal(t, len(taxonomyTerms), response.Meta.Count)
	for i, term := range taxonomyTerms {
		require.Equal(t, term.ID, response.TaxonomyTerms[i].ID)
		require.Equal(t, term.Name, response.TaxonomyTerms[i].Name)
		require.Equal(t, term.Slug, response.TaxonomyTerms[i].Slug)
		require.Equal(t, term.TaxonomyTypeName, response.TaxonomyTerms[i].TaxonomyTypeName)
	}
}

func requireBodyMatchPopularTaxonomyTerms(t *testing.T, body string, terms []db.GetPopularTaxonomyTermsRow) {
	var response struct {
		TaxonomyTerms []TaxonomyTermResponse `json:"taxonomy_terms"`
		Meta          struct {
			Limit int `json:"limit"`
			Count int `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(terms), len(response.TaxonomyTerms))
	require.Equal(t, len(terms), response.Meta.Count)
	for i, term := range terms {
		require.Equal(t, term.ID, response.TaxonomyTerms[i].ID)
		require.Equal(t, term.Name, response.TaxonomyTerms[i].Name)
		require.Equal(t, term.Slug, response.TaxonomyTerms[i].Slug)
		require.Equal(t, term.PostCount, *response.TaxonomyTerms[i].PostCount)
	}
}

func requireBodyMatchSearchTaxonomyTerms(t *testing.T, body string, terms []db.SearchTaxonomyTermsRow) {
	var response struct {
		TaxonomyTerms []TaxonomyTermResponse `json:"taxonomy_terms"`
		Meta          struct {
			Query  string `json:"query"`
			Limit  int    `json:"limit"`
			Offset int    `json:"offset"`
			Count  int    `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(terms), len(response.TaxonomyTerms))
	require.Equal(t, len(terms), response.Meta.Count)
	for i, term := range terms {
		require.Equal(t, term.ID, response.TaxonomyTerms[i].ID)
		require.Equal(t, term.Name, response.TaxonomyTerms[i].Name)
		require.Equal(t, term.Slug, response.TaxonomyTerms[i].Slug)
		require.Equal(t, term.TaxonomyTypeName, response.TaxonomyTerms[i].TaxonomyTypeName)
	}
}
