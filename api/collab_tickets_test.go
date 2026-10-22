package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

func postCollabTicket(t *testing.T, server *Server, body any, user *db.User) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	require.NoError(t, err)
	request, err := http.NewRequest(http.MethodPost, "/api/v1/collab/tickets", bytes.NewReader(data))
	require.NoError(t, err)
	if user != nil {
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestCreateCollabTicket(t *testing.T) {
	editor := randomUserNew()
	editor.Role = RoleEditor
	contributor := randomUserNew()
	contributor.ID = editor.ID + 1
	contributor.Role = RoleContributor

	testCases := []struct {
		name          string
		body          gin.H
		caller        *db.User
		checkResponse func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "EditorGetsTicketForDoc",
			body:   gin.H{"doc": "post-12"},
			caller: &editor,
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var res struct {
					Ticket    string    `json:"ticket"`
					ExpiresAt time.Time `json:"expires_at"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
				require.WithinDuration(t, time.Now().Add(collabTicketTTL), res.ExpiresAt, 2*time.Second)

				payload, err := server.collabTickets.VerifyWSTicket(res.Ticket)
				require.NoError(t, err)
				require.Equal(t, editor.ID, payload.UserID)
				require.Equal(t, "post-12", payload.Doc)

				// A ticket is never an API bearer token.
				_, err = server.tokenMaker.VerifyToken(res.Ticket)
				require.Error(t, err)
			},
		},
		{
			name:   "ContributorForbiddenOnOthersPost",
			body:   gin.H{"doc": "post-12"},
			caller: &contributor,
			checkResponse: func(t *testing.T, _ *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:   "ContributorGetsTicketForOwnPost",
			body:   gin.H{"doc": "post-13"},
			caller: &contributor,
			checkResponse: func(t *testing.T, server *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var res struct {
					Ticket string `json:"ticket"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
				payload, err := server.collabTickets.VerifyWSTicket(res.Ticket)
				require.NoError(t, err)
				require.Equal(t, contributor.ID, payload.UserID)
				require.Equal(t, "post-13", payload.Doc)
			},
		},
		{
			name:   "ContributorMissingPost",
			body:   gin.H{"doc": "post-14"},
			caller: &contributor,
			checkResponse: func(t *testing.T, _ *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "Unauthenticated",
			body: gin.H{"doc": "post-12"},
			checkResponse: func(t *testing.T, _ *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "MissingDoc",
			body:   gin.H{},
			caller: &editor,
			checkResponse: func(t *testing.T, _ *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "DocThatIsNotAPost",
			body:   gin.H{"doc": "settings"},
			caller: &editor,
			checkResponse: func(t *testing.T, _ *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:   "DocWithPathOrQueryCharacters",
			body:   gin.H{"doc": "post-12?x=1"},
			caller: &editor,
			checkResponse: func(t *testing.T, _ *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, editor)
			stubRoleLookup(store, contributor)
			// Only contributors' tickets look the post up (editors may edit any).
			store.EXPECT().GetPost(gomock.Any(), int64(12)).Return(db.Post{ID: 12, UserID: editor.ID}, nil).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), int64(13)).Return(db.Post{ID: 13, UserID: contributor.ID}, nil).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), int64(14)).Return(db.Post{}, sql.ErrNoRows).AnyTimes()

			server := newTestServer(t, store)
			recorder := postCollabTicket(t, server, tc.body, tc.caller)
			tc.checkResponse(t, server, recorder)
		})
	}
}

var _ collabTicketMaker = (*token.PasetoV4Maker)(nil)
