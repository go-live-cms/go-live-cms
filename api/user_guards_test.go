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

// sendAuthedJSON sends body (raw string or JSON-marshalled value) to url as
// caller. A nil caller sends no Authorization header.
func sendAuthedJSON(t *testing.T, server *Server, method, url string, body any, caller *db.User) *httptest.ResponseRecorder {
	t.Helper()

	var data []byte
	switch b := body.(type) {
	case nil:
	case string:
		data = []byte(b)
	default:
		var err error
		data, err = json.Marshal(b)
		require.NoError(t, err)
	}

	request, err := http.NewRequest(method, url, bytes.NewReader(data))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	if caller != nil {
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	}

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// guardUsers returns an admin, an editor and a contributor with distinct IDs
// (randomUserNew is seeded, so it always returns the same user).
func guardUsers() (admin, editor, contributor db.User) {
	base := randomUserNew()

	admin = base
	admin.ID, admin.Username, admin.Email, admin.Role = 7001, "site-admin", "admin@example.com", RoleAdmin
	editor = base
	editor.ID, editor.Username, editor.Email, editor.Role = 7002, "content-editor", "editor@example.com", RoleEditor
	contributor = base
	contributor.ID, contributor.Username, contributor.Email, contributor.Role = 7003, "contributor", "contrib@example.com", RoleContributor
	return admin, editor, contributor
}

// TestUpdateUserGuards covers updateUser's authorization and failure paths
// that TestUpdateUserAPI and TestUpdateUserPasswordAPI don't: an editor is a
// content editor, not a site admin, so it gets no say over other accounts.
func TestUpdateUserGuards(t *testing.T) {
	admin, editor, contributor := guardUsers()

	testCases := []struct {
		name          string
		caller        db.User
		targetID      string
		body          any
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:     "InvalidID",
			caller:   admin,
			targetID: "abc",
			body:     gin.H{"full_name": "New Name"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "EditorCannotUpdateOtherUser",
			caller:   editor,
			targetID: fmt.Sprint(contributor.ID),
			body:     gin.H{"full_name": "Hijacked"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(contributor.ID)).Times(0)
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:     "EditorCannotResetAdminPassword",
			caller:   editor,
			targetID: fmt.Sprint(admin.ID),
			body:     gin.H{"password": "taken-over"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:     "EditorCannotPromoteSelf",
			caller:   editor,
			targetID: fmt.Sprint(editor.ID),
			body:     gin.H{"role": RoleAdmin},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
				require.Contains(t, recorder.Body.String(), "only admins can change roles")
			},
		},
		{
			name:     "InvalidBody",
			caller:   contributor,
			targetID: fmt.Sprint(contributor.ID),
			body:     gin.H{"email": "not-an-email"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "InvalidRoleValue",
			caller:   admin,
			targetID: fmt.Sprint(contributor.ID),
			body:     gin.H{"role": "superuser"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "AdminTargetLookupFails",
			caller:   admin,
			targetID: fmt.Sprint(contributor.ID),
			body:     gin.H{"full_name": "New Name"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(contributor.ID)).Times(1).Return(db.User{}, sql.ErrConnDone)
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:     "UpdateTxFails",
			caller:   contributor,
			targetID: fmt.Sprint(contributor.ID),
			body:     gin.H{"full_name": "New Name"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpdateUserTx(gomock.Any(), gomock.Any()).Times(1).Return(db.UpdateUserTxResult{}, errors.New("deadlock"))
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			// Only the sent fields change; the role, hash and password stamp
			// come from the current row, and the email is normalized.
			name:     "SelfUpdateKeepsUnsentFields",
			caller:   contributor,
			targetID: fmt.Sprint(contributor.ID),
			body:     gin.H{"email": "New.Address@Example.COM"},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(1).
					DoAndReturn(func(_ any, arg db.UpdateUserTxParams) (db.UpdateUserTxResult, error) {
						require.Equal(t, contributor.ID, arg.ID)
						require.Equal(t, "new.address@example.com", arg.Email)
						require.Equal(t, contributor.Username, arg.Username)
						require.Equal(t, contributor.FullName, arg.FullName)
						require.Equal(t, RoleContributor, arg.Role)
						require.Equal(t, contributor.HashedPassword, arg.HashedPassword)
						require.Equal(t, contributor.PasswordChangedAt, arg.PasswordChangedAt)
						require.True(t, arg.CheckUniqueness)
						require.False(t, arg.PasswordChanged)

						updated := contributor
						updated.Email = arg.Email
						return db.UpdateUserTxResult{User: updated}, nil
					})
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.NotContains(t, recorder.Body.String(), "hashed_password")
				require.NotContains(t, recorder.Body.String(), "access_token")
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, tc.caller)

			server := newTestServer(t, store)
			recorder := sendAuthedJSON(t, server, http.MethodPut, "/api/v1/users/"+tc.targetID, tc.body, &tc.caller)
			tc.checkResponse(t, recorder)
		})
	}
}

// TestDeleteUserGuards covers deleteUser's paths beyond TestDeleteUserAPI.
func TestDeleteUserGuards(t *testing.T) {
	admin, editor, contributor := guardUsers()
	target := fmt.Sprint(contributor.ID)

	testCases := []struct {
		name          string
		caller        db.User
		targetID      string
		body          any
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			// Editors manage content, not accounts.
			name:     "EditorForbidden",
			caller:   editor,
			targetID: target,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(contributor.ID)).Times(0)
				store.EXPECT().DeleteUserTx(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().DeleteUserWithTransferTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:     "InvalidID",
			caller:   admin,
			targetID: "abc",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().DeleteUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "TargetLookupFails",
			caller:   admin,
			targetID: target,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(contributor.ID)).Times(1).Return(db.User{}, sql.ErrConnDone)
				store.EXPECT().DeleteUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			// A body that doesn't bind is refused (#139): deleting instead of
			// transferring would lose the user's content.
			name:     "MalformedBodyIsRefused",
			caller:   admin,
			targetID: target,
			body:     `{"transfer_to_id": "not-a-number"`,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(contributor.ID)).Times(0)
				store.EXPECT().DeleteUserTx(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().DeleteUserWithTransferTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:     "DeleteTxFails",
			caller:   admin,
			targetID: target,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(contributor.ID)).Times(1).Return(contributor, nil)
				store.EXPECT().DeleteUserTx(gomock.Any(), gomock.Eq(contributor.ID)).Times(1).Return(errors.New("fk violation"))
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
				require.Contains(t, recorder.Body.String(), "failed to delete user")
			},
		},
		{
			name:     "TransferTxFails",
			caller:   admin,
			targetID: target,
			body:     gin.H{"transfer_to_id": admin.ID},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(contributor.ID)).Times(1).Return(contributor, nil)
				store.EXPECT().
					DeleteUserWithTransferTx(gomock.Any(), gomock.Eq(db.DeleteUserWithTransferTxParams{UserID: contributor.ID, TransferToID: admin.ID})).
					Times(1).
					Return(errors.New("transfer target missing"))
				store.EXPECT().DeleteUserTx(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
				require.Contains(t, recorder.Body.String(), "failed to delete user with transfer")
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, tc.caller)

			server := newTestServer(t, store)
			recorder := sendAuthedJSON(t, server, http.MethodDelete, "/api/v1/users/"+tc.targetID, tc.body, &tc.caller)
			tc.checkResponse(t, recorder)
		})
	}
}

// TestCreateUserGuards: only site admins create accounts, and a DB failure
// is a 500, not a conflict.
func TestCreateUserGuards(t *testing.T) {
	admin, editor, _ := guardUsers()
	body := gin.H{
		"username":  "newperson",
		"email":     "new@example.com",
		"full_name": "New Person",
		"password":  "secret123",
		"role":      RoleAdmin,
	}

	t.Run("EditorForbidden", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()

		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(0)
		stubRoleLookup(store, editor)

		server := newTestServer(t, store)
		recorder := sendAuthedJSON(t, server, http.MethodPost, "/api/v1/users", body, &editor)
		require.Equal(t, http.StatusForbidden, recorder.Code)
	})

	t.Run("StoreError", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()

		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().CreateUser(gomock.Any(), gomock.Any()).Times(1).Return(db.User{}, sql.ErrConnDone)
		stubRoleLookup(store, admin)

		server := newTestServer(t, store)
		recorder := sendAuthedJSON(t, server, http.MethodPost, "/api/v1/users", body, &admin)
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
	})
}

// TestGetUserByUsernameAPI: the public profile route needs no auth and must
// never expose the email or password hash.
func TestGetUserByUsernameAPI(t *testing.T) {
	_, _, user := guardUsers()

	testCases := []struct {
		name          string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Eq(user.Username)).Times(1).Return(user, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)

				var rsp struct {
					User map[string]any `json:"user"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
				require.Equal(t, user.Username, rsp.User["username"])
				require.Equal(t, user.FullName, rsp.User["full_name"])
				require.NotContains(t, rsp.User, "email")
				require.NotContains(t, recorder.Body.String(), user.Email)
				require.NotContains(t, recorder.Body.String(), "hashed_password")
				require.NotContains(t, recorder.Body.String(), user.HashedPassword)
			},
		},
		{
			name: "NotFound",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(1).Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByUsername(gomock.Any(), gomock.Any()).Times(1).Return(db.User{}, sql.ErrConnDone)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := sendAuthedJSON(t, server, http.MethodGet, "/api/v1/users/"+user.Username, nil, nil)
			tc.checkResponse(t, recorder)
		})
	}
}

// TestGetUserByEmailAPI: looking a user up by email is admin-only, since it
// confirms whether an address has an account.
func TestGetUserByEmailAPI(t *testing.T) {
	admin, editor, user := guardUsers()

	testCases := []struct {
		name          string
		caller        *db.User
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			caller: &admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByEmail(gomock.Any(), gomock.Eq(user.Email)).Times(1).Return(user, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.Contains(t, recorder.Body.String(), user.Email)
				require.NotContains(t, recorder.Body.String(), "hashed_password")
			},
		},
		{
			name:   "EditorForbidden",
			caller: &editor,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByEmail(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name: "NoAuthorization",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByEmail(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "NotFound",
			caller: &admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByEmail(gomock.Any(), gomock.Any()).Times(1).Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			caller: &admin,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUserByEmail(gomock.Any(), gomock.Any()).Times(1).Return(db.User{}, sql.ErrConnDone)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			if tc.caller != nil {
				stubRoleLookup(store, *tc.caller)
			}

			server := newTestServer(t, store)
			recorder := sendAuthedJSON(t, server, http.MethodGet, "/api/v1/users/email/"+user.Email, nil, tc.caller)
			tc.checkResponse(t, recorder)
		})
	}
}
