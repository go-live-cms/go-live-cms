package api

import (
	"regexp"
	"time"
)

// collabTicketTTL is how long a collab ticket stays valid. The editor
// connects within milliseconds of minting (fetch, then connect), so this
// only has to cover a slow network. The collab server burns each ticket's
// jti on first use, so the TTL also bounds how long it has to remember it.
const collabTicketTTL = 30 * time.Second

// collabDocNamePattern matches the only document names the collab server
// accepts ("post-<id>", isCollabDocName in websocket/access.js). Keep the two
// in sync; a ticket for any other name could never be used.
var collabDocNamePattern = regexp.MustCompile(`^post-[1-9][0-9]{0,18}$`)
