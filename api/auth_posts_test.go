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

// Document-level permissions (#135): every role × ownership × status case for
// the per-post write routes. The expected outcome is spelled out here from
// the model (auth_posts.go's package doc), not by calling the helpers.

type postPermActor struct {
	name      string
	user      db.User
	moderator bool
	owner     bool
}

func postPermActors() (actors []postPermActor, ownerID int64) {
	mk := func(id int64, role string) db.User {
		return db.User{ID: id, Username: fmt.Sprintf("user%d", id), Role: role, PasswordChangedAt: time.Now().Add(-time.Hour)}
	}
	owner := mk(103, RoleContributor)
	return []postPermActor{
		{name: "Admin", user: mk(101, RoleAdmin), moderator: true},
		{name: "Editor", user: mk(102, RoleEditor), moderator: true},
		{name: "ContributorOwner", user: owner, owner: true},
		{name: "ContributorOther", user: mk(104, RoleContributor)},
	}, owner.ID
}

// postPermRoute is one per-post write route. allowed is the model's verdict;
// stubs must forbid the write itself (Times(0)) when allowed is false.
type postPermRoute struct {
	name    string
	method  string
	path    func(post db.Post) string
	body    func(post db.Post) any
	header  map[string]string
	allowed func(a postPermActor, post db.Post) bool
	stubs   func(store *mockdb.MockStore, post db.Post, allowed bool)
	// okCode is the status an allowed request gets. 0 means "anything but
	// 401/403" (the handler's own result depends on stubs not set up here).
	okCode int
}

func timesIf(allowed bool) int {
	if allowed {
		return 1
	}
	return 0
}

func liveFieldsAllowed(a postPermActor, post db.Post) bool {
	return a.moderator || (a.owner && post.PostStatus != "published")
}

func workingCopyAllowed(a postPermActor, _ db.Post) bool {
	return a.moderator || a.owner
}

func moderatorOnly(a postPermActor, _ db.Post) bool {
	return a.moderator
}

func postPermRoutes() []postPermRoute {
	emptyDoc := json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)
	return []postPermRoute{
		{
			name:    "UpdatePost",
			method:  http.MethodPut,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d", p.ID) },
			body:    func(db.Post) any { return gin.H{"title": "A new title"} },
			allowed: liveFieldsAllowed,
			okCode:  http.StatusOK,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(p, nil)
			},
		},
		{
			name:    "DeletePost",
			method:  http.MethodDelete,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d", p.ID) },
			allowed: liveFieldsAllowed,
			okCode:  http.StatusOK,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().DeletePostTx(gomock.Any(), p.ID).Times(timesIf(allowed)).Return(nil)
			},
		},
		{
			name:    "SetPostMeta",
			method:  http.MethodPost,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/meta", p.ID) },
			body:    func(db.Post) any { return gin.H{"meta_key": "seo_title", "meta_value": "x"} },
			allowed: liveFieldsAllowed,
			okCode:  http.StatusOK,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().UpsertPostMeta(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(db.PostMetum{PostID: p.ID}, nil)
			},
		},
		{
			name:    "LinkPostMedia",
			method:  http.MethodPost,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/media", p.ID) },
			body:    func(db.Post) any { return gin.H{"media_id": 5, "order": 1} },
			allowed: liveFieldsAllowed,
			okCode:  http.StatusCreated,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().CreatePostMedia(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(db.PostMedium{PostID: p.ID, MediaID: 5}, nil)
			},
		},
		{
			name:    "SaveBlocks",
			method:  http.MethodPut,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/blocks", p.ID) },
			body:    func(db.Post) any { return gin.H{"doc": emptyDoc} },
			header:  map[string]string{"If-Match": "1"},
			allowed: workingCopyAllowed,
			okCode:  http.StatusOK,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).
					Return(db.UpdatePostBlocksIfRevisionMatchesRow{Content: emptyDoc, Revision: 2}, nil)
				// Skipped for an owner on a published post (live links); see the
				// dedicated test below.
				store.EXPECT().GetMediaByPostWithOrder(gomock.Any(), p.ID).AnyTimes().Return(nil, nil)
			},
		},
		{
			name:    "UnlinkPostMedia",
			method:  http.MethodDelete,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/media/5", p.ID) },
			allowed: liveFieldsAllowed,
			okCode:  http.StatusOK,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().DeletePostMedia(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(nil)
			},
		},
		{
			name:    "DeletePostMeta",
			method:  http.MethodDelete,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/meta/seo_title", p.ID) },
			allowed: liveFieldsAllowed,
			okCode:  http.StatusOK,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().GetPostMetaByKey(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(db.PostMetum{PostID: p.ID}, nil)
				store.EXPECT().DeletePostMeta(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(nil)
			},
		},
		{
			name:    "SetFeaturedImage",
			method:  http.MethodPost,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/featured-image", p.ID) },
			body:    func(db.Post) any { return gin.H{"media_id": 5} },
			allowed: liveFieldsAllowed,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().GetMedia(gomock.Any(), int64(5)).Times(timesIf(allowed)).Return(db.Medium{ID: 5, MediaPath: "/app/uploads/media/x.png"}, nil)
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(nil)
			},
		},
		{
			name:    "RemoveFeaturedImage",
			method:  http.MethodDelete,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/featured-image", p.ID) },
			allowed: liveFieldsAllowed,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
				store.EXPECT().ExecTx(gomock.Any(), gomock.Any()).Times(timesIf(allowed)).Return(nil)
			},
		},
		{
			name:    "CollabTicket",
			method:  http.MethodPost,
			path:    func(db.Post) string { return "/api/v1/collab/tickets" },
			body:    func(p db.Post) any { return gin.H{"doc": fmt.Sprintf("post-%d", p.ID)} },
			allowed: workingCopyAllowed,
			okCode:  http.StatusOK,
			stubs: func(store *mockdb.MockStore, p db.Post, _ bool) {
				store.EXPECT().GetPost(gomock.Any(), p.ID).Return(p, nil).AnyTimes()
			},
		},
		{
			name:    "Publish",
			method:  http.MethodPost,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/publish", p.ID) },
			allowed: moderatorOnly,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				// An allowed publish stops at the (stubbed) missing working copy.
				store.EXPECT().GetPostBlocks(gomock.Any(), p.ID).Times(timesIf(allowed)).Return(db.GetPostBlocksRow{}, sql.ErrNoRows)
			},
		},
		{
			name:    "Unpublish",
			method:  http.MethodPost,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/unpublish", p.ID) },
			allowed: moderatorOnly,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().UnpublishPost(gomock.Any(), p.ID).Times(timesIf(allowed)).Return(db.Post{}, errors.New("stub"))
			},
		},
		{
			name:    "ListVersions",
			method:  http.MethodGet,
			path:    func(p db.Post) string { return fmt.Sprintf("/api/v1/posts/%d/versions", p.ID) },
			allowed: moderatorOnly,
			stubs: func(store *mockdb.MockStore, p db.Post, allowed bool) {
				store.EXPECT().GetPostVersions(gomock.Any(), p.ID).Times(timesIf(allowed)).Return(nil, nil)
			},
		},
	}
}

func TestPostPermissionsMatrix(t *testing.T) {
	actors, ownerID := postPermActors()

	for _, status := range []string{"draft", "published"} {
		post := db.Post{ID: 77, UserID: ownerID, Username: "user103", PostStatus: status, Url: "https://example.com/p", PostType: "post", Title: "Title", Description: "A description"}

		for _, route := range postPermRoutes() {
			for _, actor := range actors {
				allowed := route.allowed(actor, post)
				t.Run(fmt.Sprintf("%s/%s/%s", route.name, status, actor.name), func(t *testing.T) {
					ctrl := gomock.NewController(t)
					defer ctrl.Finish()

					store := mockdb.NewMockStore(ctrl)
					route.stubs(store, post, allowed)
					stubRoleLookup(store, actor.user)

					server := newTestServer(t, store)
					recorder := servePostPermRequest(t, server, actor.user, route.method, route.path(post), route.body, post, route.header)

					switch {
					case !allowed:
						require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
					case route.okCode != 0:
						require.Equal(t, route.okCode, recorder.Code, recorder.Body.String())
					default:
						require.NotEqual(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
						require.NotEqual(t, http.StatusUnauthorized, recorder.Code, recorder.Body.String())
					}
				})
			}
		}
	}
}

func servePostPermRequest(t *testing.T, server *Server, user db.User, method, path string, body func(db.Post) any, post db.Post, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		data, err := json.Marshal(body(post))
		require.NoError(t, err)
		reader = bytes.NewReader(data)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequest(method, path, reader)
	require.NoError(t, err)
	for k, v := range header {
		request.Header.Set(k, v)
	}
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// A contributor's owner check needs the post row: a missing post is 404.
func TestPostPermissionsMissingPost(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	contributor := db.User{ID: 5, Username: "c", Role: RoleContributor}
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetPost(gomock.Any(), int64(404)).Return(db.Post{}, sql.ErrNoRows).Times(1)
	store.EXPECT().UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).Times(0)
	stubRoleLookup(store, contributor)

	server := newTestServer(t, store)
	recorder := servePostPermRequest(t, server, contributor, http.MethodPut, "/api/v1/posts/404/blocks",
		func(db.Post) any {
			return gin.H{"doc": json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)}
		},
		db.Post{}, map[string]string{"If-Match": "1"})
	require.Equal(t, http.StatusNotFound, recorder.Code)
}

// Contributors may create posts, but only drafts they own themselves.
func TestCreatePostAsContributor(t *testing.T) {
	contributor := db.User{ID: 31, Username: "contrib", Role: RoleContributor}
	editor := db.User{ID: 32, Username: "ed", Role: RoleEditor}

	testCases := []struct {
		name   string
		caller db.User
		body   gin.H
		want   int
	}{
		{name: "OwnDraft", caller: contributor, body: gin.H{"author_ids": []int64{contributor.ID}}, want: http.StatusCreated},
		{name: "OwnExplicitDraft", caller: contributor, body: gin.H{"author_ids": []int64{contributor.ID}, "post_status": "draft"}, want: http.StatusCreated},
		{name: "OwnPublished", caller: contributor, body: gin.H{"author_ids": []int64{contributor.ID}, "post_status": "published"}, want: http.StatusForbidden},
		{name: "SomeoneElsesDraft", caller: contributor, body: gin.H{"author_ids": []int64{editor.ID}}, want: http.StatusForbidden},
		{name: "CoAuthored", caller: contributor, body: gin.H{"author_ids": []int64{contributor.ID, editor.ID}}, want: http.StatusForbidden},
		{name: "EditorPublishesForContributor", caller: editor, body: gin.H{"author_ids": []int64{contributor.ID}, "post_status": "published"}, want: http.StatusCreated},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			created := tc.want == http.StatusCreated
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().CheckURLExists(gomock.Any(), gomock.Any()).Times(timesIf(created)).Return(false, nil)
			store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).AnyTimes().Return(false, nil)
			store.EXPECT().CreatePostTx(gomock.Any(), gomock.Any()).Times(timesIf(created)).
				DoAndReturn(func(_ any, arg db.CreatePostTxParams) (db.CreatePostTxResult, error) {
					return db.CreatePostTxResult{Post: db.Post{ID: 9, UserID: arg.UserID, PostStatus: arg.PostStatus}}, nil
				})
			store.EXPECT().SetPublishedVersionOnPost(gomock.Any(), gomock.Any()).AnyTimes().Return(nil)
			stubRoleLookup(store, contributor)
			stubRoleLookup(store, editor)

			body := gin.H{"title": "My post", "description": "A long enough description", "url": "https://example.com/my-post"}
			for k, v := range tc.body {
				body[k] = v
			}

			server := newTestServer(t, store)
			recorder := servePostPermRequest(t, server, tc.caller, http.MethodPost, "/api/v1/posts", func(db.Post) any { return body }, db.Post{}, nil)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		})
	}
}

// PUT /posts/:id can set post_status, which is publishing by another route:
// a contributor may save their draft but not change its status.
func TestUpdatePostStatusAsContributor(t *testing.T) {
	contributor := db.User{ID: 41, Username: "contrib", Role: RoleContributor}
	post := db.Post{ID: 8, UserID: contributor.ID, PostStatus: "draft", Title: "T", Description: "D", Url: "https://example.com/x"}

	for _, tc := range []struct {
		status string
		want   int
	}{
		{status: "draft", want: http.StatusOK},
		{status: "published", want: http.StatusForbidden},
		{status: "archived", want: http.StatusForbidden},
	} {
		t.Run(tc.status, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil).Times(1)
			store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(timesIf(tc.want == http.StatusOK)).Return(post, nil)
			stubRoleLookup(store, contributor)

			server := newTestServer(t, store)
			recorder := servePostPermRequest(t, server, contributor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID),
				func(db.Post) any { return gin.H{"post_status": tc.status} }, post, nil)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		})
	}
}

// A contributor's block save on their published post reaches the working copy
// (which goes live only on publish) but never the live fields: a changed title
// is refused outright (403, nothing saved) rather than dropped behind a 200,
// the unchanged title every autosave sends is fine, and post_media links are
// left for publishPost to sync. The post is loaded once.
func TestSaveBlocksOnPublishedPostAsContributor(t *testing.T) {
	contributor := db.User{ID: 51, Username: "contrib", Role: RoleContributor}
	post := db.Post{ID: 9, UserID: contributor.ID, PostStatus: "published", Title: "Live title"}
	emptyDoc := json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)

	for _, tc := range []struct {
		name  string
		title string
		want  int
	}{
		{name: "ChangedTitleRefused", title: "Sneaky new title", want: http.StatusForbidden},
		{name: "UnchangedTitleSaves", title: post.Title, want: http.StatusOK},
		{name: "NoTitleSaves", title: "", want: http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			saved := tc.want == http.StatusOK
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil).Times(1)
			store.EXPECT().UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).Times(timesIf(saved)).
				Return(db.UpdatePostBlocksIfRevisionMatchesRow{Content: emptyDoc, Revision: 2}, nil)
			store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().GetMediaByPostWithOrder(gomock.Any(), gomock.Any()).Times(0)
			stubRoleLookup(store, contributor)

			body := gin.H{"doc": emptyDoc}
			if tc.title != "" {
				body["title"] = tc.title
			}
			server := newTestServer(t, store)
			recorder := servePostPermRequest(t, server, contributor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/blocks", post.ID),
				func(db.Post) any { return body }, post, map[string]string{"If-Match": "1"})
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		})
	}
}

// On their own draft a contributor's block save still renames the post and
// syncs its media links, reusing the post it loaded for the owner check.
func TestSaveBlocksOnDraftAsContributor(t *testing.T) {
	contributor := db.User{ID: 52, Username: "contrib", Role: RoleContributor}
	post := db.Post{ID: 10, UserID: contributor.ID, PostStatus: "draft", Title: "Old title"}
	emptyDoc := json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil).Times(1)
	store.EXPECT().UpdatePostBlocksIfRevisionMatches(gomock.Any(), gomock.Any()).Times(1).
		Return(db.UpdatePostBlocksIfRevisionMatchesRow{Content: emptyDoc, Revision: 2}, nil)
	store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(1).
		DoAndReturn(func(_ any, arg db.UpdatePostParams) (db.Post, error) {
			require.Equal(t, "New title", arg.Title)
			require.Equal(t, post.UserID, arg.UserID)
			return post, nil
		})
	store.EXPECT().GetMediaByPostWithOrder(gomock.Any(), post.ID).Times(1).Return(nil, nil)
	stubRoleLookup(store, contributor)

	server := newTestServer(t, store)
	recorder := servePostPermRequest(t, server, contributor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/blocks", post.ID),
		func(db.Post) any { return gin.H{"doc": emptyDoc, "title": "New title"} }, post, map[string]string{"If-Match": "1"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
}

// A contributor may nest a post only under a post they can edit; moderators
// under anything.
func TestPostParentAsContributor(t *testing.T) {
	contributor := db.User{ID: 71, Username: "contrib", Role: RoleContributor}
	editor := db.User{ID: 72, Username: "ed", Role: RoleEditor}
	ownParent := db.Post{ID: 501, UserID: contributor.ID, PostStatus: "draft"}
	othersParent := db.Post{ID: 502, UserID: editor.ID, PostStatus: "published"}
	child := db.Post{ID: 503, UserID: contributor.ID, PostStatus: "draft", Title: "Child", Description: "D", Url: "https://example.com/c"}

	for _, tc := range []struct {
		name   string
		caller db.User
		method string
		parent int64
		want   int
	}{
		{name: "CreateUnderOwn", caller: contributor, method: http.MethodPost, parent: ownParent.ID, want: http.StatusCreated},
		{name: "CreateUnderOthers", caller: contributor, method: http.MethodPost, parent: othersParent.ID, want: http.StatusForbidden},
		{name: "CreateUnderMissing", caller: contributor, method: http.MethodPost, parent: 999, want: http.StatusNotFound},
		{name: "EditorCreatesUnderOthers", caller: editor, method: http.MethodPost, parent: othersParent.ID, want: http.StatusCreated},
		{name: "MoveUnderOwn", caller: contributor, method: http.MethodPut, parent: ownParent.ID, want: http.StatusOK},
		{name: "MoveUnderOthers", caller: contributor, method: http.MethodPut, parent: othersParent.ID, want: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			ok := tc.want == http.StatusCreated || tc.want == http.StatusOK
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetPost(gomock.Any(), ownParent.ID).Return(ownParent, nil).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), othersParent.ID).Return(othersParent, nil).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), int64(999)).Return(db.Post{}, sql.ErrNoRows).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), child.ID).Return(child, nil).AnyTimes()
			store.EXPECT().CheckURLExists(gomock.Any(), gomock.Any()).AnyTimes().Return(false, nil)
			store.EXPECT().CheckSlugExists(gomock.Any(), gomock.Any()).AnyTimes().Return(false, nil)
			store.EXPECT().CreatePostTx(gomock.Any(), gomock.Any()).Times(timesIf(ok && tc.method == http.MethodPost)).
				Return(db.CreatePostTxResult{Post: child}, nil)
			store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Times(timesIf(ok && tc.method == http.MethodPut)).Return(child, nil)
			stubRoleLookup(store, contributor)
			stubRoleLookup(store, editor)

			path, body := "/api/v1/posts", gin.H{"title": "Child", "description": "A long enough description",
				"url": "https://example.com/child", "author_ids": []int64{tc.caller.ID}, "post_parent": tc.parent}
			if tc.method == http.MethodPut {
				path, body = fmt.Sprintf("/api/v1/posts/%d", child.ID), gin.H{"post_parent": tc.parent}
			}
			server := newTestServer(t, store)
			recorder := servePostPermRequest(t, server, tc.caller, tc.method, path, func(db.Post) any { return body }, db.Post{}, nil)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
		})
	}
}

// Contributors may upload media now (#135); ownership of existing media is
// still canWriteMedia's call.
func TestMediaWriteRoutesAdmitContributors(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	contributor := db.User{ID: 61, Username: "contrib", Role: RoleContributor}
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetMedia(gomock.Any(), int64(3)).Return(db.Medium{ID: 3, UserID: 999}, nil).Times(1)
	stubRoleLookup(store, contributor)

	server := newTestServer(t, store)
	recorder := servePostPermRequest(t, server, contributor, http.MethodDelete, "/api/v1/media/3", nil, db.Post{}, nil)
	// Through the role gate (not the middleware's 403 before any lookup), then
	// refused by ownership: someone else's media.
	require.Equal(t, http.StatusForbidden, recorder.Code)
}

func TestPostPermissionPredicates(t *testing.T) {
	admin := db.User{ID: 1, Role: "Admin"}
	editor := db.User{ID: 2, Role: RoleEditor}
	owner := db.User{ID: 3, Role: RoleContributor}
	other := db.User{ID: 4, Role: RoleContributor}
	unknown := db.User{ID: 3, Role: "subscriber"}
	draft := db.Post{UserID: owner.ID, PostStatus: "draft"}
	published := db.Post{UserID: owner.ID, PostStatus: "Published"}

	for _, u := range []db.User{admin, editor} {
		require.True(t, canEditPost(u, draft))
		require.True(t, canEditPostDetails(u, published))
		require.True(t, canModeratePosts(u))
		require.True(t, canCreatePost(u, []int64{owner.ID}, "published"))
	}

	require.True(t, canEditPost(owner, draft))
	require.True(t, canEditPost(owner, published))
	require.True(t, canEditPostDetails(owner, draft))
	require.False(t, canEditPostDetails(owner, published), "status compare is case-insensitive")
	require.False(t, canModeratePosts(owner))
	require.True(t, canCreatePost(owner, []int64{owner.ID}, ""))
	require.False(t, canCreatePost(owner, []int64{owner.ID}, "published"))

	require.False(t, canEditPost(other, draft))
	require.False(t, canEditPostDetails(other, draft))

	// An unknown role owning a post (legacy row) gets nothing.
	require.False(t, canEditPost(unknown, draft))
	require.False(t, canCreatePost(unknown, []int64{unknown.ID}, ""))
}
