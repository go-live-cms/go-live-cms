package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// Byline authors (#319): GET/PUT /posts/:id/authors and the picker's candidates.

var (
	bylineEditor      = db.User{ID: 31, Username: "byline_editor", Role: RoleEditor}
	bylineContributor = db.User{ID: 32, Username: "byline_contrib", Role: RoleContributor}
	bylineOther       = db.User{ID: 33, Username: "byline_other", Role: RoleContributor}
)

func bylineRequest(t *testing.T, server *Server, user db.User, method, url, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequest(method, url, reader)
	require.NoError(t, err)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func bylineRows(users ...db.User) []db.ListPostBylineAuthorsRow {
	rows := make([]db.ListPostBylineAuthorsRow, len(users))
	for i, u := range users {
		rows[i] = db.ListPostBylineAuthorsRow{ID: u.ID, Username: u.Username, FullName: u.FullName}
	}
	return rows
}

func TestSetPostAuthors(t *testing.T) {
	const url = "/api/v1/posts/7/authors"
	ownDraft := db.Post{ID: 7, UserID: bylineContributor.ID, PostStatus: "draft"}

	testCases := []struct {
		name   string
		caller db.User
		body   string
		stubs  func(store *mockdb.MockStore)
		check  func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "EditorSetsAndReorders",
			caller: bylineEditor,
			body:   fmt.Sprintf(`{"author_ids": [%d, %d]}`, bylineOther.ID, bylineContributor.ID),
			stubs: func(store *mockdb.MockStore) {
				// Moderators skip the post lookup.
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), db.SetPostAuthorsTxParams{
					PostID: 7, AuthorIDs: []int64{bylineOther.ID, bylineContributor.ID},
				}).Times(1).Return(db.SetPostAuthorsTxResult{
					Post:    db.Post{ID: 7, UserID: bylineContributor.ID, PostStatus: "published"},
					Authors: bylineRows(bylineOther, bylineContributor),
				}, nil)
				// The byline comes back from the transaction, not a second read.
				store.EXPECT().ListPostBylineAuthors(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
				var resp struct {
					Post    PostResponse         `json:"post"`
					Authors []PostAuthorResponse `json:"authors"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
				require.Equal(t, bylineContributor.ID, resp.Post.UserID, "the owner is unchanged")
				require.Equal(t, []int64{bylineOther.ID, bylineContributor.ID}, []int64{resp.Authors[0].ID, resp.Authors[1].ID})
			},
		},
		{
			// Crediting others gives them nothing: ownership stays with the creator.
			name:   "ContributorCreditsCoAuthorOnOwnDraft",
			caller: bylineContributor,
			body:   fmt.Sprintf(`{"author_ids": [%d, %d]}`, bylineContributor.ID, bylineOther.ID),
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(ownDraft, nil)
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), gomock.Any()).Times(1).
					Return(db.SetPostAuthorsTxResult{Post: ownDraft, Authors: bylineRows(bylineContributor, bylineOther)}, nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			},
		},
		{
			name:   "ContributorOwnPublishedPost",
			caller: bylineContributor,
			body:   fmt.Sprintf(`{"author_ids": [%d]}`, bylineOther.ID),
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(db.Post{ID: 7, UserID: bylineContributor.ID, PostStatus: "published"}, nil)
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			// Being credited isn't owning: permissions read only posts.user_id.
			name:   "CreditedContributorOnSomeoneElsesDraft",
			caller: bylineContributor,
			body:   fmt.Sprintf(`{"author_ids": [%d]}`, bylineContributor.ID),
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(db.Post{ID: 7, UserID: bylineOther.ID, PostStatus: "draft"}, nil)
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), gomock.Any()).Times(0)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:   "MissingPostForContributor",
			caller: bylineContributor,
			body:   fmt.Sprintf(`{"author_ids": [%d]}`, bylineContributor.ID),
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(db.Post{}, sql.ErrNoRows)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "MissingPostForEditor",
			caller: bylineEditor,
			body:   `{"author_ids": [1]}`,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), gomock.Any()).Times(1).Return(db.SetPostAuthorsTxResult{}, sql.ErrNoRows)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "UnknownUser",
			caller: bylineEditor,
			body:   `{"author_ids": [1, 999999]}`,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), gomock.Any()).Times(1).Return(db.SetPostAuthorsTxResult{}, db.ErrUnknownAuthor)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
				require.Contains(t, recorder.Body.String(), `"author_ids"`)
			},
		},
		{
			name:   "StoreError",
			caller: bylineEditor,
			body:   `{"author_ids": [1]}`,
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), gomock.Any()).Times(1).Return(db.SetPostAuthorsTxResult{}, sql.ErrConnDone)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			// Someone else saved meanwhile: 409 with their byline, nothing written.
			name:   "BylineChanged",
			caller: bylineEditor,
			body:   fmt.Sprintf(`{"author_ids": [%d], "base_author_ids": [%d, %d]}`, bylineOther.ID, bylineOther.ID, bylineContributor.ID),
			stubs: func(store *mockdb.MockStore) {
				store.EXPECT().SetPostAuthorsTx(gomock.Any(), db.SetPostAuthorsTxParams{
					PostID: 7, AuthorIDs: []int64{bylineOther.ID}, BaseAuthorIDs: []int64{bylineOther.ID, bylineContributor.ID},
				}).Times(1).Return(db.SetPostAuthorsTxResult{Current: bylineRows(bylineContributor)}, db.ErrBylineChanged)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
				var resp struct {
					Code    string               `json:"code"`
					Authors []PostAuthorResponse `json:"authors"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
				require.Equal(t, "byline_changed", resp.Code)
				require.Equal(t, []PostAuthorResponse{{ID: bylineContributor.ID, Username: bylineContributor.Username}}, resp.Authors)
			},
		},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.stubs(store)
			stubRoleLookup(store, tc.caller)
			tc.check(t, bylineRequest(t, newTestServer(t, store), tc.caller, http.MethodPut, url, tc.body))
		})
	}

	// Bad bodies never reach the store.
	for name, body := range map[string]string{
		"Empty":       `{"author_ids": []}`,
		"Missing":     `{}`,
		"Repeated":    `{"author_ids": [4, 5, 4]}`,
		"Zero":        `{"author_ids": [0]}`,
		"TooMany":     `{"author_ids": [` + strings.TrimSuffix(strings.Repeat("1,", maxPostAuthors+1), ",") + `]}`,
		"BaseTooLong": `{"author_ids": [1], "base_author_ids": [` + strings.TrimSuffix(strings.Repeat("1,", maxPostAuthors+1), ",") + `]}`,
		"Unknown":     `{"author_ids": [1], "owner": 2}`,
	} {
		t.Run("Invalid"+name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			stubRoleLookup(store, bylineEditor)
			recorder := bylineRequest(t, newTestServer(t, store), bylineEditor, http.MethodPut, url, body)
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
		})
	}
	t.Run("InvalidID", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, bylineEditor)
		recorder := bylineRequest(t, newTestServer(t, store), bylineEditor, http.MethodPut, "/api/v1/posts/abc/authors", `{"author_ids": [1]}`)
		require.Equal(t, http.StatusBadRequest, recorder.Code)
	})
}

func TestGetPostAuthors(t *testing.T) {
	const url = "/api/v1/posts/7/authors"
	testCases := []struct {
		name   string
		caller db.User
		post   db.Post
		getErr error
		want   int
	}{
		{"OwnDraft", bylineContributor, db.Post{ID: 7, UserID: bylineContributor.ID, PostStatus: "draft"}, nil, http.StatusOK},
		{"SomeoneElsesPublished", bylineContributor, db.Post{ID: 7, UserID: bylineOther.ID, PostStatus: "published"}, nil, http.StatusOK},
		// Credited or not, a contributor never reads someone else's draft.
		{"SomeoneElsesDraft", bylineContributor, db.Post{ID: 7, UserID: bylineOther.ID, PostStatus: "draft"}, nil, http.StatusForbidden},
		{"Missing", bylineEditor, db.Post{}, sql.ErrNoRows, http.StatusNotFound},
		{"GetError", bylineEditor, db.Post{}, sql.ErrConnDone, http.StatusInternalServerError},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(tc.post, tc.getErr)
			if tc.want == http.StatusOK {
				store.EXPECT().ListPostBylineAuthors(gomock.Any(), int64(7)).Times(1).Return(bylineRows(bylineOther, bylineContributor), nil)
			}
			stubRoleLookup(store, tc.caller)
			recorder := bylineRequest(t, newTestServer(t, store), tc.caller, http.MethodGet, url, "")
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			if tc.want == http.StatusOK {
				require.JSONEq(t, `{"authors": [
					{"id": 33, "username": "byline_other", "full_name": ""},
					{"id": 32, "username": "byline_contrib", "full_name": ""}]}`, recorder.Body.String())
			}
		})
	}
}

func TestListAuthorCandidates(t *testing.T) {
	t.Run("Search", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().ListAuthorCandidates(gomock.Any(), db.ListAuthorCandidatesParams{Roles: contentRoles, Pattern: `%an\_a%`, LimitCount: authorCandidatesLimit}).
			Times(1).Return([]db.ListAuthorCandidatesRow{{ID: 3, Username: "ana", FullName: "Ana Costa"}}, nil)
		stubRoleLookup(store, bylineContributor)
		recorder := bylineRequest(t, newTestServer(t, store), bylineContributor, http.MethodGet, "/api/v1/posts/author-candidates?q=+an_a+", "")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"authors": [{"id": 3, "username": "ana", "full_name": "Ana Costa"}]}`, recorder.Body.String())
	})
	t.Run("Everyone", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().ListAuthorCandidates(gomock.Any(), db.ListAuthorCandidatesParams{Roles: contentRoles, Pattern: "", LimitCount: authorCandidatesLimit}).
			Times(1).Return(nil, nil)
		stubRoleLookup(store, bylineEditor)
		recorder := bylineRequest(t, newTestServer(t, store), bylineEditor, http.MethodGet, "/api/v1/posts/author-candidates", "")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"authors": []}`, recorder.Body.String())
	})
	t.Run("QueryTooLong", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, bylineEditor)
		recorder := bylineRequest(t, newTestServer(t, store), bylineEditor, http.MethodGet, "/api/v1/posts/author-candidates?q="+strings.Repeat("a", 101), "")
		require.Equal(t, http.StatusBadRequest, recorder.Code)
	})
	t.Run("StoreError", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().ListAuthorCandidates(gomock.Any(), gomock.Any()).Times(1).Return(nil, sql.ErrConnDone)
		stubRoleLookup(store, bylineEditor)
		recorder := bylineRequest(t, newTestServer(t, store), bylineEditor, http.MethodGet, "/api/v1/posts/author-candidates", "")
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
	})
}

// Permissions use only the owner (#319 acceptance): a byline has no say in
// canReadPost / canEditPost / canEditPostDetails, so a contributor credited on
// someone else's post gets nothing, and the owner left out of the byline keeps
// every right.
func TestBylineGrantsNoAccess(t *testing.T) {
	othersDraft := db.Post{ID: 7, UserID: bylineOther.ID, PostStatus: "draft"}
	require.False(t, canReadPost(bylineContributor, othersDraft))
	require.False(t, canEditPost(bylineContributor, othersDraft))
	require.False(t, canEditPostByline(bylineContributor, othersDraft))
	require.True(t, canEditPostByline(bylineOther, othersDraft), "the owner, credited or not")
	require.True(t, canEditPostByline(bylineEditor, othersDraft))
	require.False(t, canEditPostByline(bylineOther, db.Post{ID: 7, UserID: bylineOther.ID, PostStatus: "published"}))
	require.True(t, distinctIDs([]int64{1, 2, 3}))
	require.False(t, distinctIDs([]int64{1, 2, 1}))
}
