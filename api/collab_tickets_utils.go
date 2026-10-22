package api

import (
	"regexp"
	"strconv"
	"strings"
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

// postIDFromCollabDoc returns the post id a collab document name refers to,
// or ok=false for anything that isn't a valid "post-<id>".
func postIDFromCollabDoc(doc string) (int64, bool) {
	if !collabDocNamePattern.MatchString(doc) {
		return 0, false
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(doc, "post-"), 10, 64)
	return id, err == nil
}
