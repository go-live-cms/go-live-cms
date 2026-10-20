package api

import (
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// collabTicketTTL is how long a collab ticket stays valid. The editor
// redeems it within milliseconds of minting (fetch, then connect), so this
// only has to cover a slow network.
const collabTicketTTL = 30 * time.Second

// collabDocNamePattern matches the only document names the collab server
// accepts ("post-<id>", isCollabDocName in websocket/access.js). Keep the two
// in sync; a ticket for any other name could never be used.
var collabDocNamePattern = regexp.MustCompile(`^post-[1-9][0-9]{0,18}$`)

// ticketReplayGuard remembers redeemed ticket IDs until they expire, which
// makes tickets single use.
//
// It is in-memory, so it assumes ONE API process (true for the current
// Docker deployment). Running several API replicas would need a shared store
// (a DB table or Redis) here, or a ticket could be redeemed once per replica
// within its 30s lifetime.
type ticketReplayGuard struct {
	mu   sync.Mutex
	used map[uuid.UUID]time.Time
}

func newTicketReplayGuard() *ticketReplayGuard {
	return &ticketReplayGuard{used: make(map[uuid.UUID]time.Time)}
}

// consume marks the ticket as redeemed. It returns false if it already was.
// Entries are dropped once the ticket has expired, because verification
// rejects an expired ticket anyway.
func (g *ticketReplayGuard) consume(id uuid.UUID, expiresAt, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()

	for jti, exp := range g.used {
		if now.After(exp) {
			delete(g.used, jti)
		}
	}

	if _, seen := g.used[id]; seen {
		return false
	}
	g.used[id] = expiresAt
	return true
}

// bearerCredential returns the credential from "Authorization: Bearer <x>",
// or "" if the header is missing or uses another scheme.
func bearerCredential(header string) string {
	fields := strings.Fields(header)
	if len(fields) != 2 || !strings.EqualFold(fields[0], authorizationTypeBearer) {
		return ""
	}
	return fields[1]
}
