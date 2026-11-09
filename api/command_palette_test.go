package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// expectCommandPaletteLookups expects every group but users, with viewerID as the posts'
// viewer, and returns one row of each.
func expectCommandPaletteLookups(store *mockdb.MockStore, query string, viewerID int64) {
	pattern := memberSearchPattern(query)
	store.EXPECT().SearchCommandPalettePosts(gomock.Any(), db.SearchCommandPalettePostsParams{
		Pattern: pattern, PrefixPattern: query + "%", ViewerID: viewerID, LimitPerType: commandPaletteLimit,
	}).Return([]db.SearchCommandPalettePostsRow{
		{ID: 2, Title: "About", PostType: "page", PostStatus: "published"},
		{ID: 1, Title: "Draft notes", PostType: "post", PostStatus: "draft"},
	}, nil)
	store.EXPECT().SearchMediaByName(gomock.Any(), gomock.Any()).Return([]db.SearchMediaByNameRow{{ID: 3, Name: "chart", MediaPath: "/app/uploads/media/chart.png"}}, nil)
	store.EXPECT().SearchTermsAcrossTaxonomies(gomock.Any(), db.SearchTermsAcrossTaxonomiesParams{Pattern: pattern, LimitCount: commandPaletteLimit}).
		Return([]db.SearchTermsAcrossTaxonomiesRow{{ID: 4, Name: "Guides", Slug: "guides", TaxonomyType: "category", TaxonomyLabel: "Categories"}}, nil)
}

func TestSearchCommandPaletteByRole(t *testing.T) {
	base := randomUserForPosts()
	withRole := func(role string, offset int64) db.User {
		user := base
		user.ID = base.ID + offset
		user.Role = role
		return user
	}
	admin := withRole(RoleAdmin, 0)
	editor := withRole(RoleEditor, 1)
	contributor := withRole(RoleContributor, 2)
	subscriber := withRole("subscriber", 3)
	member := db.User{ID: 9, Username: "ana", FullName: "Ana Costa", Email: "ana@example.test", HashedPassword: "secret-hash", Role: RoleEditor}

	testCases := []struct {
		name       string
		query      string
		caller     *db.User
		expect     func(store *mockdb.MockStore)
		wantStatus int
		check      func(t *testing.T, raw string, got CommandPaletteResponse)
	}{
		{
			name:       "SignedOut",
			query:      "q=draft",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "NotAContentRole",
			query:      "q=draft",
			caller:     &subscriber,
			wantStatus: http.StatusForbidden,
		},
		{
			name:   "AdminGetsEveryGroupAndNoEmail",
			query:  "q=draft",
			caller: &admin,
			expect: func(store *mockdb.MockStore) {
				expectCommandPaletteLookups(store, "draft", 0)
				store.EXPECT().ListMembers(gomock.Any(), db.ListMembersParams{Pattern: "%draft%", SortBy: "username_asc", LimitCount: commandPaletteLimit}).
					Return([]db.ListMembersRow{{User: member}}, nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, raw string, got CommandPaletteResponse) {
				require.Equal(t, []CommandPalettePost{{ID: 1, Title: "Draft notes", PostType: "post", PostStatus: "draft"}}, got.Posts)
				require.Equal(t, []CommandPalettePost{{ID: 2, Title: "About", PostType: "page", PostStatus: "published"}}, got.Pages)
				require.Equal(t, int64(3), got.Media[0].ID)
				require.Equal(t, []CommandPaletteTerm{{ID: 4, Name: "Guides", Slug: "guides", TaxonomyType: "category", TaxonomyLabel: "Categories"}}, got.Terms)
				require.Equal(t, []CommandPaletteUser{{ID: 9, Username: "ana", FullName: "Ana Costa", Role: RoleEditor}}, got.Users)
				require.NotContains(t, raw, "ana@example.test")
				require.NotContains(t, raw, "secret-hash")
			},
		},
		{
			name:   "EditorSeesAllPostsButNoUsers",
			query:  "q=draft",
			caller: &editor,
			expect: func(store *mockdb.MockStore) {
				expectCommandPaletteLookups(store, "draft", 0)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, raw string, got CommandPaletteResponse) {
				require.Nil(t, got.Users)
				require.NotContains(t, raw, `"users"`)
			},
		},
		{
			name:   "ContributorIsLimitedToWhatTheyMayRead",
			query:  "q=draft",
			caller: &contributor,
			expect: func(store *mockdb.MockStore) {
				expectCommandPaletteLookups(store, "draft", contributor.ID)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, raw string, got CommandPaletteResponse) {
				require.NotContains(t, raw, `"users"`)
			},
		},
		{
			name:       "EmptyQueryAsksNothing",
			query:      "q=%20%20",
			caller:     &admin,
			wantStatus: http.StatusOK,
			check: func(t *testing.T, raw string, got CommandPaletteResponse) {
				require.Equal(t, "", got.Query)
				require.Empty(t, got.Posts)
				require.Equal(t, []CommandPalettePost{}, got.Pages)
				require.JSONEq(t, `{"query":"","posts":[],"pages":[],"media":[],"terms":[]}`, raw)
			},
		},
		{
			name:   "WildcardsAreEscaped",
			query:  "q=100%25",
			caller: &editor,
			expect: func(store *mockdb.MockStore) {
				pattern := `%100\%%`
				store.EXPECT().SearchCommandPalettePosts(gomock.Any(), db.SearchCommandPalettePostsParams{
					Pattern: pattern, PrefixPattern: `100\%%`, LimitPerType: commandPaletteLimit,
				}).Return(nil, nil)
				store.EXPECT().SearchMediaByName(gomock.Any(), db.SearchMediaByNameParams{
					Column1: sql.NullString{String: `100\%`, Valid: true}, Column2: getMimeTypeFilter(""), Column3: int64(0), Column4: "date_desc", Limit: commandPaletteLimit,
				}).Return(nil, nil)
				store.EXPECT().SearchTermsAcrossTaxonomies(gomock.Any(), db.SearchTermsAcrossTaxonomiesParams{Pattern: pattern, LimitCount: commandPaletteLimit}).Return(nil, nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, raw string, got CommandPaletteResponse) {
				require.JSONEq(t, `{"query":"100%","posts":[],"pages":[],"media":[],"terms":[]}`, raw)
			},
		},
		{
			name:   "AStoreFailureIsA500",
			query:  "q=draft",
			caller: &editor,
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().SearchCommandPalettePosts(gomock.Any(), gomock.Any()).Return(nil, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)
			if tc.caller != nil {
				store.EXPECT().GetUser(gomock.Any(), tc.caller.ID).AnyTimes().Return(*tc.caller, nil)
			}
			if tc.expect != nil {
				tc.expect(store)
			}

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/v1/search?"+tc.query, nil)
			if tc.caller != nil {
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, tc.caller.ID, tc.caller.Username, time.Minute)
			}
			server.router.ServeHTTP(recorder, request)

			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.check != nil {
				var got CommandPaletteResponse
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &got))
				tc.check(t, recorder.Body.String(), got)
			}
		})
	}
}

// The palette aborts a stale request on every keystroke: that's not a server error.
func TestSearchCommandPaletteAbortedByTheClient(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)
	user := randomUserForPosts()
	user.Role = RoleEditor
	store.EXPECT().GetUser(gomock.Any(), user.ID).AnyTimes().Return(user, nil)

	ctx, cancel := context.WithCancel(context.Background())
	store.EXPECT().SearchCommandPalettePosts(gomock.Any(), gomock.Any()).DoAndReturn(
		func(context.Context, db.SearchCommandPalettePostsParams) ([]db.SearchCommandPalettePostsRow, error) {
			cancel()
			return nil, context.Canceled
		})

	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=draft", nil).WithContext(ctx)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	server.router.ServeHTTP(recorder, request)

	require.Equal(t, statusClientClosedRequest, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "failed")
}
