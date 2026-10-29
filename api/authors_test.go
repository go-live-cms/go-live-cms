package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The only keys a public author may carry (#350).
var authorProfileKeys = []string{"avatar", "bio", "full_name", "username", "website"}

func publicAuthorRow(postCount int64) db.GetPublicAuthorRow {
	return db.GetPublicAuthorRow{
		ID:        42,
		Username:  "anacosta",
		FullName:  "Ana Costa",
		Bio:       "Edits this blog.",
		Website:   "https://anacosta.example",
		PostCount: postCount,
	}
}

func getPublic(t *testing.T, store *mockdb.MockStore, path string) *httptest.ResponseRecorder {
	t.Helper()
	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()
	request, err := http.NewRequest(http.MethodGet, path, nil)
	require.NoError(t, err)
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func sortedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// requireOnlyAuthorKeys fails if an author object has any key beyond the
// public ones: email, role, ids, password or session data must never appear.
func requireOnlyAuthorKeys(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var author map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &author))
	require.Equal(t, authorProfileKeys, sortedKeys(author))
}

// The serializer itself: whatever the row holds, only the public keys come out.
func TestAuthorProfileResponseKeys(t *testing.T) {
	user := randomUserNew()
	user.Bio = "Bio"
	user.Website = "https://example.com"
	data, err := json.Marshal(toAuthorProfile(user.Username, user.FullName, user.Bio, user.Website))
	require.NoError(t, err)
	requireOnlyAuthorKeys(t, data)
	require.NotContains(t, string(data), user.Email)
	require.NotContains(t, string(data), user.HashedPassword)
	require.Contains(t, string(data), `"avatar":null`)
}

func TestGetPublicAuthorAPI(t *testing.T) {
	testCases := []struct {
		name       string
		buildStubs func(store *mockdb.MockStore)
		check      func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPublicAuthor(gomock.Any(), "anacosta").Times(1).Return(publicAuthorRow(4), nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
				var body map[string]json.RawMessage
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				require.Equal(t, []string{"author", "post_count"}, sortedKeys(body))
				requireOnlyAuthorKeys(t, body["author"])
				require.JSONEq(t, `4`, string(body["post_count"]))
				require.JSONEq(t, `{"username":"anacosta","full_name":"Ana Costa","avatar":null,"bio":"Edits this blog.","website":"https://anacosta.example"}`, string(body["author"]))
			},
		},
		{
			// Credited on nothing published (drafts only, or nothing at all).
			name: "NotCredited",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPublicAuthor(gomock.Any(), "anacosta").Times(1).Return(publicAuthorRow(0), nil)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "UnknownUsername",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPublicAuthor(gomock.Any(), "anacosta").Times(1).Return(db.GetPublicAuthorRow{}, sql.ErrNoRows)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPublicAuthor(gomock.Any(), "anacosta").Times(1).Return(db.GetPublicAuthorRow{}, errors.New("boom"))
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			tc.check(t, getPublic(t, store, "/public/authors/anacosta"))
		})
	}
}

// An uncredited user and an unknown username must be indistinguishable, or the
// endpoint tells anyone which usernames exist.
func TestPublicAuthorNotFoundIsIdentical(t *testing.T) {
	bodies := map[string]string{}
	for name, stub := range map[string]func(*mockdb.MockStore){
		"unknown": func(store *mockdb.MockStore) {
			store.EXPECT().GetPublicAuthor(gomock.Any(), gomock.Any()).AnyTimes().Return(db.GetPublicAuthorRow{}, sql.ErrNoRows)
		},
		"uncredited": func(store *mockdb.MockStore) {
			store.EXPECT().GetPublicAuthor(gomock.Any(), gomock.Any()).AnyTimes().Return(publicAuthorRow(0), nil)
		},
	} {
		for _, path := range []string{"/public/authors/anacosta", "/public/authors/anacosta/posts"} {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stub(store)
			store.EXPECT().ListPublishedPostsByAuthor(gomock.Any(), gomock.Any()).Times(0)
			recorder := getPublic(t, store, path)
			require.Equal(t, http.StatusNotFound, recorder.Code)
			// The request id differs per request; everything else must match.
			var body map[string]any
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			delete(body, "request_id")
			encoded, err := json.Marshal(body)
			require.NoError(t, err)
			bodies[name+" "+path] = string(encoded)
		}
	}
	for _, path := range []string{"/public/authors/anacosta", "/public/authors/anacosta/posts"} {
		require.Equal(t, bodies["unknown "+path], bodies["uncredited "+path], path)
	}
}

func TestListPublicAuthorPostsAPI(t *testing.T) {
	t.Run("OK", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetPublicAuthor(gomock.Any(), "anacosta").Times(1).Return(publicAuthorRow(12), nil)
		store.EXPECT().
			ListPublishedPostsByAuthor(gomock.Any(), db.ListPublishedPostsByAuthorParams{UserID: 42, LimitCount: 5, OffsetCount: 10}).
			Times(1).
			Return([]db.ListPublishedPostsByAuthorRow{{
				ID: 7, Title: "Hello", PostType: "post", PostStatus: "published", Slug: "hello",
				Meta:    []byte(`{}`),
				Authors: json.RawMessage(`[{"id":42,"username":"anacosta","full_name":"Ana Costa"}]`),
			}}, nil)

		recorder := getPublic(t, store, "/public/authors/anacosta/posts?limit=5&offset=10")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var body struct {
			Author json.RawMessage        `json:"author"`
			Posts  []PostWithMetaResponse `json:"posts"`
			Meta   struct {
				Total  int64 `json:"total"`
				Limit  int64 `json:"limit"`
				Offset int64 `json:"offset"`
				Count  int   `json:"count"`
			} `json:"meta"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		requireOnlyAuthorKeys(t, body.Author)
		require.Len(t, body.Posts, 1)
		require.Equal(t, "Hello", body.Posts[0].Title)
		require.Equal(t, []PostAuthorResponse{{ID: 42, Username: "anacosta", FullName: "Ana Costa"}}, body.Posts[0].Authors)
		require.Equal(t, int64(12), body.Meta.Total)
		require.Equal(t, int64(5), body.Meta.Limit)
		require.Equal(t, int64(10), body.Meta.Offset)
		require.Equal(t, 1, body.Meta.Count)
		require.NotContains(t, recorder.Body.String(), "email")
	})

	t.Run("CapsLimit", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetPublicAuthor(gomock.Any(), "anacosta").Return(publicAuthorRow(1), nil)
		store.EXPECT().
			ListPublishedPostsByAuthor(gomock.Any(), db.ListPublishedPostsByAuthorParams{UserID: 42, LimitCount: authorPostsMaxLimit, OffsetCount: 0}).
			Return([]db.ListPublishedPostsByAuthorRow{}, nil)
		recorder := getPublic(t, store, "/public/authors/anacosta/posts?limit=5000")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"posts":[]`)
	})

	for _, query := range []string{"limit=0", "limit=x", "offset=-1", "offset=x"} {
		t.Run("BadQuery_"+query, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetPublicAuthor(gomock.Any(), gomock.Any()).Times(0)
			recorder := getPublic(t, store, "/public/authors/anacosta/posts?"+query)
			require.Equal(t, http.StatusBadRequest, recorder.Code)
		})
	}

	t.Run("InternalError", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetPublicAuthor(gomock.Any(), "anacosta").Return(publicAuthorRow(1), nil)
		store.EXPECT().ListPublishedPostsByAuthor(gomock.Any(), gomock.Any()).Return(nil, errors.New("boom"))
		require.Equal(t, http.StatusInternalServerError, getPublic(t, store, "/public/authors/anacosta/posts").Code)
	})
}

func TestListPublicPostAuthorsAPI(t *testing.T) {
	t.Run("OK", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ListPostAuthorProfiles(gomock.Any(), int64(7)).Times(1).Return([]db.ListPostAuthorProfilesRow{
			{ID: 1, Username: "luan", FullName: "Luan", Bio: "Builds the editor.", Website: ""},
			{ID: 42, Username: "anacosta", FullName: "Ana Costa", Bio: "", Website: "https://anacosta.example"},
		}, nil)
		recorder := getPublic(t, store, "/public/posts/7/authors")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var body struct {
			Authors []json.RawMessage `json:"authors"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Len(t, body.Authors, 2)
		for _, a := range body.Authors {
			requireOnlyAuthorKeys(t, a)
		}
		require.Contains(t, string(body.Authors[0]), `"username":"luan"`)
	})

	t.Run("NotPublic", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ListPostAuthorProfiles(gomock.Any(), int64(7)).Return([]db.ListPostAuthorProfilesRow{}, nil)
		recorder := getPublic(t, store, "/public/posts/7/authors")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"authors":[]}`, recorder.Body.String())
	})

	t.Run("BadID", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		require.Equal(t, http.StatusBadRequest, getPublic(t, store, "/public/posts/abc/authors").Code)
	})

	t.Run("InternalError", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ListPostAuthorProfiles(gomock.Any(), int64(7)).Return(nil, errors.New("boom"))
		require.Equal(t, http.StatusInternalServerError, getPublic(t, store, "/public/posts/7/authors").Code)
	})
}

func TestListPublicAuthorsAPI(t *testing.T) {
	changed := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

	t.Run("OK", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().
			ListPublicAuthors(gomock.Any(), db.ListPublicAuthorsParams{LimitCount: publicAuthorsMaxLimit, OffsetCount: 0}).
			Return([]db.ListPublicAuthorsRow{{Username: "anacosta", LastModified: changed}}, nil)
		recorder := getPublic(t, store, "/public/authors")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.JSONEq(t, `{"authors":[{"username":"anacosta","last_modified":"2026-10-27T12:00:00Z"}]}`, recorder.Body.String())
	})

	t.Run("BadQuery", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		require.Equal(t, http.StatusBadRequest, getPublic(t, store, "/public/authors?offset=-3").Code)
	})

	t.Run("InternalError", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().ListPublicAuthors(gomock.Any(), gomock.Any()).Return(nil, errors.New("boom"))
		require.Equal(t, http.StatusInternalServerError, getPublic(t, store, "/public/authors").Code)
	})
}

// Bio and website on PUT /users/:id (#350).
func TestUpdateUserAuthorProfile(t *testing.T) {
	testCases := []struct {
		name        string
		body        string
		wantStatus  int
		wantField   string
		wantBio     sql.NullString
		wantWebsite sql.NullString
	}{
		{
			name:        "SetsBoth",
			body:        `{"bio":"  Edits this blog.\r\nAnd docs.  ","website":" https://anacosta.example/about "}`,
			wantStatus:  http.StatusOK,
			wantBio:     sql.NullString{String: "Edits this blog.\nAnd docs.", Valid: true},
			wantWebsite: sql.NullString{String: "https://anacosta.example/about", Valid: true},
		},
		{
			name:        "AbsentKeepsStored",
			body:        `{"full_name":"Ana Costa"}`,
			wantStatus:  http.StatusOK,
			wantBio:     sql.NullString{},
			wantWebsite: sql.NullString{},
		},
		{
			name:        "EmptyClears",
			body:        `{"bio":"","website":""}`,
			wantStatus:  http.StatusOK,
			wantBio:     sql.NullString{String: "", Valid: true},
			wantWebsite: sql.NullString{String: "", Valid: true},
		},
		{
			// 300 characters, multi-byte: the limit counts characters.
			name:       "BioAtLimit",
			body:       fmt.Sprintf(`{"bio":%q}`, strings.Repeat("é", bioMaxChars)),
			wantStatus: http.StatusOK,
			wantBio:    sql.NullString{String: strings.Repeat("é", bioMaxChars), Valid: true},
		},
		{name: "BioTooLong", body: fmt.Sprintf(`{"bio":%q}`, strings.Repeat("a", bioMaxChars+1)), wantStatus: http.StatusBadRequest, wantField: "bio"},
		{name: "BioWayTooLong", body: fmt.Sprintf(`{"bio":%q}`, strings.Repeat("a", 1001)), wantStatus: http.StatusBadRequest, wantField: "bio"},
		{name: "BioControlChars", body: `{"bio":"hi\u0007there"}`, wantStatus: http.StatusBadRequest, wantField: "bio"},
		{name: "WebsiteNotURL", body: `{"website":"anacosta.example"}`, wantStatus: http.StatusBadRequest, wantField: "website"},
		{name: "WebsiteJavascript", body: `{"website":"javascript:alert(1)"}`, wantStatus: http.StatusBadRequest, wantField: "website"},
		{name: "WebsiteFTP", body: `{"website":"ftp://anacosta.example"}`, wantStatus: http.StatusBadRequest, wantField: "website"},
		{name: "WebsiteNoHost", body: `{"website":"https://"}`, wantStatus: http.StatusBadRequest, wantField: "website"},
		{name: "WebsiteTooLong", body: fmt.Sprintf(`{"website":"https://a.example/%s"}`, strings.Repeat("a", 2048)), wantStatus: http.StatusBadRequest, wantField: "website"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			user := validationTestUser("contributor")
			stubRoleLookup(store, user)
			if tc.wantStatus == http.StatusOK {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(1).
					DoAndReturn(func(_ any, arg db.UpdateUserTxParams) (db.UpdateUserTxResult, error) {
						require.Equal(t, tc.wantBio, arg.Bio)
						require.Equal(t, tc.wantWebsite, arg.Website)
						updated := user
						updated.Bio = arg.Bio.String
						updated.Website = arg.Website.String
						return db.UpdateUserTxResult{User: updated}, nil
					})
			} else {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			}

			server := newTestServer(t, store)
			recorder := sendAs(t, server, &user, http.MethodPut, fmt.Sprintf("/api/v1/users/%d", user.ID), []byte(tc.body))
			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.wantField != "" {
				require.Contains(t, decodeErrorBody(t, recorder).Fields, tc.wantField)
			} else {
				// The caller's own (private) shape carries the fields back.
				var body struct {
					User PrivateUserResponse `json:"user"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				require.Equal(t, tc.wantBio.String, body.User.Bio)
				require.Equal(t, tc.wantWebsite.String, body.User.Website)
			}
		})
	}
}
