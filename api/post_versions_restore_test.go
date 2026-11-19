package api

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// POST /posts/:id/versions/:no/restore (#286): the blocks go through the collab
// server's internal restore (never written here, rule 11), then the settings
// (#358). Who may restore is what it was (editors and admins; not in the trash),
// and a collab server that can't restore leaves everything as it was.

const restoreURL = "/api/v1/posts/7/versions/1/restore"

var restoreVersionDoc = json.RawMessage(`{"doc_version":1,"blocks_order":["blk-restore-0001"],"blocks":{"blk-restore-0001":{"id":"blk-restore-0001","type":"paragraph","version":1,"attrs":{"text":"restored"}}}}`)

func restoreVersionRow() db.GetPostVersionRow {
	return db.GetPostVersionRow{ID: 11, VersionNo: 1, BlockDoc: restoreVersionDoc, Settings: publishedSettings(publishedSettingsJSON)}
}

// fakeCollabRestore answers the collab server's restore with status and body,
// recording what it received.
type fakeCollabRestore struct {
	server   *httptest.Server
	calls    atomic.Int32
	path     atomic.Value
	auth     atomic.Value
	request  atomic.Value
	body     atomic.Value
	answered atomic.Bool
}

func newFakeCollabRestore(t *testing.T, status int, answer string) *fakeCollabRestore {
	t.Helper()
	fake := &fakeCollabRestore{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.calls.Add(1)
		fake.path.Store(r.URL.Path)
		fake.auth.Store(r.Header.Get(authorizationHeaderKey))
		fake.request.Store(r.Header.Get(requestIDHeader))
		raw, _ := io.ReadAll(r.Body)
		fake.body.Store(raw)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
		fake.answered.Store(true)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func TestRestorePostVersion(t *testing.T) {
	t.Run("RestoresBlocksThroughCollabThenSettings", func(t *testing.T) {
		collab := newFakeCollabRestore(t, http.StatusOK, `{"restored":true,"revision":9,"block_doc":"written","dropped":1}`)
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubLivePost(store)
		stubRoleLookup(store, publishEditor)
		store.EXPECT().GetPostVersion(gomock.Any(), db.GetPostVersionParams{PostID: 7, VersionNo: 1}).Times(1).Return(restoreVersionRow(), nil)
		store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Times(1).
			DoAndReturn(func(_ any, arg db.RestorePostSettingsTxParams) (db.Post, error) {
				// Only after the collab server has the blocks.
				require.True(t, collab.answered.Load(), "the settings were written before the blocks landed")
				require.Equal(t, int64(7), arg.PostID)
				require.Equal(t, "Published title", arg.Settings.Title)
				return db.Post{ID: 7, Title: arg.Settings.Title}, nil
			})
		// The API never writes block_doc: no store call touches it.
		store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)

		server := newCollabTestServer(t, store, collab.server.URL)
		recorder := settingsRequest(t, server, http.MethodPost, restoreURL, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

		var resp RestorePostVersionResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.Equal(t, int64(9), *resp.Blocks.BlockRevision)
		require.True(t, resp.Blocks.Changed)
		require.Equal(t, 1, resp.Blocks.Hidden)
		require.True(t, resp.SettingsRestored)
		require.Equal(t, "Published title", resp.Post.Title)

		require.Equal(t, int32(1), collab.calls.Load())
		require.Equal(t, "/internal/documents/post-7/restore", collab.path.Load())
		require.Equal(t, "Bearer "+testCollabInternalSecret, collab.auth.Load())
		require.NotEmpty(t, collab.request.Load())
		var sent struct {
			BlockDoc json.RawMessage `json:"block_doc"`
			UserID   string          `json:"user_id"`
		}
		require.NoError(t, json.Unmarshal(collab.body.Load().([]byte), &sent))
		require.JSONEq(t, string(restoreVersionDoc), string(sent.BlockDoc))
		require.Equal(t, "1", sent.UserID, "the restoring user, for the per-block attribution")
	})

	t.Run("VersionWithoutSettings", func(t *testing.T) {
		collab := newFakeCollabRestore(t, http.StatusOK, `{"restored":true,"revision":9,"block_doc":"unchanged","dropped":0}`)
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubLivePost(store)
		stubRoleLookup(store, publishEditor)
		row := restoreVersionRow()
		row.Settings.Valid = false
		store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(1).Return(row, nil)
		store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Times(0)

		recorder := settingsRequest(t, newCollabTestServer(t, store, collab.server.URL), http.MethodPost, restoreURL, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.JSONEq(t, `{"blocks":{"block_revision":9,"changed":false,"hidden":0},"settings_restored":false}`, recorder.Body.String())
	})

	t.Run("SettingsFailAfterTheBlocksLanded", func(t *testing.T) {
		collab := newFakeCollabRestore(t, http.StatusOK, `{"restored":true,"revision":9,"block_doc":"written","dropped":0}`)
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubLivePost(store)
		stubRoleLookup(store, publishEditor)
		store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(1).Return(restoreVersionRow(), nil)
		store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Times(1).Return(db.Post{}, sql.ErrConnDone)

		recorder := settingsRequest(t, newCollabTestServer(t, store, collab.server.URL), http.MethodPost, restoreURL, publishEditor)
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
		var resp struct {
			Code   string         `json:"code"`
			Blocks RestoredBlocks `json:"blocks"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		// Says plainly that the content did come back.
		require.Equal(t, "settings_not_restored", resp.Code)
		require.True(t, resp.Blocks.Changed)
	})
}

// TestRestorePostVersionAccess: the same callers as before #286 (editors and
// admins; requireContentEditor + authorizeWritePost), and nothing reaches the
// collab server for anyone else.
func TestRestorePostVersionAccess(t *testing.T) {
	contributor := db.User{ID: 2, Username: "contrib", Role: RoleContributor}
	admin := db.User{ID: 3, Username: "admin", Role: RoleAdmin}
	subscriber := db.User{ID: 4, Username: "reader", Role: "subscriber"}

	for _, tc := range []struct {
		name string
		user db.User
		url  string
		post func(store *mockdb.MockStore)
		want int
	}{
		{"Editor", publishEditor, restoreURL, stubLivePost, http.StatusOK},
		{"Admin", admin, restoreURL, stubLivePost, http.StatusOK},
		{"Contributor", contributor, restoreURL, stubLivePost, http.StatusForbidden},
		{"OtherRole", subscriber, restoreURL, stubLivePost, http.StatusForbidden},
		{"Trashed", publishEditor, restoreURL, func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{ID: 7, PostStatus: postStatusTrash}, nil).AnyTimes()
		}, http.StatusConflict},
		{"VersionMissing", publishEditor, restoreURL, stubLivePost, http.StatusNotFound},
		{"BadVersion", publishEditor, "/api/v1/posts/7/versions/0/restore", stubLivePost, http.StatusBadRequest},
		{"BadPost", publishEditor, "/api/v1/posts/x/versions/1/restore", stubLivePost, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			collab := newFakeCollabRestore(t, http.StatusOK, `{"restored":true,"revision":2,"block_doc":"written","dropped":0}`)
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.post(store)
			stubRoleLookup(store, tc.user)
			switch tc.want {
			case http.StatusOK:
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Return(restoreVersionRow(), nil)
				store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Return(db.Post{ID: 7}, nil)
			case http.StatusNotFound:
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Return(db.GetPostVersionRow{}, sql.ErrNoRows)
			default:
				store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(0)
			}

			recorder := settingsRequest(t, newCollabTestServer(t, store, collab.server.URL), http.MethodPost, tc.url, tc.user)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			if tc.want == http.StatusOK {
				require.Equal(t, int32(1), collab.calls.Load())
			} else {
				require.Equal(t, int32(0), collab.calls.Load(), "a refused caller reached the collab server")
			}
		})
	}
}

// TestRestorePostVersionCollabFailure: when the collab server is down, slow or
// refuses, the answer says so and nothing is written: no settings, no activity
// (the mock store has no activity writer, so only RestorePostSettingsTx could
// write), and the API never touches block_doc.
func TestRestorePostVersionCollabFailure(t *testing.T) {
	down := httptest.NewServer(http.NotFoundHandler())
	downURL := down.URL
	down.Close()

	release := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	defer close(release)

	answering := func(status int, body string) string {
		return newFakeCollabRestore(t, status, body).server.URL
	}

	for _, tc := range []struct {
		name     string
		url      string
		want     int
		wantCode string
	}{
		{"CollabDown", downURL, http.StatusServiceUnavailable, codeCollabSaveFailed},
		{"StoreFailed", answering(http.StatusServiceUnavailable, `{"error":"restore failed","reason":"unavailable"}`), http.StatusServiceUnavailable, codeCollabSaveFailed},
		{"WrongSecret", answering(http.StatusUnauthorized, `{"error":"unauthorized"}`), http.StatusServiceUnavailable, codeCollabSaveFailed},
		{"ServerError", answering(http.StatusInternalServerError, ``), http.StatusServiceUnavailable, codeCollabSaveFailed},
		{"Timeout", slow.URL, http.StatusServiceUnavailable, codeRestoreUnconfirmed},
		{"Unstorable", answering(http.StatusUnprocessableEntity, `{"reason":"unstorable"}`), http.StatusUnprocessableEntity, codeVersionUnrestorable},
		{"InvalidVersion", answering(http.StatusBadRequest, `{"reason":"invalid-version"}`), http.StatusUnprocessableEntity, codeVersionUnrestorable},
		{"PostGone", answering(http.StatusNotFound, `{"reason":"not-found"}`), http.StatusNotFound, ""},
		// A collab server from before #286 has no such route: it can't restore.
		{"OlderCollab", answering(http.StatusNotFound, `{"error":"not found"}`), http.StatusServiceUnavailable, codeCollabSaveFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			stubLivePost(store)
			stubRoleLookup(store, publishEditor)
			store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(1).Return(restoreVersionRow(), nil)
			store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().StorePostCollabTx(gomock.Any(), gomock.Any()).Times(0)

			server := newCollabTestServer(t, store, tc.url)
			server.collabRestoreTimeout = 200 * time.Millisecond
			start := time.Now()
			recorder := settingsRequest(t, server, http.MethodPost, restoreURL, publishEditor)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			require.Less(t, time.Since(start), 5*time.Second)
			if tc.wantCode != "" {
				var resp struct {
					Code  string `json:"code"`
					Error string `json:"error"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
				require.Equal(t, tc.wantCode, resp.Code)
				require.NotEmpty(t, resp.Error)
			}
		})
	}
}

func TestCollabRestoreTimeoutDefault(t *testing.T) {
	server := newTestServer(t, nil)
	require.Equal(t, 30*time.Second, server.collabRestoreTimeout)
	// Longer than the collab server's own load + store bounds (10s each, api.ts).
	require.Greater(t, server.collabRestoreTimeout, 20*time.Second)
}
