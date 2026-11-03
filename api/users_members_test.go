package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// The Users screen's API (#333): search, posts owned and last active, role
// change, removal with reassignment, and the collab re-check they trigger.

func memberRows(users []db.User) []db.ListMembersRow {
	rows := make([]db.ListMembersRow, len(users))
	for i, user := range users {
		rows[i] = db.ListMembersRow{User: user, PostsOwned: int64(i)}
	}
	return rows
}

// collabRecorder is a fake collab internal listener that records the paths the
// API POSTs to (and answers status).
type collabRecorder struct {
	mu     sync.Mutex
	paths  []string
	status int
}

func newCollabRecorder(t *testing.T, status int) (*collabRecorder, string) {
	t.Helper()
	rec := &collabRecorder{status: status}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.mu.Lock()
		if r.Header.Get("Authorization") == "Bearer "+testCollabInternalSecret {
			rec.paths = append(rec.paths, r.Method+" "+r.URL.Path)
		}
		rec.mu.Unlock()
		w.WriteHeader(rec.status)
	}))
	t.Cleanup(srv.Close)
	return rec, srv.URL
}

func (rec *collabRecorder) calls() []string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return append([]string(nil), rec.paths...)
}

// newMembersTestServer runs background work inline so the collab call has
// happened by the time the response is checked.
func newMembersTestServer(t *testing.T, store db.Store, collabStatus int) (*Server, *collabRecorder) {
	t.Helper()
	rec, url := newCollabRecorder(t, collabStatus)
	server := newCollabTestServer(t, store, url)
	server.runInBackground = func(_, _ string, f func()) { f() }
	return server, rec
}

func TestMemberSearchPattern(t *testing.T) {
	require.Equal(t, "", memberSearchPattern("   "))
	require.Equal(t, "%ana%", memberSearchPattern(" ana "))
	// Wildcards are matched literally.
	require.Equal(t, `%50\% off\_x\\y%`, memberSearchPattern(`50% off_x\y`))
}

func TestListMembersAPI(t *testing.T) {
	admin, editor, contributor := guardUsers()
	active := time.Date(2026, 11, 2, 9, 30, 0, 0, time.UTC)
	contributor.LastActiveAt = sql.NullTime{Time: active, Valid: true}

	t.Run("SearchAndRoleFilter", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().
			ListMembers(gomock.Any(), db.ListMembersParams{
				Pattern: `%an\_a%`, Role: "contributor", SortBy: "username_asc", LimitCount: 10, OffsetCount: 0,
			}).
			Return([]db.ListMembersRow{{User: contributor, PostsOwned: 12}, {User: editor}}, nil)
		store.EXPECT().
			CountMembers(gomock.Any(), db.CountMembersParams{Pattern: `%an\_a%`, Role: "contributor"}).
			Return(int64(2), nil)

		server := newTestServer(t, store)
		rec := sendAuthedJSON(t, server, http.MethodGet, "/api/v1/users?q=an_a&role=contributor&sort=username_asc", nil, &admin)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

		var body struct {
			Users []map[string]any `json:"users"`
			Meta  struct {
				Total int64 `json:"total"`
			} `json:"meta"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.EqualValues(t, 2, body.Meta.Total)
		require.Len(t, body.Users, 2)
		require.EqualValues(t, 12, body.Users[0]["posts_owned"])
		require.Equal(t, active.Format(time.RFC3339), body.Users[0]["last_active_at"])
		// Never active since #333: null, not a zero time.
		require.Nil(t, body.Users[1]["last_active_at"])
		require.EqualValues(t, 0, body.Users[1]["posts_owned"])
		// Still never the password hash.
		require.NotContains(t, rec.Body.String(), "hashed_password")
	})

	for _, tc := range []struct {
		name  string
		query string
	}{
		{"UnknownRole", "?role=owner"},
		{"SearchTooLong", "?q=" + strings.Repeat("a", 101)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, admin)
			store.EXPECT().ListMembers(gomock.Any(), gomock.Any()).Times(0)
			server := newTestServer(t, store)
			rec := sendAuthedJSON(t, server, http.MethodGet, "/api/v1/users"+tc.query, nil, &admin)
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}

	// Searching members (names, emails) is user management: admins only.
	for _, caller := range []db.User{editor, contributor} {
		t.Run("Forbidden_"+caller.Role, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, caller)
			store.EXPECT().ListMembers(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().CountMembers(gomock.Any(), gomock.Any()).Times(0)
			server := newTestServer(t, store)
			rec := sendAuthedJSON(t, server, http.MethodGet, "/api/v1/users?q=ana", nil, &caller)
			require.Equal(t, http.StatusForbidden, rec.Code)
		})
	}

	t.Run("CountFails", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, admin)
		store.EXPECT().ListMembers(gomock.Any(), gomock.Any()).Return(nil, nil)
		store.EXPECT().CountMembers(gomock.Any(), gomock.Any()).Return(int64(0), sql.ErrConnDone)
		server := newTestServer(t, store)
		rec := sendAuthedJSON(t, server, http.MethodGet, "/api/v1/users", nil, &admin)
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestChangeUserRoleAPI(t *testing.T) {
	admin, editor, contributor := guardUsers()
	target := fmt.Sprint(editor.ID)

	testCases := []struct {
		name       string
		caller     db.User
		targetID   string
		body       any
		buildStubs func(store *mockdb.MockStore)
		wantStatus int
		wantCode   string
		rechecked  bool
	}{
		{
			name:     "Demote",
			caller:   admin,
			targetID: target,
			body:     gin.H{"role": RoleContributor},
			buildStubs: func(store *mockdb.MockStore) {
				demoted := editor
				demoted.Role = RoleContributor
				store.EXPECT().
					ChangeUserRoleTx(gomock.Any(), db.SetUserRoleParams{ID: editor.ID, Role: RoleContributor}).
					Return(demoted, nil)
			},
			wantStatus: http.StatusOK,
			rechecked:  true,
		},
		{
			name:     "LastAdmin",
			caller:   admin,
			targetID: fmt.Sprint(admin.ID),
			body:     gin.H{"role": RoleEditor},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().ChangeUserRoleTx(gomock.Any(), gomock.Any()).Return(db.User{}, db.ErrLastAdmin)
			},
			wantStatus: http.StatusConflict,
			wantCode:   "last_admin",
		},
		{
			name:     "NotFound",
			caller:   admin,
			targetID: "424242",
			body:     gin.H{"role": RoleEditor},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().ChangeUserRoleTx(gomock.Any(), gomock.Any()).Return(db.User{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:     "TxFails",
			caller:   admin,
			targetID: target,
			body:     gin.H{"role": RoleEditor},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().ChangeUserRoleTx(gomock.Any(), gomock.Any()).Return(db.User{}, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:       "UnknownRole",
			caller:     admin,
			targetID:   target,
			body:       gin.H{"role": "owner"},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "InvalidID",
			caller:     admin,
			targetID:   "abc",
			body:       gin.H{"role": RoleEditor},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "EditorForbidden",
			caller:     editor,
			targetID:   fmt.Sprint(contributor.ID),
			body:       gin.H{"role": RoleEditor},
			wantStatus: http.StatusForbidden,
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
				store.EXPECT().ChangeUserRoleTx(gomock.Any(), gomock.Any()).Times(0)
			}

			server, collab := newMembersTestServer(t, store, http.StatusOK)
			rec := sendAuthedJSON(t, server, http.MethodPut, "/api/v1/users/"+tc.targetID+"/role", tc.body, &tc.caller)
			require.Equal(t, tc.wantStatus, rec.Code, rec.Body.String())
			if tc.wantCode != "" {
				require.Contains(t, rec.Body.String(), `"code":"`+tc.wantCode+`"`)
			}
			if tc.rechecked {
				require.Equal(t, []string{"POST /internal/users/" + tc.targetID + "/recheck"}, collab.calls())
			} else {
				require.Empty(t, collab.calls())
			}
		})
	}
}

// A role change through the profile form (PUT /users/:id) re-checks open
// documents too, and only when the role changed.
func TestUpdateUserRoleRechecksCollab(t *testing.T) {
	admin, editor, _ := guardUsers()

	for _, tc := range []struct {
		name      string
		role      string
		rechecked bool
	}{
		{"RoleChanged", RoleContributor, true},
		{"SameRole", RoleEditor, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, admin)
			store.EXPECT().GetUser(gomock.Any(), editor.ID).Return(editor, nil)
			updated := editor
			updated.Role = tc.role
			store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Return(db.UpdateUserTxResult{User: updated}, nil)

			server, collab := newMembersTestServer(t, store, http.StatusOK)
			rec := sendAuthedJSON(t, server, http.MethodPut, fmt.Sprintf("/api/v1/users/%d", editor.ID), gin.H{"role": tc.role}, &admin)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			if tc.rechecked {
				require.Equal(t, []string{fmt.Sprintf("POST /internal/users/%d/recheck", editor.ID)}, collab.calls())
			} else {
				require.Empty(t, collab.calls())
			}
		})
	}
}

func TestDeleteUserAPI(t *testing.T) {
	admin, editor, contributor := guardUsers()
	target := fmt.Sprint(contributor.ID)

	testCases := []struct {
		name       string
		caller     db.User
		targetID   string
		body       any
		buildStubs func(store *mockdb.MockStore)
		wantStatus int
		wantCode   string
		rechecked  bool
	}{
		{
			name:     "OK",
			caller:   admin,
			targetID: target,
			body:     gin.H{"transfer_to_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					RemoveUserTx(gomock.Any(), db.RemoveUserTxParams{UserID: contributor.ID, ReassignTo: editor.ID}).
					Return(db.RemoveUserTxResult{PostsReassigned: 3}, nil)
			},
			wantStatus: http.StatusOK,
			rechecked:  true,
		},
		{
			// Removal always says where their content goes.
			name:       "TransferTargetRequired",
			caller:     admin,
			targetID:   target,
			body:       gin.H{},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "NoBody",
			caller:     admin,
			targetID:   target,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "MalformedBody",
			caller:     admin,
			targetID:   target,
			body:       `{"transfer_to_id": "not-a-number"`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "InvalidID",
			caller:     admin,
			targetID:   "abc",
			body:       gin.H{"transfer_to_id": editor.ID},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "RemoveSelf",
			caller:     admin,
			targetID:   fmt.Sprint(admin.ID),
			body:       gin.H{"transfer_to_id": editor.ID},
			wantStatus: http.StatusConflict,
			wantCode:   "cannot_remove_self",
		},
		{
			name:     "LastAdmin",
			caller:   admin,
			targetID: "7777",
			body:     gin.H{"transfer_to_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().RemoveUserTx(gomock.Any(), gomock.Any()).Return(db.RemoveUserTxResult{}, db.ErrLastAdmin)
			},
			wantStatus: http.StatusConflict,
			wantCode:   "last_admin",
		},
		{
			name:     "NotFound",
			caller:   admin,
			targetID: "7777",
			body:     gin.H{"transfer_to_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().RemoveUserTx(gomock.Any(), gomock.Any()).Return(db.RemoveUserTxResult{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:     "TransferTargetMissing",
			caller:   admin,
			targetID: target,
			body:     gin.H{"transfer_to_id": 999999},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().RemoveUserTx(gomock.Any(), gomock.Any()).Return(db.RemoveUserTxResult{}, db.ErrReassignTargetNotFound)
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_transfer_target",
		},
		{
			name:     "TransferToThemselves",
			caller:   admin,
			targetID: target,
			body:     gin.H{"transfer_to_id": contributor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().RemoveUserTx(gomock.Any(), gomock.Any()).Return(db.RemoveUserTxResult{}, db.ErrReassignToRemovedUser)
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_transfer_target",
		},
		{
			name:     "TxFails",
			caller:   admin,
			targetID: target,
			body:     gin.H{"transfer_to_id": editor.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().RemoveUserTx(gomock.Any(), gomock.Any()).Return(db.RemoveUserTxResult{}, errors.New("boom"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name:       "EditorForbidden",
			caller:     editor,
			targetID:   target,
			body:       gin.H{"transfer_to_id": editor.ID},
			wantStatus: http.StatusForbidden,
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
				store.EXPECT().RemoveUserTx(gomock.Any(), gomock.Any()).Times(0)
			}

			server, collab := newMembersTestServer(t, store, http.StatusOK)
			rec := sendAuthedJSON(t, server, http.MethodDelete, "/api/v1/users/"+tc.targetID, tc.body, &tc.caller)
			require.Equal(t, tc.wantStatus, rec.Code, rec.Body.String())
			if tc.wantCode != "" {
				require.Contains(t, rec.Body.String(), `"code":"`+tc.wantCode+`"`)
			}
			if tc.rechecked {
				require.Equal(t, []string{"POST /internal/users/" + tc.targetID + "/recheck"}, collab.calls())
				require.Contains(t, rec.Body.String(), `"posts_reassigned":3`)
			} else {
				require.Empty(t, collab.calls())
			}
		})
	}
}

// The collab server being down doesn't fail a removal: the re-check is best
// effort and its periodic one catches up.
func TestDeleteUserCollabDown(t *testing.T) {
	admin, editor, contributor := guardUsers()
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, admin)
	store.EXPECT().RemoveUserTx(gomock.Any(), gomock.Any()).Return(db.RemoveUserTxResult{}, nil)

	server, collab := newMembersTestServer(t, store, http.StatusServiceUnavailable)
	rec := sendAuthedJSON(t, server, http.MethodDelete, fmt.Sprintf("/api/v1/users/%d", contributor.ID), gin.H{"transfer_to_id": editor.ID}, &admin)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, collab.calls(), 1)
}

func TestLastActiveStale(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	at := func(ago time.Duration) db.User {
		return db.User{LastActiveAt: sql.NullTime{Time: now.Add(-ago), Valid: true}}
	}
	require.True(t, lastActiveStale(db.User{}, 5*time.Minute, now), "never active")
	require.False(t, lastActiveStale(at(time.Minute), 5*time.Minute, now))
	require.True(t, lastActiveStale(at(5*time.Minute), 5*time.Minute, now))
	require.True(t, lastActiveStale(at(time.Hour), 5*time.Minute, now))
	require.False(t, lastActiveStale(db.User{}, 0, now), "tracking off")
}

// authMiddleware writes last_active_at only when the row it already loaded is
// stale, so a burst of requests costs no writes; and a failed write never fails
// the request.
func TestAuthMiddlewareLastActive(t *testing.T) {
	_, editor, _ := guardUsers()
	interval := 5 * time.Minute

	for _, tc := range []struct {
		name    string
		last    sql.NullTime
		touches int
		err     error
	}{
		{"NeverActive", sql.NullTime{}, 1, nil},
		{"Stale", sql.NullTime{Time: time.Now().Add(-time.Hour), Valid: true}, 1, nil},
		{"Fresh", sql.NullTime{Time: time.Now().Add(-time.Minute), Valid: true}, 0, nil},
		{"WriteFails", sql.NullTime{}, 1, sql.ErrConnDone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			caller := editor
			caller.LastActiveAt = tc.last
			stubRoleLookup(store, caller)
			store.EXPECT().
				TouchUserLastActive(gomock.Any(), db.TouchUserLastActiveParams{ID: caller.ID, MinAgeSeconds: interval.Seconds()}).
				Times(tc.touches).
				Return(int64(1), tc.err)

			server := newRateLimitedTestServer(t, store, func(c *util.Config) { c.LastActiveInterval = interval })
			rec := sendAuthedJSON(t, server, http.MethodGet, "/api/v1/users/me", nil, &caller)
			require.Equal(t, http.StatusOK, rec.Code)
		})
	}
}
