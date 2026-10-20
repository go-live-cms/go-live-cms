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
	"github.com/google/uuid"
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

func redeemCollabTicket(t *testing.T, server *Server, credential string) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, "/api/v1/collab/tickets/redeem", nil)
	require.NoError(t, err)
	if credential != "" {
		request.Header.Set(authorizationHeaderKey, "Bearer "+credential)
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
			name:   "ContributorForbidden",
			body:   gin.H{"doc": "post-12"},
			caller: &contributor,
			checkResponse: func(t *testing.T, _ *Server, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
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

			server := newTestServer(t, store)
			recorder := postCollabTicket(t, server, tc.body, tc.caller)
			tc.checkResponse(t, server, recorder)
		})
	}
}

func TestRedeemCollabTicket(t *testing.T) {
	user := randomUserNew()
	user.Role = RoleEditor
	user.PasswordChangedAt = time.Now().Add(-time.Hour)

	mint := func(t *testing.T, server *Server, doc string) string {
		ticket, _, err := server.collabTickets.CreateWSTicket(user.ID, user.Username, doc, collabTicketTTL)
		require.NoError(t, err)
		return ticket
	}

	t.Run("ReturnsCurrentRoleAndDoc", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		demoted := user
		demoted.Role = RoleContributor
		store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(demoted, nil)
		server := newTestServer(t, store)

		recorder := redeemCollabTicket(t, server, mint(t, server, "post-9"))
		require.Equal(t, http.StatusOK, recorder.Code)

		var res struct {
			User struct {
				ID       int64  `json:"id"`
				Username string `json:"username"`
				Role     string `json:"role"`
			} `json:"user"`
			Doc string `json:"doc"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
		require.Equal(t, user.ID, res.User.ID)
		require.Equal(t, user.Username, res.User.Username)
		// The role comes from the DB, not from when the ticket was minted.
		require.Equal(t, RoleContributor, res.User.Role)
		require.Equal(t, "post-9", res.Doc)
	})

	t.Run("SecondRedemptionRejected", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(user, nil)
		server := newTestServer(t, store)

		ticket := mint(t, server, "post-9")
		require.Equal(t, http.StatusOK, redeemCollabTicket(t, server, ticket).Code)
		require.Equal(t, http.StatusUnauthorized, redeemCollabTicket(t, server, ticket).Code)
	})

	t.Run("BurnedEvenWhenLookupFails", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(db.User{}, sql.ErrConnDone)
		server := newTestServer(t, store)

		ticket := mint(t, server, "post-9")
		require.Equal(t, http.StatusInternalServerError, redeemCollabTicket(t, server, ticket).Code)
		require.Equal(t, http.StatusUnauthorized, redeemCollabTicket(t, server, ticket).Code)
	})

	t.Run("AccessTokenRejected", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		server := newTestServer(t, store)

		access, err := server.tokenMaker.CreateToken(user.ID, user.Username, time.Minute)
		require.NoError(t, err)
		require.Equal(t, http.StatusUnauthorized, redeemCollabTicket(t, server, access).Code)
	})

	t.Run("MissingCredential", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		server := newTestServer(t, mockdb.NewMockStore(ctrl))
		require.Equal(t, http.StatusUnauthorized, redeemCollabTicket(t, server, "").Code)
	})

	t.Run("DeletedUserForbidden", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(db.User{}, sql.ErrNoRows)
		server := newTestServer(t, store)

		require.Equal(t, http.StatusForbidden, redeemCollabTicket(t, server, mint(t, server, "post-9")).Code)
	})

	t.Run("IssuedBeforePasswordChangeRejected", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		changed := user
		changed.PasswordChangedAt = time.Now().Add(5 * time.Second)
		store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(changed, nil)
		server := newTestServer(t, store)

		require.Equal(t, http.StatusUnauthorized, redeemCollabTicket(t, server, mint(t, server, "post-9")).Code)
	})

	t.Run("TicketFromAnotherKeyRejected", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		other := newTestServer(t, mockdb.NewMockStore(ctrl))
		server := newTestServer(t, mockdb.NewMockStore(ctrl))

		require.Equal(t, http.StatusUnauthorized, redeemCollabTicket(t, server, mint(t, other, "post-9")).Code)
	})
}

func TestTicketReplayGuard(t *testing.T) {
	guard := newTicketReplayGuard()
	now := time.Now()
	a, b := uuid.New(), uuid.New()

	require.True(t, guard.consume(a, now.Add(30*time.Second), now))
	require.False(t, guard.consume(a, now.Add(30*time.Second), now))
	require.True(t, guard.consume(b, now.Add(30*time.Second), now))

	// Expired entries are pruned, so the map doesn't grow without bound.
	require.True(t, guard.consume(uuid.New(), now.Add(time.Hour), now.Add(time.Minute)))
	require.Len(t, guard.used, 1)
}

var _ collabTicketMaker = (*token.PasetoV4Maker)(nil)
