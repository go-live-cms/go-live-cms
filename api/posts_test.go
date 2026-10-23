package api

import (
	"bytes"
	"context"
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
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

func randomUserForPosts() db.User {
	gofakeit.Seed(0)
	return db.User{
		ID:                gofakeit.Int64(),
		Username:          gofakeit.Username(),
		FullName:          gofakeit.Name(),
		Email:             gofakeit.Email(),
		HashedPassword:    gofakeit.Password(true, true, true, true, false, 12),
		PasswordChangedAt: gofakeit.PastDate(),
		CreatedAt:         gofakeit.Date(),
		Role:              "editor",
	}
}

func randomPost(user db.User) db.Post {
	gofakeit.Seed(0)
	return db.Post{
		ID:          gofakeit.Int64(),
		Title:       gofakeit.Sentence(3),
		BlockDoc:    json.RawMessage(`{"blocks":[]}`),
		Description: gofakeit.Sentence(10),
		UserID:      user.ID,
		Username:    user.Username,
		Url:         fmt.Sprintf("https://example.com/posts/%s", gofakeit.UUID()),
		PostType:    "post",
		PostStatus:  "draft",
		Slug:        gofakeit.UUID(),
		CreatedAt:   time.Now(),
		ChangedAt:   time.Now(),
	}
}

func TestCreatePostAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)

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
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CheckURLExists(gomock.Any(), gomock.Eq(post.Url)).
					Times(1).
					Return(false, nil)

				store.EXPECT().
					CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: normalizePostSlug(post.Title), ExcludeID: 0})).
					Times(1).
					Return(false, nil)

				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)

				store.EXPECT().
					CreatePostTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.CreatePostTxResult{
						Post: post,
						UserPosts: []db.UserPost{
							{PostID: post.ID, UserID: user.ID, Order: 0},
						},
					}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				requireBodyMatchPost(t, recorder.Body.String(), post)
			},
		},
		{
			// Under Hocuspocus the admin sends a new post's body with the create
			// (PUT /blocks is refused there); it becomes block_doc (#283).
			name: "OKWithBlockDoc",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
				"block_doc": gin.H{
					"doc_version":  1,
					"blocks_order": []string{"intro-block-0001", "intro-block-0001"},
					"blocks": gin.H{
						"intro-block-0001": gin.H{"id": "intro-block-0001", "type": "paragraph", "attrs": gin.H{"text": "Hello"}},
					},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CheckURLExists(gomock.Any(), gomock.Eq(post.Url)).Times(1).Return(false, nil)
				store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Times(1).Return(false, nil)
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(user, nil)
				store.EXPECT().
					CreatePostTx(gomock.Any(), gomock.Any()).
					Times(1).
					DoAndReturn(func(_ context.Context, arg db.CreatePostTxParams) (db.CreatePostTxResult, error) {
						var doc BlockDocV1
						require.NoError(t, json.Unmarshal(arg.BlockDoc, &doc))
						// prepareForStore ran: the duplicate order entry is gone.
						require.Equal(t, []string{"intro-block-0001"}, doc.BlocksOrder)
						require.Contains(t, doc.Blocks, "intro-block-0001")
						return db.CreatePostTxResult{Post: post}, nil
					})
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
			},
		},
		{
			name: "InvalidBlockDoc",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
				"block_doc": gin.H{
					"doc_version":  2,
					"blocks_order": []string{"intro-block-0001"},
					"blocks":       gin.H{},
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().CreatePostTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "AuthorNotFound",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{999},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(int64(999))).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "NoAuthorization",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Any()).
					Times(0)
				store.EXPECT().
					CreatePostTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InvalidURL",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         "invalid-url",
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "NoAuthors",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "ForbiddenContributor",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID+77, "contrib_caller", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// requireContentEditor rejects the contributor before the handler runs
				contributor := randomUserForPosts()
				contributor.ID = user.ID + 77
				contributor.Role = "contributor"
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(contributor.ID)).
					Times(1).
					Return(contributor, nil)
				store.EXPECT().
					CreatePostTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name: "WithMedia",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
				"media_ids":   []int64{1, 2},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CheckURLExists(gomock.Any(), gomock.Eq(post.Url)).
					Times(1).
					Return(false, nil)

				store.EXPECT().
					CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: normalizePostSlug(post.Title), ExcludeID: 0})).
					Times(1).
					Return(false, nil)

				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)

				store.EXPECT().
					CreatePostWithMediaTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.CreatePostWithMediaTxResult{
						Post: post,
						UserPosts: []db.UserPost{
							{PostID: post.ID, UserID: user.ID, Order: 0},
						},
						PostMedia: []db.PostMedium{
							{PostID: post.ID, MediaID: 1, Order: 0},
							{PostID: post.ID, MediaID: 2, Order: 1},
						},
					}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				requireBodyMatchPost(t, recorder.Body.String(), post)
			},
		},
		{
			// The slug taken by another post gets -2, -3, ... instead of the
			// unique index rejecting the create.
			name: "DuplicateSlugSuffixed",
			body: gin.H{
				"title":       "Hello World",
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CheckURLExists(gomock.Any(), gomock.Eq(post.Url)).Return(false, nil)
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Return(user, nil)
				gomock.InOrder(
					store.EXPECT().
						CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: "hello-world"})).
						Return(true, nil),
					store.EXPECT().
						CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: "hello-world-2"})).
						Return(true, nil),
					store.EXPECT().
						CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: "hello-world-3"})).
						Return(false, nil),
				)
				store.EXPECT().
					CreatePostTx(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ context.Context, arg db.CreatePostTxParams) (db.CreatePostTxResult, error) {
						require.Equal(t, "hello-world-3", arg.Slug)
						created := post
						created.Slug = arg.Slug
						return db.CreatePostTxResult{Post: created}, nil
					})
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				require.Contains(t, recorder.Body.String(), `"slug":"hello-world-3"`)
			},
		},
		{
			name: "ExplicitSlugNormalized",
			body: gin.H{
				"title":       post.Title,
				"slug":        " My/Custom Slug? ",
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CheckURLExists(gomock.Any(), gomock.Eq(post.Url)).Return(false, nil)
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Return(user, nil)
				store.EXPECT().
					CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: "mycustom-slug"})).
					Return(false, nil)
				store.EXPECT().
					CreatePostTx(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ context.Context, arg db.CreatePostTxParams) (db.CreatePostTxResult, error) {
						require.Equal(t, "mycustom-slug", arg.Slug)
						return db.CreatePostTxResult{Post: post}, nil
					})
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
			},
		},
		{
			name: "SlugLookupError",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CheckURLExists(gomock.Any(), gomock.Eq(post.Url)).Return(false, nil)
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Return(user, nil)
				store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, sql.ErrConnDone)
				store.EXPECT().CreatePostTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			// Another create took the same slug between the check and the insert.
			name: "SlugRaceConflict",
			body: gin.H{
				"title":       post.Title,
				"description": post.Description,
				"url":         post.Url,
				"author_ids":  []int64{user.ID},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().CheckURLExists(gomock.Any(), gomock.Eq(post.Url)).Return(false, nil)
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Return(user, nil)
				store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, nil)
				store.EXPECT().
					CreatePostTx(gomock.Any(), gomock.Any()).
					Return(db.CreatePostTxResult{}, fmt.Errorf("pq: duplicate key value violates unique constraint \"idx_posts_slug\""))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
				require.Contains(t, recorder.Body.String(), "slug already exists")
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
			stubRoleLookup(store, user)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := "/api/v1/posts"
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetPostAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)

	testCases := []struct {
		name          string
		postID        int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(post, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchPost(t, recorder.Body.String(), post)
			},
		},
		{
			name:   "NotFound",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: post.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(db.Post{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "InvalidID",
			postID: 0,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Any()).
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
				url = "/api/v1/posts/invalid_id"
			} else {
				url = fmt.Sprintf("/api/v1/posts/%d", tc.postID)
			}

			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestListPostsAPI(t *testing.T) {
	user := randomUserForPosts()
	n := 5
	listRows := make([]db.ListPostsRow, n)
	for i := 0; i < n; i++ {
		p := randomPost(user)
		p.ID = int64(i + 1)
		listRows[i] = db.ListPostsRow{
			ID:          p.ID,
			Title:       p.Title,
			Description: p.Description,
			UserID:      p.UserID,
			Username:    p.Username,
			Url:         p.Url,
			PostType:    p.PostType,
			PostStatus:  p.PostStatus,
			CreatedAt:   p.CreatedAt,
			ChangedAt:   p.ChangedAt,
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
			query: "?limit=5&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListPosts(gomock.Any(), db.ListPostsParams{
						PostType:      "",
						PostStatus:    "",
						UserID:        int64(0),
						SortColumn:    "created_at",
						SortDirection: "desc",
						OffsetCount:   0,
						LimitCount:    5,
					}).
					Times(1).
					Return(listRows, nil)
				store.EXPECT().
					CountFilteredPosts(gomock.Any(), gomock.Any()).
					Times(1).
					Return(int64(100), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchListRows(t, recorder.Body.String(), listRows, int64(100))
			},
		},
		{
			name:  "InternalError",
			query: "?limit=5&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CountFilteredPosts(gomock.Any(), gomock.Any()).
					Times(1).
					Return(int64(0), nil)
				store.EXPECT().
					ListPosts(gomock.Any(), gomock.Any()).
					Times(1).
					Return([]db.ListPostsRow{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:  "InvalidLimit",
			query: "?limit=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListPosts(gomock.Any(), gomock.Any()).
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

			url := "/api/v1/posts" + tc.query
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpdatePostAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)
	newTitle := gofakeit.Sentence(3)

	testCases := []struct {
		name          string
		postID        int64
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			body: gin.H{
				"title": newTitle,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {

				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(post, nil)

				updatedPost := post
				updatedPost.Title = newTitle

				store.EXPECT().
					UpdatePost(gomock.Any(), gomock.Any()).
					Times(1).
					Return(updatedPost, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "NoAuthorization",
			postID: post.ID,
			body: gin.H{
				"title": newTitle,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Any()).
					Times(0)
				store.EXPECT().
					UpdatePost(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "PostNotFound",
			postID: post.ID,
			body: gin.H{
				"title": newTitle,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "DuplicateURL",
			postID: post.ID,
			body: gin.H{
				"url": "https://example.com/duplicate",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(post, nil)

				store.EXPECT().
					UpdatePost(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.Post{}, fmt.Errorf("duplicate key value violates unique constraint"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			// An edited slug another post already uses is suffixed, the same as on create.
			name:   "SlugEditSuffixed",
			postID: post.ID,
			body: gin.H{
				"slug": "About Us",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Eq(post.ID)).Return(post, nil)
				gomock.InOrder(
					store.EXPECT().
						CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: "about-us", ExcludeID: post.ID})).
						Return(true, nil),
					store.EXPECT().
						CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: "about-us-2", ExcludeID: post.ID})).
						Return(false, nil),
				)
				store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(0)
				renamed := post
				renamed.Slug = "about-us-2"
				store.EXPECT().
					UpdatePostWithSlugTx(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ context.Context, arg db.UpdatePostWithSlugTxParams) (db.Post, error) {
						require.Equal(t, "about-us-2", arg.Slug)
						require.Equal(t, post.ID, arg.ID)
						return renamed, nil
					})
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.Contains(t, recorder.Body.String(), `"slug":"about-us-2"`)
			},
		},
		{
			// Re-sending the post's own slug is not a clash (ExcludeID) and writes nothing extra.
			name:   "SlugEditUnchanged",
			postID: post.ID,
			body: gin.H{
				"slug": post.Slug,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Eq(post.ID)).Return(post, nil)
				store.EXPECT().
					CheckSlugExists(gomock.Any(), gomock.Eq(db.CheckSlugExistsParams{Slug: post.Slug, ExcludeID: post.ID})).
					Return(false, nil)
				store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Return(post, nil)
				store.EXPECT().UpdatePostWithSlugTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			// Lost a race with another writer: the unique index still answers 409,
			// and the whole update (not just the slug) is rolled back in the tx.
			name:   "SlugEditConflict",
			postID: post.ID,
			body: gin.H{
				"slug": "taken",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Eq(post.ID)).Return(post, nil)
				store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, nil)
				store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().
					UpdatePostWithSlugTx(gomock.Any(), gomock.Any()).
					Return(db.Post{}, fmt.Errorf("pq: duplicate key value violates unique constraint \"idx_posts_slug\""))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
				require.Contains(t, recorder.Body.String(), "slug already exists")
			},
		},
		{
			name:   "SlugLookupError",
			postID: post.ID,
			body: gin.H{
				"slug": "anything",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Eq(post.ID)).Return(post, nil)
				store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, sql.ErrConnDone)
				store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(0)
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
			stubRoleLookup(store, user)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/posts/%d", tc.postID)
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestDeletePostAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)

	testCases := []struct {
		name          string
		postID        int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(post, nil)

				store.EXPECT().
					DeletePostTx(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "NoAuthorization",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Any()).
					Times(0)
				store.EXPECT().
					DeletePostTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "PostNotFound",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			postID: post.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPost(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(post, nil)

				store.EXPECT().
					DeletePostTx(gomock.Any(), gomock.Eq(post.ID)).
					Times(1).
					Return(sql.ErrConnDone)
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
			stubRoleLookup(store, user)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/%d", tc.postID)
			request, err := http.NewRequest(http.MethodDelete, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetPostsByUserAPI(t *testing.T) {
	user := randomUserForPosts()
	n := 3
	posts := make([]db.GetPostsByUserWithMediaRow, n)
	for i := 0; i < n; i++ {
		post := randomPost(user)
		post.ID = int64(i + 1)
		posts[i] = db.GetPostsByUserWithMediaRow{
			ID:          post.ID,
			Title:       post.Title,
			BlockDoc:    post.BlockDoc,
			Description: post.Description,
			UserID:      post.UserID,
			Username:    post.Username,
			Url:         post.Url,
			PostType:    post.PostType,
			PostStatus:  post.PostStatus,
			Slug:        post.Slug,
			CreatedAt:   post.CreatedAt,
			ChangedAt:   post.ChangedAt,
			Media:       []byte(`[]`),
		}
	}

	testCases := []struct {
		name          string
		userID        int64
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			userID: user.ID,
			query:  "?limit=10&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)

				store.EXPECT().
					GetPostsByUserWithMedia(gomock.Any(), db.GetPostsByUserWithMediaParams{
						UserID: user.ID,
						Limit:  10,
						Offset: 0,
					}).
					Times(1).
					Return(posts, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "UserNotFound",
			userID: user.ID,
			query:  "?limit=10&offset=0",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
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

			url := fmt.Sprintf("/api/v1/posts/user/%d%s", tc.userID, tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func requireBodyMatchPost(t *testing.T, body string, post db.Post) {
	var response struct {
		Post PostResponse `json:"post"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, post.ID, response.Post.ID)
	require.Equal(t, post.Title, response.Post.Title)
	require.Equal(t, post.Description, response.Post.Description)
	require.Equal(t, post.UserID, response.Post.UserID)
	require.Equal(t, post.Username, response.Post.Username)
	require.Equal(t, post.Url, response.Post.Url)
	require.Equal(t, post.Slug, response.Post.Slug)
}

func TestGetPostBySlugAPI(t *testing.T) {
	user := randomUserForPosts()
	post := randomPost(user)

	testCases := []struct {
		name          string
		slug          string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			slug: post.Slug,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBySlug(gomock.Any(), post.Slug).
					Times(1).
					Return(post, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				p := resp["post"].(map[string]interface{})
				require.Equal(t, post.Title, p["title"])
				require.Equal(t, post.PostType, p["post_type"])
			},
		},
		{
			name: "NotFound",
			slug: post.Slug,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBySlug(gomock.Any(), post.Slug).
					Times(1).
					Return(db.Post{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			slug: post.Slug,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostBySlug(gomock.Any(), post.Slug).
					Times(1).
					Return(db.Post{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/slug/%s", tc.slug)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetPostsByTypeAPI(t *testing.T) {
	postType := randomPostType("article")
	user := randomUserForPosts()
	post := randomPost(user)

	testCases := []struct {
		name          string
		postType      string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:     "OK",
			postType: postType.Name,
			query:    "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostType(gomock.Any(), postType.Name).
					Times(1).
					Return(postType, nil)
				store.EXPECT().
					ListPosts(gomock.Any(), gomock.Any()).
					Times(1).
					Return([]db.ListPostsRow{{ID: post.ID, Title: post.Title, PostType: post.PostType}}, nil)
				store.EXPECT().
					CountPostsByTypeFiltered(gomock.Any(), db.CountPostsByTypeFilteredParams{PostType: postType.Name}).
					Times(1).
					Return(int64(1), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				posts := resp["posts"].([]interface{})
				require.Len(t, posts, 1)
			},
		},
		{
			name:     "PostTypeNotFound",
			postType: postType.Name,
			query:    "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostType(gomock.Any(), postType.Name).
					Times(1).
					Return(db.PostType{}, sql.ErrNoRows)
				store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().CountPostsByTypeFiltered(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:     "InvalidSortParam",
			postType: postType.Name,
			query:    "?sort=invalid",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostType(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "InternalError",
			postType: postType.Name,
			query:    "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetPostType(gomock.Any(), postType.Name).
					Times(1).
					Return(postType, nil)
				store.EXPECT().
					ListPosts(gomock.Any(), gomock.Any()).
					Times(1).
					Return(nil, sql.ErrConnDone)
				store.EXPECT().CountPostsByTypeFiltered(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/posts/type/%s%s", tc.postType, tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func requireBodyMatchListRows(t *testing.T, body string, rows []db.ListPostsRow, expectedTotal int64) {
	var response struct {
		Posts []PostResponse `json:"posts"`
		Meta  struct {
			Total  int64 `json:"total"`
			Limit  int   `json:"limit"`
			Offset int   `json:"offset"`
			Count  int   `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(rows), len(response.Posts))
	require.Equal(t, expectedTotal, response.Meta.Total)
	for i, row := range rows {
		require.Equal(t, row.ID, response.Posts[i].ID)
		require.Equal(t, row.Title, response.Posts[i].Title)
	}
}
