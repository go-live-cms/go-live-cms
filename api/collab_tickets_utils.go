package api

import (
	"regexp"
	"strconv"
	"time"
)

// collabTicketTTL is how long a collab ticket stays valid. The editor
// connects within milliseconds of minting (fetch, then connect), so this
// only has to cover a slow network. The collab server burns each ticket's
// jti on first use, so the TTL also bounds how long it has to remember it.
const collabTicketTTL = 30 * time.Second

// collabDocKind is which kind of collab document a name refers to (#490,
// docs/design/theme-builder.md 7.2): a post's body, or a block template or template
// part (both rows of site_templates, so they share the prefix).
type collabDocKind string

const (
	collabDocPost     collabDocKind = "post"
	collabDocTemplate collabDocKind = "template"
)

// collabDocNamePattern matches the only document names the collab server
// accepts ("post-<id>" and "template-<id>", isCollabDocName in
// web/collab-server/access.ts). Keep the two in sync; a ticket for any other name
// could never be used.
var collabDocNamePattern = regexp.MustCompile(`^(post|template)-([1-9][0-9]{0,18})$`)

// collabDocRef returns the kind and id a collab document name refers to, or
// ok=false for anything that isn't a valid "post-<id>" or "template-<id>".
func collabDocRef(doc string) (collabDocKind, int64, bool) {
	m := collabDocNamePattern.FindStringSubmatch(doc)
	if m == nil {
		return "", 0, false
	}
	id, err := strconv.ParseInt(m[2], 10, 64)
	if err != nil {
		return "", 0, false
	}
	return collabDocKind(m[1]), id, true
}

// postIDFromCollabDoc returns the post id a collab document name refers to,
// or ok=false for anything that isn't a valid "post-<id>".
func postIDFromCollabDoc(doc string) (int64, bool) {
	kind, id, ok := collabDocRef(doc)
	if !ok || kind != collabDocPost {
		return 0, false
	}
	return id, true
}
