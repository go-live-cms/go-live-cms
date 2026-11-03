package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// The block docs shared with the web's duplicatePost.collab.test.ts.
const duplicateVectorsPath = "../web/gl-admin/lib/collaboration/duplicatePost.vectors.json"

type duplicateVectors struct {
	Source    json.RawMessage `json:"source"`
	Duplicate json.RawMessage `json:"duplicate"`
}

func loadDuplicateVectors(t *testing.T) duplicateVectors {
	t.Helper()
	raw, err := os.ReadFile(duplicateVectorsPath)
	require.NoError(t, err)
	var v duplicateVectors
	require.NoError(t, json.Unmarshal(raw, &v))
	return v
}

func decodeDoc(t *testing.T, raw json.RawMessage) map[string]interface{} {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var doc map[string]interface{}
	require.NoError(t, dec.Decode(&doc))
	return doc
}

// requireRegeneratedFrom checks that out is src with every block id replaced:
// the same document once each new id is mapped back to its old one, the
// mapping one-to-one, and no id of src anywhere in out. Returns the mapping.
func requireRegeneratedFrom(t *testing.T, src, out json.RawMessage) map[string]string {
	t.Helper()
	srcDoc, outDoc := decodeDoc(t, src), decodeDoc(t, out)

	ids := map[string]string{}
	used := map[string]bool{}
	bind := func(a, b interface{}) {
		as, ok := a.(string)
		require.True(t, ok, "source id %v is not a string", a)
		bs, ok := b.(string)
		require.True(t, ok, "copy id %v is not a string", b)
		if prev, seen := ids[as]; seen {
			require.Equal(t, prev, bs, "source id %s maps to two ids", as)
			return
		}
		require.False(t, used[bs], "two source ids map to %s", bs)
		ids[as] = bs
		used[bs] = true
	}
	bindAll := func(a, b interface{}) {
		al, _ := a.([]interface{})
		bl, _ := b.([]interface{})
		require.Len(t, bl, len(al))
		for i := range al {
			bind(al[i], bl[i])
		}
	}
	// Anything under a block: equal, except data-block-id values.
	var compare func(a, b interface{})
	compare = func(a, b interface{}) {
		switch av := a.(type) {
		case map[string]interface{}:
			bv, ok := b.(map[string]interface{})
			require.True(t, ok)
			require.Len(t, bv, len(av))
			for key, value := range av {
				other, ok := bv[key]
				require.True(t, ok, "copy lacks %q", key)
				if s, isString := value.(string); isString && key == "data-block-id" {
					bind(s, other)
					continue
				}
				compare(value, other)
			}
		case []interface{}:
			bv, ok := b.([]interface{})
			require.True(t, ok)
			require.Len(t, bv, len(av))
			for i := range av {
				compare(av[i], bv[i])
			}
		default:
			require.Equal(t, a, b)
		}
	}

	require.Equal(t, srcDoc["doc_version"], outDoc["doc_version"])
	bindAll(srcDoc["blocks_order"], outDoc["blocks_order"])
	srcBlocks, _ := srcDoc["blocks"].(map[string]interface{})
	outBlocks, _ := outDoc["blocks"].(map[string]interface{})
	require.Len(t, outBlocks, len(srcBlocks))

	// Top-level blocks are bound by blocks_order, list items by their list's
	// children: compare each block once its key is bound.
	done := map[string]bool{}
	for progress := true; progress; {
		progress = false
		for key, block := range srcBlocks {
			newKey, bound := ids[key]
			if done[key] || !bound {
				continue
			}
			outBlock, ok := outBlocks[newKey].(map[string]interface{})
			require.True(t, ok, "copy has no block %s (from %s)", newKey, key)
			srcBlock := block.(map[string]interface{})
			bind(srcBlock["id"], outBlock["id"])
			require.Equal(t, newKey, outBlock["id"], "block key and id differ")
			if children, ok := srcBlock["children"]; ok {
				bindAll(children, outBlock["children"])
			}
			rest := func(b map[string]interface{}) map[string]interface{} {
				m := map[string]interface{}{}
				for k, v := range b {
					if k != "id" && k != "children" {
						m[k] = v
					}
				}
				return m
			}
			compare(rest(srcBlock), rest(outBlock))
			done[key] = true
			progress = true
		}
	}
	require.Len(t, done, len(srcBlocks), "a source block isn't reachable from blocks_order")

	for old := range ids {
		require.NotContains(t, string(out), `"`+old+`"`, "source id %s survived", old)
	}
	return ids
}

func TestDuplicatePostVectors(t *testing.T) {
	v := loadDuplicateVectors(t)
	// The web test's fixture follows the same rules as the real output.
	ids := requireRegeneratedFrom(t, v.Source, v.Duplicate)
	require.Contains(t, ids, "blk-inner-00001", "a nested pm node's data-block-id is regenerated too")
}

func TestRegenerateBlockIDs(t *testing.T) {
	v := loadDuplicateVectors(t)

	t.Run("every id is new and the doc is otherwise the same", func(t *testing.T) {
		out, err := regenerateBlockIDs(v.Source, uuid.NewString)
		require.NoError(t, err)
		ids := requireRegeneratedFrom(t, v.Source, out)
		// 7 blocks plus the list item's inner paragraph.
		require.Len(t, ids, 8)
		for _, id := range ids {
			_, err := uuid.Parse(id)
			require.NoError(t, err)
		}

		var parsed BlockDocV1
		require.NoError(t, json.Unmarshal(out, &parsed))
		require.Equal(t, []int64{42}, parsed.extractMediaIDsFromBlocks())
	})

	t.Run("two copies share no id", func(t *testing.T) {
		a, err := regenerateBlockIDs(v.Source, uuid.NewString)
		require.NoError(t, err)
		b, err := regenerateBlockIDs(v.Source, uuid.NewString)
		require.NoError(t, err)
		for _, id := range requireRegeneratedFrom(t, v.Source, a) {
			require.NotContains(t, string(b), id)
		}
	})

	t.Run("numbers are kept as written", func(t *testing.T) {
		src := json.RawMessage(`{"doc_version":1,"blocks_order":["blk-image-00001"],"blocks":{"blk-image-00001":{"id":"blk-image-00001","type":"image","version":2,"attrs":{"mediaId":9007199254740993,"width":1.5}}}}`)
		out, err := regenerateBlockIDs(src, uuid.NewString)
		require.NoError(t, err)
		require.Contains(t, string(out), `"mediaId":9007199254740993`)
		require.Contains(t, string(out), `"width":1.5`)
	})

	t.Run("an empty stored doc becomes the empty v1 doc", func(t *testing.T) {
		out, err := regenerateBlockIDs(json.RawMessage(`{}`), uuid.NewString)
		require.NoError(t, err)
		require.JSONEq(t, `{"doc_version":1,"blocks_order":[],"blocks":{}}`, string(out))
	})

	t.Run("a malformed doc is an error", func(t *testing.T) {
		_, err := regenerateBlockIDs(json.RawMessage(`[1,2]`), uuid.NewString)
		require.Error(t, err)
	})
}

func TestCopyNames(t *testing.T) {
	require.Equal(t, "Hello (copy)", copyTitle("Hello"))
	long := copyTitle(strings.Repeat("é", 300))
	require.Len(t, []rune(long), postTitleMax)
	require.True(t, strings.HasSuffix(long, " (copy)"))

	require.Equal(t, "my-post-copy", copySlug("my-post"))
	require.Equal(t, "post-2026-copy", copySlug("2026"))
	slug := copySlug(strings.Repeat("a", 300))
	require.LessOrEqual(t, len([]rune(slug))+len("-99"), postSlugMax)
	require.True(t, strings.HasSuffix(slug, "-copy"))

	require.Equal(t, "https://site.test/post/my-post-copy", copyURL("https://site.test/post/my-post", "my-post", "my-post-copy"))
	require.Equal(t, "https://site.test/p?id=1", copyURL("https://site.test/p?id=1", "my-post", "my-post-copy"))
	// A bare url (older and seeded posts: "<slug>-<n>") or none: the copy's slug.
	require.Equal(t, "x-copy", copyURL("x-1793717212610633263", "x", "x-copy"))
	require.Equal(t, "x-copy", copyURL("", "", "x-copy"))
}

func TestDuplicatePostAPI(t *testing.T) {
	v := loadDuplicateVectors(t)
	editor := db.User{ID: 101, Username: "editor1", Role: RoleEditor}
	contributor := db.User{ID: 103, Username: "contrib1", Role: RoleContributor}
	reader := db.User{ID: 104, Username: "reader1", Role: "user"}
	owner := db.User{ID: 102, Username: "owner1", Role: RoleContributor}

	source := db.Post{
		ID:                 77,
		Title:              "My post",
		Description:        "A post worth copying",
		UserID:             owner.ID,
		Username:           owner.Username,
		Url:                "https://site.test/post/my-post",
		PostType:           "page",
		PostStatus:         "published",
		PostParent:         sql.NullInt64{Int64: 50, Valid: true},
		MenuOrder:          3,
		BlockDoc:           v.Source,
		BlockRevision:      9,
		PublishedVersionID: sql.NullInt64{Int64: 5, Valid: true},
		Slug:               "my-post",
	}
	created := func(arg db.DuplicatePostTxParams) db.Post {
		return db.Post{ID: 500, Title: arg.Title, Description: arg.Description, UserID: arg.UserID, Username: arg.Username,
			Url: arg.Url, PostType: arg.PostType, PostStatus: arg.PostStatus, PostParent: arg.PostParent, Slug: arg.Slug, BlockDoc: arg.BlockDoc}
	}
	slugFree := func(store *mockdb.MockStore, slug string, taken bool) {
		store.EXPECT().CheckSlugExists(gomock.Any(), db.CheckSlugExistsParams{Slug: slug, ExcludeID: 0}).Return(taken, nil)
	}
	urlFree := func(store *mockdb.MockStore, url string) {
		store.EXPECT().CheckURLExists(gomock.Any(), url).Return(false, nil)
	}

	var got db.DuplicatePostTxParams
	capture := func(store *mockdb.MockStore) {
		store.EXPECT().DuplicatePostTx(gomock.Any(), gomock.Any()).Times(1).
			DoAndReturn(func(_ context.Context, arg db.DuplicatePostTxParams) (db.Post, error) {
				got = arg
				return created(arg), nil
			})
	}
	noCopy := func(store *mockdb.MockStore) {
		store.EXPECT().DuplicatePostTx(gomock.Any(), gomock.Any()).Times(0)
	}

	testCases := []struct {
		name       string
		caller     *db.User
		postID     string
		buildStubs func(store *mockdb.MockStore)
		check      func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "editor copies a published post into their own draft",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				slugFree(store, "my-post-copy", false)
				urlFree(store, "https://site.test/post/my-post-copy")
				capture(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
				require.Equal(t, int64(77), got.SourceID)
				require.Equal(t, "My post (copy)", got.Title)
				require.Equal(t, source.Description, got.Description)
				require.Equal(t, editor.ID, got.UserID, "the caller owns the copy")
				require.Equal(t, editor.Username, got.Username)
				require.Equal(t, "draft", got.PostStatus)
				require.Equal(t, "page", got.PostType)
				require.Equal(t, source.PostParent, got.PostParent, "a moderator keeps the parent")
				require.Equal(t, source.MenuOrder, got.MenuOrder)
				require.Equal(t, "my-post-copy", got.Slug)
				require.Equal(t, "https://site.test/post/my-post-copy", got.Url)
				require.Equal(t, []int64{42}, got.ContentMediaIDs)
				requireRegeneratedFrom(t, source.BlockDoc, got.BlockDoc)

				var body struct {
					Post PostResponse `json:"post"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				require.Equal(t, int64(500), body.Post.ID)
				require.Equal(t, "My post (copy)", body.Post.Title)
				require.Equal(t, "draft", body.Post.PostStatus)
			},
		},
		{
			name:   "duplicating twice: the slug and url stay unique",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				slugFree(store, "my-post-copy", true)
				slugFree(store, "my-post-copy-2", false)
				urlFree(store, "https://site.test/post/my-post-copy-2")
				capture(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
				require.Equal(t, "my-post-copy-2", got.Slug)
				require.Equal(t, "https://site.test/post/my-post-copy-2", got.Url)
			},
		},
		{
			name:   "contributor copies another user's post; the parent they can't edit is dropped",
			caller: &contributor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				store.EXPECT().GetPost(gomock.Any(), int64(50)).Return(db.Post{ID: 50, UserID: owner.ID, PostStatus: "draft"}, nil)
				slugFree(store, "my-post-copy", false)
				urlFree(store, "https://site.test/post/my-post-copy")
				capture(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
				require.Equal(t, contributor.ID, got.UserID)
				require.Equal(t, "draft", got.PostStatus)
				require.False(t, got.PostParent.Valid)
			},
		},
		{
			name:   "contributor keeps a parent they own",
			caller: &contributor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				store.EXPECT().GetPost(gomock.Any(), int64(50)).Return(db.Post{ID: 50, UserID: contributor.ID, PostStatus: "published"}, nil)
				slugFree(store, "my-post-copy", false)
				urlFree(store, "https://site.test/post/my-post-copy")
				capture(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
				require.Equal(t, source.PostParent, got.PostParent)
			},
		},
		{
			name:   "contributor: a parent that's gone is dropped",
			caller: &contributor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				store.EXPECT().GetPost(gomock.Any(), int64(50)).Return(db.Post{}, sql.ErrNoRows)
				slugFree(store, "my-post-copy", false)
				urlFree(store, "https://site.test/post/my-post-copy")
				capture(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
				require.False(t, got.PostParent.Valid)
			},
		},
		{
			name:   "contributor: the parent lookup fails",
			caller: &contributor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				store.EXPECT().GetPost(gomock.Any(), int64(50)).Return(db.Post{}, sql.ErrConnDone)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "a user without read access is refused",
			caller: &reader,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:   "no token",
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "missing post",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(db.Post{}, sql.ErrNoRows)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "post lookup fails",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(db.Post{}, sql.ErrConnDone)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "invalid id",
			caller: &editor,
			postID: "abc",
			buildStubs: func(store *mockdb.MockStore) {
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "a concurrent writer took the slug",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				slugFree(store, "my-post-copy", false)
				urlFree(store, "https://site.test/post/my-post-copy")
				store.EXPECT().DuplicatePostTx(gomock.Any(), gomock.Any()).
					Return(db.Post{}, errors.New(`pq: duplicate key value violates unique constraint "idx_posts_slug"`))
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
				require.Contains(t, recorder.Body.String(), "slug already exists")
			},
		},
		{
			name:   "the transaction fails",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				slugFree(store, "my-post-copy", false)
				urlFree(store, "https://site.test/post/my-post-copy")
				store.EXPECT().DuplicatePostTx(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrConnDone)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "a source block_doc that isn't a JSON object",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				broken := source
				broken.BlockDoc = json.RawMessage(`[]`)
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(broken, nil)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "the slug lookup fails",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, sql.ErrConnDone)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "x-copy … x-copy-99 all taken: a random suffix",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil)
				store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).AnyTimes().
					DoAndReturn(func(_ context.Context, arg db.CheckSlugExistsParams) (bool, error) {
						return regexp.MustCompile(`^my-post-copy(-\d+)?$`).MatchString(arg.Slug), nil
					})
				store.EXPECT().CheckURLExists(gomock.Any(), gomock.Any()).Return(false, nil)
				capture(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
				require.Regexp(t, `^my-post-copy-[0-9a-f]{8}$`, got.Slug)
				require.Equal(t, "https://site.test/post/"+got.Slug, got.Url)
			},
		},
		{
			name:   "the read after the flush fails",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				gomock.InOrder(
					store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(source, nil),
					store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(db.Post{}, sql.ErrConnDone),
				)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "the url lookup fails",
			caller: &editor,
			postID: "77",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(2).Return(source, nil) // before and after the flush
				slugFree(store, "my-post-copy", false)
				store.EXPECT().CheckURLExists(gomock.Any(), gomock.Any()).Return(false, sql.ErrConnDone)
				noCopy(store)
			},
			check: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got = db.DuplicatePostTxParams{}
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			if tc.caller != nil {
				stubRoleLookup(store, *tc.caller)
			}

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()
			request, err := http.NewRequest(http.MethodPost, "/api/v1/posts/"+tc.postID+"/duplicate", nil)
			require.NoError(t, err)
			if tc.caller != nil {
				addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, tc.caller.ID, tc.caller.Username, time.Minute)
			}
			server.router.ServeHTTP(recorder, request)
			tc.check(t, recorder)
		})
	}
}

// The copy is read after the collab server stored the last edits (as for
// publish); if the flush fails nothing is copied.
func TestDuplicatePostFlushesCollab(t *testing.T) {
	v := loadDuplicateVectors(t)
	editor := db.User{ID: 101, Username: "editor1", Role: RoleEditor}
	source := db.Post{ID: 77, Title: "My post", Slug: "my-post", Url: "https://site.test/post/my-post", PostType: "post", BlockDoc: v.Source}

	run := func(t *testing.T, collab http.HandlerFunc, buildStubs func(store *mockdb.MockStore)) *httptest.ResponseRecorder {
		server := httptest.NewServer(collab)
		t.Cleanup(server.Close)
		store := mockdb.NewMockStore(gomock.NewController(t))
		buildStubs(store)
		stubRoleLookup(store, editor)
		api := newCollabTestServer(t, store, server.URL)
		recorder := httptest.NewRecorder()
		request, err := http.NewRequest(http.MethodPost, "/api/v1/posts/77/duplicate", nil)
		require.NoError(t, err)
		addAuthorization(t, request, api.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
		api.router.ServeHTTP(recorder, request)
		return recorder
	}

	t.Run("copies what the flush stored", func(t *testing.T) {
		var flushed atomic.Bool
		var path string
		stored := source
		stored.BlockDoc = v.Duplicate // stands in for "the doc after the last store"
		var got db.DuplicatePostTxParams
		recorder := run(t, func(w http.ResponseWriter, r *http.Request) {
			path = r.URL.Path
			flushed.Store(true)
			w.WriteHeader(http.StatusOK)
		}, func(store *mockdb.MockStore) {
			gomock.InOrder(
				store.EXPECT().GetPost(gomock.Any(), int64(77)).Return(source, nil),
				store.EXPECT().GetPost(gomock.Any(), int64(77)).DoAndReturn(func(context.Context, int64) (db.Post, error) {
					require.True(t, flushed.Load(), "block_doc was read before the flush")
					return stored, nil
				}),
			)
			store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).Return(false, nil)
			store.EXPECT().CheckURLExists(gomock.Any(), gomock.Any()).Return(false, nil)
			store.EXPECT().DuplicatePostTx(gomock.Any(), gomock.Any()).
				DoAndReturn(func(_ context.Context, arg db.DuplicatePostTxParams) (db.Post, error) {
					got = arg
					return db.Post{ID: 500}, nil
				})
		})
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		require.Equal(t, "/internal/documents/post-77/flush", path)
		requireRegeneratedFrom(t, v.Duplicate, got.BlockDoc)
	})

	t.Run("a failed flush copies nothing", func(t *testing.T) {
		recorder := run(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		}, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(77)).Times(1).Return(source, nil)
			store.EXPECT().DuplicatePostTx(gomock.Any(), gomock.Any()).Times(0)
		})
		require.Equal(t, http.StatusServiceUnavailable, recorder.Code)
		require.Contains(t, recorder.Body.String(), "nothing was duplicated")
	})
}

// End to end against the test database (CI's Postgres; skipped without one):
// two duplicates of one post get distinct slugs and urls and no shared block
// id, and the source keeps its own.
func TestDuplicatePostTwiceDB(t *testing.T) {
	config, err := util.LoadConfig("..")
	if err != nil || config.DBSource == "" {
		t.Skip("no test database configured")
	}
	conn, err := sql.Open(config.DBDriver, config.DBSource)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	if err := conn.Ping(); err != nil {
		t.Skipf("test database unreachable: %v", err)
	}
	store := db.NewStore(conn)
	ctx := context.Background()
	suffix := time.Now().UnixNano()

	user, err := store.CreateUser(ctx, db.CreateUserParams{
		Username:       fmt.Sprintf("dup%d", suffix),
		FullName:       "Dup Tester",
		Email:          fmt.Sprintf("dup%d@example.test", suffix),
		HashedPassword: "x",
		Role:           RoleContributor,
	})
	require.NoError(t, err)
	v := loadDuplicateVectors(t)
	slug := fmt.Sprintf("dup-twice-%d", suffix)
	src, err := store.CreatePostTx(ctx, db.CreatePostTxParams{
		CreatePostsParams: db.CreatePostsParams{
			Title: "Twice", Description: "Duplicated twice", UserID: user.ID, Username: user.Username,
			Url: "https://site.test/post/" + slug, PostType: "post", PostStatus: "draft", Slug: slug, BlockDoc: v.Source,
		},
		AuthorIDs: []int64{user.ID},
	})
	require.NoError(t, err)

	server := newTestServer(t, store)
	duplicate := func() PostResponse {
		recorder := httptest.NewRecorder()
		request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/duplicate", src.Post.ID), nil)
		require.NoError(t, err)
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
		server.router.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		var body struct {
			Post PostResponse `json:"post"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return body.Post
	}
	first, second := duplicate(), duplicate()

	require.Equal(t, slug+"-copy", first.Slug)
	require.Equal(t, slug+"-copy-2", second.Slug)
	require.NotEqual(t, first.Url, second.Url)

	docs := map[int64]json.RawMessage{}
	for _, id := range []int64{first.ID, second.ID} {
		post, err := store.GetPost(ctx, id)
		require.NoError(t, err)
		require.Equal(t, user.ID, post.UserID)
		requireRegeneratedFrom(t, v.Source, post.BlockDoc)
		docs[id] = post.BlockDoc
	}
	for _, id := range requireRegeneratedFrom(t, v.Source, docs[first.ID]) {
		require.NotContains(t, string(docs[second.ID]), id)
	}

	after, err := store.GetPost(ctx, src.Post.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(src.Post.BlockDoc), string(after.BlockDoc), "the source is untouched")
}
