package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The API's side of the collab server (#206 / #280): publish flushes the
// collab server first, only the collab server writes block_doc (PUT
// /posts/:id/blocks is gone, #285), and contributors get read-only tickets.

var publishEditor = db.User{ID: 1, Username: "testuser", Role: RoleEditor}

func publishRequest(t *testing.T, server *Server, postID int64) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", postID), bytes.NewReader([]byte(`{}`)))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(requestIDHeader, "publish-req-0001")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, publishEditor.ID, publishEditor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// expectPublishWrites stubs a successful publish of post 1. beforeRead runs
// when publish reads the working copy.
func expectPublishWrites(store *mockdb.MockStore, beforeRead func()) {
	store.EXPECT().GetPostBlocks(gomock.Any(), int64(1)).Times(1).
		DoAndReturn(func(_ any, _ int64) (db.GetPostBlocksRow, error) {
			beforeRead()
			return db.GetPostBlocksRow{Content: validBlockDoc(), Revision: 3}, nil
		})
	store.EXPECT().GetNextVersionNoForPost(gomock.Any(), int64(1)).Times(1).Return(int32(1), nil)
	store.EXPECT().InsertPostVersion(gomock.Any(), gomock.Any()).Times(1).Return(db.InsertPostVersionRow{ID: 1, VersionNo: 1}, nil)
	store.EXPECT().SetPublishedVersionOnPost(gomock.Any(), gomock.Any()).Times(1).Return(nil)
	store.EXPECT().GetMediaByPostWithOrder(gomock.Any(), int64(1)).Times(1).Return([]db.GetMediaByPostWithOrderRow{}, nil)
}

// TestPublishFlushesCollab: the flush reaches the collab server with its
// secret and the request id, and completes before publish reads block_doc.
// The server answers 200 both when it stored a loaded doc and when the doc
// wasn't loaded, so both cases publish.
func TestPublishFlushesCollab(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "DocLoaded", body: `{"flushed":true}`},
		{name: "DocNotLoaded", body: ``},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The handler only records (require must run on the test
			// goroutine); the request is checked after publish returns.
			var flushed atomic.Bool
			var got *http.Request
			collab := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.Clone(r.Context())
				flushed.Store(true)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer collab.Close()

			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			expectPublishWrites(store, func() {
				require.True(t, flushed.Load(), "block_doc was read before the flush")
			})
			stubRoleLookup(store, publishEditor)

			// A trailing slash on the URL is trimmed.
			server := newCollabTestServer(t, store, collab.URL+"/")
			recorder := publishRequest(t, server, 1)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			var resp PublishResponse
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
			require.Equal(t, int32(1), resp.VersionNo)

			require.NotNil(t, got)
			require.Equal(t, http.MethodPost, got.Method)
			require.Equal(t, "/internal/documents/post-1/flush", got.URL.Path)
			require.Equal(t, "Bearer "+testCollabInternalSecret, got.Header.Get(authorizationHeaderKey))
			require.NotEmpty(t, got.Header.Get(requestIDHeader))
		})
	}
}

// TestPublishFlushFailureIs503: when the collab server can't confirm the
// flush, nothing is read or published.
func TestPublishFlushFailureIs503(t *testing.T) {
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

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer failing.Close()

	unauthorized := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer unauthorized.Close()

	for _, tc := range []struct {
		name string
		url  string
	}{
		{name: "CollabDown", url: downURL},
		{name: "Timeout", url: slow.URL},
		{name: "ServerError", url: failing.URL},
		{name: "WrongSecret", url: unauthorized.URL},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetPostBlocks(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().InsertPostVersion(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().SetPublishedVersionOnPost(gomock.Any(), gomock.Any()).Times(0)
			stubRoleLookup(store, publishEditor)

			server := newCollabTestServer(t, store, tc.url)
			server.collabFlushTimeout = 200 * time.Millisecond

			start := time.Now()
			recorder := publishRequest(t, server, 1)
			require.Equal(t, http.StatusServiceUnavailable, recorder.Code, recorder.Body.String())
			require.Less(t, time.Since(start), 5*time.Second)
		})
	}
}

func TestCollabFlushTimeoutDefault(t *testing.T) {
	require.Equal(t, 5*time.Second, newTestServer(t, nil).collabFlushTimeout)
}

// PUT /posts/:id/blocks is gone (#285): only the collab server writes
// block_doc, so nothing a client sends here can reach the store.
func TestPutPostBlocksRemoved(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, publishEditor)

	server := newTestServer(t, store)
	body, err := json.Marshal(gin.H{"doc": gin.H{"doc_version": 1, "blocks_order": []string{}, "blocks": gin.H{}}})
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPut, "/api/v1/posts/1/blocks", bytes.NewReader(body))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("If-Match", "1")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, publishEditor.ID, publishEditor.Username, time.Minute)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusNotFound, recorder.Code)
}

// GET /posts/:id/blocks stays: the read-only REST view and revisions use it.
func TestGetPostBlocksStaysOpen(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetPostBlocks(gomock.Any(), int64(1)).Times(1).Return(db.GetPostBlocksRow{Content: validBlockDoc(), Revision: 2}, nil)
	stubRoleLookup(store, publishEditor)

	server := newCollabTestServer(t, store, "http://collab.invalid")
	request, err := http.NewRequest(http.MethodGet, "/api/v1/posts/1/blocks", nil)
	require.NoError(t, err)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, publishEditor.ID, publishEditor.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
}

// TestCreateCollabTicketReadAccess: contributors may watch any existing post
// live (the collab server makes it read-only unless can_edit); the ticket is
// still bound to the doc and carries no role.
func TestCreateCollabTicketReadAccess(t *testing.T) {
	contributor := randomUserNew()
	contributor.ID = 70
	contributor.Role = RoleContributor
	nonContentUser := randomUserNew()
	nonContentUser.ID = 71
	nonContentUser.Role = "subscriber"

	testCases := []struct {
		name       string
		caller     db.User
		doc        string
		wantStatus int
	}{
		{name: "ContributorOthersPost", caller: contributor, doc: "post-12", wantStatus: http.StatusOK},
		{name: "ContributorOwnPost", caller: contributor, doc: "post-13", wantStatus: http.StatusOK},
		{name: "ContributorMissingPost", caller: contributor, doc: "post-14", wantStatus: http.StatusNotFound},
		{name: "NonContentRole", caller: nonContentUser, doc: "post-12", wantStatus: http.StatusForbidden},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, tc.caller)
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(db.Post{ID: 12, UserID: 999, PostStatus: "draft"}, nil).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), int64(13)).Return(db.Post{ID: 13, UserID: contributor.ID}, nil).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), int64(14)).Return(db.Post{}, sql.ErrNoRows).AnyTimes()

			server := newCollabTestServer(t, store, "http://collab.invalid")
			recorder := postCollabTicket(t, server, gin.H{"doc": tc.doc}, &tc.caller)
			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.wantStatus != http.StatusOK {
				return
			}

			var res struct {
				Ticket string `json:"ticket"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
			payload, err := server.collabTickets.VerifyWSTicket(res.Ticket)
			require.NoError(t, err)
			require.Equal(t, tc.caller.ID, payload.UserID)
			require.Equal(t, tc.doc, payload.Doc)
		})
	}
}
