package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Full-text search (#145): handlers and the highlight escaping. The ranking,
// the index and the published-only filter are tested against Postgres in
// db/sqlc/post_search_test.go.

func TestHighlightHTML(t *testing.T) {
	testCases := []struct{ name, in, want string }{
		{"Plain", "Hello world", "Hello world"},
		{"Match", "Writing alt text that helps", "Writing <mark>alt</mark> <mark>text</mark> that helps"},
		{"MarkupEscaped", "<script>alert(1)</script> x", "&lt;script&gt;alert(1)&lt;/script&gt; <mark>x</mark>"},
		{"MarkupInsideMatchEscaped", "<img src=x onerror=alert(1)>", "<mark>&lt;img src=x onerror=alert(1)&gt;</mark>"},
		{"QuotesAndAmpersands", `"a" & 'b'`, "&#34;a&#34; &amp; &#39;b&#39;"},
		{"ExistingEntityEscapedAgain", "&lt;b&gt;", "&amp;lt;b&amp;gt;"},
		{"WhitespaceCollapsed", "  one\n\ntwo\t three  ", "one two three"},
		{"UnclosedMarkClosed", "a b", "a <mark>b</mark>"},
		{"StrayStopIgnored", "a b", "a b"},
		{"NestedStartIgnored", "ab", "<mark>ab</mark>"},
		{"Empty", "", ""},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got := highlightHTML(tc.in)
			require.Equal(t, tc.want, got)
			requireOnlyMarkTags(t, got)
		})
	}
}

// requireOnlyMarkTags fails if html holds any tag other than <mark> / </mark>.
func requireOnlyMarkTags(t *testing.T, html string) {
	t.Helper()
	stripped := strings.NewReplacer("<mark>", "", "</mark>", "").Replace(html)
	require.NotContains(t, stripped, "<", html)
	require.NotContains(t, stripped, ">", html)
}

func TestNormalizeSearchQuery(t *testing.T) {
	require.Equal(t, "alt text", normalizeSearchQuery("  alt \n text "))
	require.Equal(t, "a b", normalizeSearchQuery("a\x00b"))
	require.Equal(t, "ab", normalizeSearchQuery("a\xffb"))
	require.Equal(t, "a b", normalizeSearchQuery("ab"))
	require.Equal(t, "", normalizeSearchQuery(" \t "))
	long := strings.Repeat("é", maxSearchQueryRunes+50)
	require.Equal(t, strings.Repeat("é", maxSearchQueryRunes), normalizeSearchQuery(long))
}

type publicSearchBody struct {
	Query      string               `json:"query"`
	Type       string               `json:"type"`
	Results    []PublicSearchResult `json:"results"`
	Counts     searchCounts         `json:"counts"`
	Pagination pageInfo             `json:"pagination"`
}

func searchRows(n int) []db.SearchPublicPostsRow {
	rows := make([]db.SearchPublicPostsRow, n)
	for i := range rows {
		rows[i] = db.SearchPublicPostsRow{
			ID: int64(i + 1), Title: "T", Slug: "t", PostType: "post",
			TitleHighlight: "T", ExcerptHighlight: "e",
		}
	}
	return rows
}

func TestGetPublicSearch(t *testing.T) {
	bothTypes := []db.CountPublicSearchResultsRow{{PostType: "post", Total: 13}, {PostType: "page", Total: 2}}

	testCases := []struct {
		name       string
		query      string
		expect     func(store *mockdb.MockStore)
		wantStatus int
		check      func(t *testing.T, body publicSearchBody)
	}{
		{
			name:  "AllTypes",
			query: "q=alt+text",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), "alt text").Return(bothTypes, nil)
				store.EXPECT().SearchPublicPosts(gomock.Any(), db.SearchPublicPostsParams{Query: "alt text", OffsetCount: 0, LimitCount: 10}).Return(searchRows(10), nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body publicSearchBody) {
				require.Equal(t, "alt text", body.Query)
				require.Equal(t, "all", body.Type)
				require.Equal(t, searchCounts{All: 15, Post: 13, Page: 2}, body.Counts)
				require.Equal(t, pageInfo{Page: 1, PerPage: 10, Total: 15, TotalPages: 2}, body.Pagination)
				require.Len(t, body.Results, 10)
				require.Equal(t, "<mark>T</mark>", body.Results[0].TitleHTML)
			},
		},
		{
			name:  "OneTypeSecondPage",
			query: "q=alt&type=post&page=2",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), "alt").Return(bothTypes, nil)
				store.EXPECT().SearchPublicPosts(gomock.Any(), db.SearchPublicPostsParams{Query: "alt", PostType: "post", OffsetCount: 10, LimitCount: 10}).Return(searchRows(3), nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body publicSearchBody) {
				require.Equal(t, "post", body.Type)
				require.Equal(t, pageInfo{Page: 2, PerPage: 10, Total: 13, TotalPages: 2}, body.Pagination)
				// The chips keep every type's count.
				require.Equal(t, searchCounts{All: 15, Post: 13, Page: 2}, body.Counts)
			},
		},
		{
			name:  "NoMatchesSkipsTheSearch",
			query: "q=quantum+editing&type=page",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), "quantum editing").Return([]db.CountPublicSearchResultsRow{{PostType: "post", Total: 4}}, nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body publicSearchBody) {
				require.Empty(t, body.Results)
				require.NotNil(t, body.Results)
				require.Equal(t, searchCounts{All: 4, Post: 4}, body.Counts)
				require.Equal(t, int64(0), body.Pagination.Total)
			},
		},
		{
			name:  "EmptyQueryTouchesNoIndex",
			query: "q=++",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body publicSearchBody) {
				require.Equal(t, "", body.Query)
				require.Empty(t, body.Results)
				require.Equal(t, searchCounts{}, body.Counts)
			},
		},
		{
			name:  "HTMLQueryIsDataAndHighlightsAreEscaped",
			query: "q=" + url.QueryEscape(`<script>alert("x")</script>`),
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), `<script>alert("x")</script>`).Return([]db.CountPublicSearchResultsRow{{PostType: "post", Total: 1}}, nil)
				store.EXPECT().SearchPublicPosts(gomock.Any(), gomock.Any()).Return([]db.SearchPublicPostsRow{{
					ID: 1, Title: "<script>alert</script>", PostType: "post", ExcerptAtStart: true, ExcerptAtEnd: true,
					TitleHighlight:   "<script>alert</script>",
					ExcerptHighlight: `<img src=x onerror="alert(1)"> alert`,
				}}, nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body publicSearchBody) {
				// JSON escaping is undone by decoding: this is what the page receives.
				require.Equal(t, `<script>alert("x")</script>`, body.Query)
				require.Equal(t, "&lt;<mark>script</mark>&gt;<mark>alert</mark>&lt;/<mark>script</mark>&gt;", body.Results[0].TitleHTML)
				require.Equal(t, "&lt;img src=x onerror=&#34;alert(1)&#34;&gt; <mark>alert</mark>", body.Results[0].ExcerptHTML)
				requireOnlyMarkTags(t, body.Results[0].TitleHTML)
				requireOnlyMarkTags(t, body.Results[0].ExcerptHTML)
			},
		},
		{
			name:  "MalformedTsquerySyntaxIsPassedThrough",
			query: "q=" + url.QueryEscape("&|!("),
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), "&|!(").Return([]db.CountPublicSearchResultsRow{}, nil)
			},
			wantStatus: http.StatusOK,
		},
		{
			name:  "PastTheEnd",
			query: "q=alt&page=3",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), "alt").Return(bothTypes, nil)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:  "SecondPageOfEmptyQuery",
			query: "page=2",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "UnknownType",
			query:      "q=alt&type=media",
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "BadPage",
			query:      "q=alt&page=0",
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:  "CountError",
			query: "q=alt",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), "alt").Return(nil, errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:  "SearchError",
			query: "q=alt",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().CountPublicSearchResults(gomock.Any(), "alt").Return(bothTypes, nil)
				store.EXPECT().SearchPublicPosts(gomock.Any(), gomock.Any()).Return(nil, errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.expect(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/public/search?"+tc.query, nil)
			server.router.ServeHTTP(recorder, request)

			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.wantStatus != http.StatusOK {
				return
			}
			// Nothing but <mark> is ever raw HTML in the body: the JSON encoder
			// escapes < > & everywhere, highlights included.
			require.NotContains(t, recorder.Body.String(), "<script")
			var body publicSearchBody
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			if tc.check != nil {
				tc.check(t, body)
			}
		})
	}
}

func TestSearchPostsAdmin(t *testing.T) {
	editor := randomUserForPosts()
	contributor := randomUserForPosts()
	contributor.ID = editor.ID + 1
	contributor.Role = RoleContributor
	subscriber := randomUserForPosts()
	subscriber.ID = editor.ID + 2
	subscriber.Role = "subscriber"

	row := db.SearchPostsWithMetaRow{ID: 7, Title: "Draft", PostType: "post", PostStatus: "draft", Meta: []byte(`{}`), Authors: json.RawMessage(`[]`)}

	testCases := []struct {
		name       string
		query      string
		caller     *db.User
		expect     func(store *mockdb.MockStore)
		wantStatus int
		check      func(t *testing.T, body map[string]json.RawMessage)
	}{
		{
			name:   "EditorSeesDraftsWithTheListFilters",
			query:  "q=draft+notes&type=post&status=draft,published&limit=25&offset=25",
			caller: &editor,
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().CountSearchPosts(gomock.Any(), db.CountSearchPostsParams{Query: "draft notes", PostType: "post", PostStatus: "draft,published"}).Return(int64(26), nil)
				store.EXPECT().SearchPostsWithMeta(gomock.Any(), db.SearchPostsWithMetaParams{
					Query: "draft notes", PostType: "post", PostStatus: "draft,published", OffsetCount: 25, LimitCount: 25,
				}).Return([]db.SearchPostsWithMetaRow{row}, nil)
			},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body map[string]json.RawMessage) {
				var posts []PostWithMetaResponse
				require.NoError(t, json.Unmarshal(body["posts"], &posts))
				require.Len(t, posts, 1)
				require.Equal(t, int64(7), posts[0].ID)
				require.Equal(t, "draft", posts[0].PostStatus)
				var meta struct {
					Total int64  `json:"total"`
					Q     string `json:"q"`
				}
				require.NoError(t, json.Unmarshal(body["meta"], &meta))
				require.Equal(t, int64(26), meta.Total)
				require.Equal(t, "draft notes", meta.Q)
			},
		},
		{
			name:   "ContributorMineTab",
			query:  "q=notes&user_id=" + strconv.FormatInt(contributor.ID, 10),
			caller: &contributor,
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().CountSearchPosts(gomock.Any(), db.CountSearchPostsParams{Query: "notes", UserID: contributor.ID}).Return(int64(0), nil)
				store.EXPECT().SearchPostsWithMeta(gomock.Any(), db.SearchPostsWithMetaParams{Query: "notes", UserID: contributor.ID, LimitCount: 10}).Return([]db.SearchPostsWithMetaRow{}, nil)
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "EmptyQueryIsEmpty",
			query:      "q=",
			caller:     &editor,
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusOK,
			check: func(t *testing.T, body map[string]json.RawMessage) {
				require.JSONEq(t, `[]`, string(body["posts"]))
			},
		},
		{
			name:       "SignedOut",
			query:      "q=notes",
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "NoContentRole",
			query:      "q=notes",
			caller:     &subscriber,
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusForbidden,
		},
		{name: "BadLimit", query: "q=a&limit=0", caller: &editor, expect: func(store *mockdb.MockStore) {}, wantStatus: http.StatusBadRequest},
		{name: "BadOffset", query: "q=a&offset=-1", caller: &editor, expect: func(store *mockdb.MockStore) {}, wantStatus: http.StatusBadRequest},
		{name: "BadUserID", query: "q=a&user_id=me", caller: &editor, expect: func(store *mockdb.MockStore) {}, wantStatus: http.StatusBadRequest},
		{
			name:   "LimitCapped",
			query:  "q=a&limit=500",
			caller: &editor,
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().CountSearchPosts(gomock.Any(), gomock.Any()).Return(int64(0), nil)
				store.EXPECT().SearchPostsWithMeta(gomock.Any(), db.SearchPostsWithMetaParams{Query: "a", LimitCount: 100}).Return(nil, nil)
			},
			wantStatus: http.StatusOK,
		},
		{
			name:   "CountError",
			query:  "q=a",
			caller: &editor,
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().CountSearchPosts(gomock.Any(), gomock.Any()).Return(int64(0), errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:   "SearchError",
			query:  "q=a",
			caller: &editor,
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().CountSearchPosts(gomock.Any(), gomock.Any()).Return(int64(1), nil)
				store.EXPECT().SearchPostsWithMeta(gomock.Any(), gomock.Any()).Return(nil, errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.expect(store)
			for _, user := range []db.User{editor, contributor, subscriber} {
				stubRoleLookup(store, user)
			}

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/v1/posts/search?"+tc.query, nil)
			if tc.caller != nil {
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, tc.caller.ID, tc.caller.Username, time.Minute)
			}
			server.router.ServeHTTP(recorder, request)

			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.check != nil {
				var body map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				tc.check(t, body)
			}
		})
	}
}

func TestExcerptHTMLMarksCuts(t *testing.T) {
	row := func(atStart, atEnd bool) db.SearchPublicPostsRow {
		return db.SearchPublicPostsRow{ExcerptHighlight: "good \uE000alt\uE001 text", ExcerptAtStart: atStart, ExcerptAtEnd: atEnd}
	}
	require.Equal(t, "good <mark>alt</mark> text", excerptHTML(row(true, true)))
	require.Equal(t, "…good <mark>alt</mark> text", excerptHTML(row(false, true)))
	require.Equal(t, "good <mark>alt</mark> text…", excerptHTML(row(true, false)))
	require.Equal(t, "…good <mark>alt</mark> text…", excerptHTML(row(false, false)))
	require.Equal(t, "", excerptHTML(db.SearchPublicPostsRow{}))
}
