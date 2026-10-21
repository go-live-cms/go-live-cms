package api

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
)

// recordingTicketMaker is a collabTicketMaker that records what it was asked
// to mint and returns err (or a fixed ticket).
type recordingTicketMaker struct {
	err      error
	userID   int64
	username string
	doc      string
	calls    int
}

func (m *recordingTicketMaker) CreateWSTicket(userID int64, username, doc string, dur time.Duration) (string, *token.WSTicketPayload, error) {
	m.calls++
	m.userID, m.username, m.doc = userID, username, doc
	if m.err != nil {
		return "", nil, m.err
	}
	return "v4.public.fake", &token.WSTicketPayload{UserID: userID, Username: username, Doc: doc, ExpiredAt: time.Now().Add(dur)}, nil
}

func (m *recordingTicketMaker) VerifyWSTicket(string) (*token.WSTicketPayload, error) {
	return nil, errors.New("not implemented")
}

func TestCreateCollabTicketMinting(t *testing.T) {
	editor := randomUserNew()
	editor.Role = RoleEditor

	t.Run("MintFailureIs500", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, editor)

		server := newTestServer(t, store)
		maker := &recordingTicketMaker{err: errors.New("signing failed")}
		server.collabTickets = maker

		recorder := postCollabTicket(t, server, gin.H{"doc": "post-3"}, &editor)
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
		require.NotContains(t, recorder.Body.String(), "ticket\":")
		require.Equal(t, 1, maker.calls)
	})

	// The ticket names the caller as the DB knows them, not whatever username
	// the access token carries.
	t.Run("TicketUsesCallerRow", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, editor)

		server := newTestServer(t, store)
		maker := &recordingTicketMaker{}
		server.collabTickets = maker

		staleToken := editor
		staleToken.Username = "renamed-since-login"
		recorder := postCollabTicket(t, server, gin.H{"doc": "post-3"}, &staleToken)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Equal(t, editor.ID, maker.userID)
		require.Equal(t, editor.Username, maker.username)
		require.Equal(t, "post-3", maker.doc)
	})

	t.Run("InvalidDocNeverMints", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		defer ctrl.Finish()
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, editor)

		server := newTestServer(t, store)
		maker := &recordingTicketMaker{}
		server.collabTickets = maker

		for _, doc := range []string{"post-", "post-0", "post-abc", "post-1/../2", "POST-1", " post-1"} {
			recorder := postCollabTicket(t, server, gin.H{"doc": doc}, &editor)
			require.Equal(t, http.StatusBadRequest, recorder.Code, doc)
		}
		require.Zero(t, maker.calls)
	})
}

// TestNewServerRejectsBadKeys: a malformed PASETO key must stop startup, not
// produce a server that can't sign or verify.
func TestNewServerRejectsBadKeys(t *testing.T) {
	testCases := []struct {
		name   string
		mutate func(cfg *util.Config)
	}{
		{"PrivateKey", func(cfg *util.Config) { cfg.PasetoV4PrivateKeyHex = "zz" }},
		{"PublicKey", func(cfg *util.Config) { cfg.PasetoV4PublicKeyHex = "abcd" }},
		{"LocalKey", func(cfg *util.Config) { cfg.PasetoV4LocalKeyHex = "" }},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			config := newTestConfig(t)
			tc.mutate(&config)

			server, err := NewServer(config, nil)
			require.Error(t, err)
			require.Contains(t, err.Error(), "failed to create token maker")
			require.Nil(t, server)
		})
	}
}
