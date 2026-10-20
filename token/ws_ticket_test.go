package token

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestWSTicketRoundTrip(t *testing.T) {
	maker := newTestV4Maker(t)

	ticket, minted, err := maker.CreateWSTicket(42, "alice", "post-7", 30*time.Second)
	require.NoError(t, err)

	payload, err := maker.VerifyWSTicket(ticket)
	require.NoError(t, err)
	require.Equal(t, minted.ID, payload.ID)
	require.Equal(t, int64(42), payload.UserID)
	require.Equal(t, "alice", payload.Username)
	require.Equal(t, "post-7", payload.Doc)
	require.WithinDuration(t, minted.ExpiredAt, payload.ExpiredAt, time.Second)
}

// A ticket must never work as an API bearer token, and an access token must
// never work as a ticket.
func TestWSTicketAndAccessTokenAreNotInterchangeable(t *testing.T) {
	maker := newTestV4Maker(t)

	ticket, _, err := maker.CreateWSTicket(42, "alice", "post-7", 30*time.Second)
	require.NoError(t, err)
	_, err = maker.VerifyToken(ticket)
	require.ErrorIs(t, err, ErrInvalidTokenV4)

	access, err := maker.CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)
	_, err = maker.VerifyWSTicket(access)
	require.ErrorIs(t, err, ErrInvalidTokenV4)
}

// Even when the API's own audience is configured as the ticket audience, the
// token_type claim still keeps the two apart.
func TestWSTicketRejectedByVerifyTokenWithSameAudience(t *testing.T) {
	maker := newTestV4Maker(t)
	maker.keys.Audience = WSTicketAudience

	ticket, _, err := maker.CreateWSTicket(42, "alice", "post-7", 30*time.Second)
	require.NoError(t, err)
	_, err = maker.VerifyToken(ticket)
	require.ErrorIs(t, err, ErrInvalidTokenV4)

	access, err := maker.CreateToken(42, "alice", time.Minute)
	require.NoError(t, err)
	_, err = maker.VerifyWSTicket(access)
	require.ErrorIs(t, err, ErrInvalidTokenV4)
}

func TestWSTicketExpired(t *testing.T) {
	maker := newTestV4Maker(t)

	ticket, _, err := maker.CreateWSTicket(42, "alice", "post-7", -time.Second)
	require.NoError(t, err)
	_, err = maker.VerifyWSTicket(ticket)
	require.Error(t, err)
}

func TestWSTicketFromOtherKeyRejected(t *testing.T) {
	ticket, _, err := newTestV4Maker(t).CreateWSTicket(42, "alice", "post-7", 30*time.Second)
	require.NoError(t, err)
	_, err = newTestV4Maker(t).VerifyWSTicket(ticket)
	require.ErrorIs(t, err, ErrInvalidTokenV4)
}
