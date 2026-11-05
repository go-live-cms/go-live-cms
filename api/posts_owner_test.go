package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// Post ownership (#353): POST /posts/:id/transfer and GET /posts/:id/owner.

func TestTransferPostAPI(t *testing.T) {
	admin, editor, contributor := guardUsers()
	const postID = int64(4242)
	path := fmt.Sprintf("/api/v1/posts/%d/transfer", postID)
	transferred := db.TransferPostOwnerTxResult{
		Post:            db.Post{ID: postID, UserID: editor.ID, Username: editor.Username, PostType: "post", PostStatus: "draft"},
		Owner:           db.LockNewPostOwnerRow{ID: editor.ID, Username: editor.Username, FullName: "Ana Costa", Role: RoleEditor},
		PreviousOwnerID: contributor.ID,
		Authors:         []db.ListPostBylineAuthorsRow{{ID: contributor.ID, Username: contributor.Username}},
	}

	testCases := []struct {
		name       string
		caller     db.User
		body       any
		buildStubs func(store *mockdb.MockStore)
		wantStatus int
		wantCode   string
		// The transfer went through: the document is re-checked and recorded.
		done bool
	}{
		{
			name:   "AdminKeepsByline",
			caller: admin,
			body:   gin.H{"user_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					TransferPostOwnerTx(gomock.Any(), db.TransferPostOwnerTxParams{
						PostID: postID, ToID: editor.ID, OwnerRoles: contentRoles, ReplaceInByline: false,
					}).
					Return(transferred, nil)
			},
			wantStatus: http.StatusOK,
			done:       true,
		},
		{
			name:   "AdminReplacesInByline",
			caller: admin,
			body:   gin.H{"user_id": editor.ID, "replace_in_byline": true},
			buildStubs: func(store *mockdb.MockStore) {
				replaced := transferred
				replaced.BylineChanged = true
				replaced.Authors = []db.ListPostBylineAuthorsRow{{ID: editor.ID, Username: editor.Username}}
				store.EXPECT().
					TransferPostOwnerTx(gomock.Any(), db.TransferPostOwnerTxParams{
						PostID: postID, ToID: editor.ID, OwnerRoles: contentRoles, ReplaceInByline: true,
					}).
					Return(replaced, nil)
			},
			wantStatus: http.StatusOK,
			done:       true,
		},
		// Admins only: editors moderate every post but can't hand one to someone else.
		{name: "EditorForbidden", caller: editor, body: gin.H{"user_id": admin.ID}, wantStatus: http.StatusForbidden},
		{name: "ContributorForbidden", caller: contributor, body: gin.H{"user_id": admin.ID}, wantStatus: http.StatusForbidden},
		{name: "MissingUserID", caller: admin, body: gin.H{}, wantStatus: http.StatusBadRequest},
		{name: "UnknownField", caller: admin, body: gin.H{"user_id": editor.ID, "owner": 1}, wantStatus: http.StatusBadRequest},
		{
			name:   "RemovedMember",
			caller: admin,
			body:   gin.H{"user_id": 999999},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Return(db.TransferPostOwnerTxResult{}, db.ErrNewOwnerNotFound)
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_owner",
		},
		{
			name:   "InactiveMember",
			caller: admin,
			body:   gin.H{"user_id": 31},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Return(db.TransferPostOwnerTxResult{}, db.ErrNewOwnerInactive)
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_owner",
		},
		{
			name:   "AlreadyOwner",
			caller: admin,
			body:   gin.H{"user_id": contributor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Return(db.TransferPostOwnerTxResult{}, db.ErrAlreadyOwner)
			},
			wantStatus: http.StatusConflict,
			wantCode:   "already_owner",
		},
		{
			name:   "Trashed",
			caller: admin,
			body:   gin.H{"user_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Return(db.TransferPostOwnerTxResult{}, db.ErrPostTrashed)
			},
			wantStatus: http.StatusConflict,
			wantCode:   "post_trashed",
		},
		{
			name:   "PostNotFound",
			caller: admin,
			body:   gin.H{"user_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Return(db.TransferPostOwnerTxResult{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "TxFails",
			caller: admin,
			body:   gin.H{"user_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Return(db.TransferPostOwnerTxResult{}, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, tc.caller)
			if tc.buildStubs != nil {
				tc.buildStubs(store)
			} else {
				store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Times(0)
			}

			server, collab := newMembersTestServer(t, store, http.StatusOK)
			rec := sendAuthedJSON(t, server, http.MethodPost, path, tc.body, &tc.caller)
			require.Equal(t, tc.wantStatus, rec.Code, rec.Body.String())
			if tc.wantCode != "" {
				require.Contains(t, rec.Body.String(), `"code":"`+tc.wantCode+`"`)
			}

			events := activityOf(t, server).events
			if !tc.done {
				require.Empty(t, collab.calls(), "nothing changed: no re-check")
				require.Empty(t, events, "nothing changed: no event")
				return
			}

			// The #313 re-check runs on the document now: the old owner's open
			// connections drop to read-only without waiting for the interval.
			require.Equal(t, []string{fmt.Sprintf("POST /internal/documents/post-%d/recheck", postID)}, collab.calls())

			var body struct {
				Post            PostResponse         `json:"post"`
				Owner           PostAuthorResponse   `json:"owner"`
				PreviousOwnerID int64                `json:"previous_owner_id"`
				Authors         []PostAuthorResponse `json:"authors"`
				BylineChanged   bool                 `json:"byline_changed"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			require.Equal(t, editor.ID, body.Post.UserID)
			require.Equal(t, editor.ID, body.Owner.ID)
			require.Equal(t, "Ana Costa", body.Owner.FullName)
			require.Equal(t, contributor.ID, body.PreviousOwnerID)
			require.NotContains(t, rec.Body.String(), `"role"`, "the owner is shown with public fields only")

			// Recorded in the activity log (#324), ids only.
			require.Len(t, events, 1)
			require.Equal(t, db.ActivityTransferred, events[0].Verb)
			require.Equal(t, db.ActivityObjectPost, events[0].ObjectType)
			require.Equal(t, postID, events[0].ObjectID)
			require.Equal(t, admin.ID, events[0].ActorID.Int64)
			var payload map[string]any
			require.NoError(t, json.Unmarshal(events[0].Payload, &payload))
			require.EqualValues(t, contributor.ID, payload["previous_owner_id"])
			require.EqualValues(t, editor.ID, payload["owner_id"])
			require.Equal(t, body.BylineChanged, payload["byline_changed"])
		})
	}
}

// The collab server being down doesn't fail a transfer: the re-check is best
// effort and its periodic one catches up.
func TestTransferPostCollabDown(t *testing.T) {
	admin, editor, _ := guardUsers()
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, admin)
	store.EXPECT().TransferPostOwnerTx(gomock.Any(), gomock.Any()).Return(db.TransferPostOwnerTxResult{
		Post:  db.Post{ID: 9, UserID: editor.ID},
		Owner: db.LockNewPostOwnerRow{ID: editor.ID, Username: editor.Username},
	}, nil)

	server, collab := newMembersTestServer(t, store, http.StatusServiceUnavailable)
	rec := sendAuthedJSON(t, server, http.MethodPost, "/api/v1/posts/9/transfer", gin.H{"user_id": editor.ID}, &admin)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []string{"POST /internal/documents/post-9/recheck"}, collab.calls())
}

func TestTransferPostInvalidID(t *testing.T) {
	admin, editor, _ := guardUsers()
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, admin)
	server := newTestServer(t, store)
	rec := sendAuthedJSON(t, server, http.MethodPost, "/api/v1/posts/abc/transfer", gin.H{"user_id": editor.ID}, &admin)
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestGetPostOwnerAPI(t *testing.T) {
	admin, editor, contributor := guardUsers()
	owner := editor
	owner.FullName = "Ana Costa"
	owner.AvatarUrl = "/uploads/_avatars/ana-0123456789abcdef0123456789abcdef.jpg"
	draft := db.Post{ID: 77, UserID: owner.ID, PostStatus: "draft"}

	testCases := []struct {
		name       string
		caller     db.User
		buildStubs func(store *mockdb.MockStore)
		wantStatus int
	}{
		{
			name:   "OK",
			caller: admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), draft.ID).Return(draft, nil)
				stubRoleLookup(store, owner)
			},
			wantStatus: http.StatusOK,
		},
		{
			// canReadPost: a contributor can't read someone else's draft.
			name:   "ContributorOthersDraft",
			caller: contributor,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), draft.ID).Return(draft, nil)
			},
			wantStatus: http.StatusForbidden,
		},
		{
			name:   "PostNotFound",
			caller: admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), draft.ID).Return(db.Post{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:   "PostLookupFails",
			caller: admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), draft.ID).Return(db.Post{}, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:   "OwnerLookupFails",
			caller: admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), draft.ID).Return(draft, nil)
				store.EXPECT().GetUser(gomock.Any(), owner.ID).Return(db.User{}, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:   "OwnerGone",
			caller: admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPost(gomock.Any(), draft.ID).Return(draft, nil)
				store.EXPECT().GetUser(gomock.Any(), owner.ID).Return(db.User{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, tc.caller)
			server := newTestServer(t, store)
			rec := sendAuthedJSON(t, server, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/owner", draft.ID), nil, &tc.caller)
			require.Equal(t, tc.wantStatus, rec.Code, rec.Body.String())
			if tc.wantStatus != http.StatusOK {
				return
			}
			var body struct {
				Owner PostAuthorResponse `json:"owner"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			require.Equal(t, owner.ID, body.Owner.ID)
			require.Equal(t, "Ana Costa", body.Owner.FullName)
			require.NotNil(t, body.Owner.Avatar)
			require.NotContains(t, rec.Body.String(), owner.Email, "public fields only")
		})
	}
}
