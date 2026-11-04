package api

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The trash rules (#327), spelled out from auth_posts.go's model.
func TestTrashPermissionRules(t *testing.T) {
	actors, ownerID := postPermActors()
	trashedFrom := func(status string) db.Post {
		return db.Post{ID: 1, UserID: ownerID, PostStatus: "trash", TrashedFromStatus: sql.NullString{String: status, Valid: true}}
	}
	for _, actor := range actors {
		for _, from := range []string{"draft", "archived", "published", "scheduled"} {
			post := trashedFrom(from)
			wantRestore := actor.moderator || (actor.owner && (from == "draft" || from == "archived"))
			require.Equal(t, wantRestore, canRestorePost(actor.user, post), "%s restores from %s", actor.name, from)
			require.Equal(t, actor.moderator, canDeletePostPermanently(actor.user, post), "%s deletes", actor.name)
			require.False(t, canEditPost(actor.user, post), "%s edits a trashed post", actor.name)
			require.False(t, canTrashPost(actor.user, post), "%s trashes twice", actor.name)
		}
		for _, status := range []string{"draft", "published", "scheduled"} {
			post := db.Post{ID: 1, UserID: ownerID, PostStatus: status}
			want := actor.moderator || (actor.owner && status == "draft")
			require.Equal(t, want, canTrashPost(actor.user, post), "%s trashes a %s post", actor.name, status)
		}
	}
}

// Moderators' access lookup reads the post too, so a trashed one is refused
// with 410 post_trashed (the collab server's post-trashed).
func TestInternalDocAccessTrashedPost(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	user := randomUserNew()
	user.ID = 61
	user.Role = RoleAdmin
	user.PasswordChangedAt = time.Now().Add(-time.Hour).UTC()

	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetUser(gomock.Any(), user.ID).Return(user, nil)
	store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{ID: 7, PostStatus: "trash"}, nil)

	server := newTestServer(t, store)
	request, err := http.NewRequest(http.MethodGet,
		fmt.Sprintf("/internal/users/%d/access?doc=post-7&issued_at=%d", user.ID, time.Now().Unix()), nil)
	require.NoError(t, err)
	request.Header.Set(authorizationHeaderKey, "Bearer "+testRoleLookupSecret)
	recorder := httptest.NewRecorder()
	server.internalRouter.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusGone, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"code":"post_trashed"`)
}

// The single routes write the shared failures: 503 when the collab flush
// fails (nothing published), 409 for a trashed post.
func TestPublishPostTrashed(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	editor := db.User{ID: 81, Username: "ed", Role: RoleEditor}
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().PublishPostTx(gomock.Any(), gomock.Any()).Return(db.PublishPostTxResult{}, db.ErrPostTrashed)
	stubRoleLookup(store, editor)

	server := newTestServer(t, store)
	recorder := servePostPermRequest(t, server, editor, http.MethodPost, "/api/v1/posts/9/publish", nil, db.Post{}, nil)
	require.Equal(t, http.StatusConflict, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), codePostTrashed)
}

// stubLivePost answers the trash check of the write routes that read the post
// for moderators too (authorizeWritePost, #327) with a post that isn't trashed.
func stubLivePost(store *mockdb.MockStore) {
	store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Return(db.Post{ID: 7, PostStatus: "draft"}, nil).AnyTimes()
}
