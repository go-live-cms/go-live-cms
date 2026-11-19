package api

import (
	"context"
	"log/slog"
)

// The hook point of the comment guard (design 14.2; built by #530, on #459's pattern).
//
// The write path calls server.readerCommentGuard after core's checks and before the
// insert, with what the request carried; that is the only point where the client's
// address exists (it is never stored, 7.2). A guard answers allow, hold (with a reason the
// queue shows as "plugin") or spam; it can't approve: moderation stays core's. Its verdict
// is stored with the comment (held_reason "plugin", held_detail its reason), so confirming
// an unconfirmed comment later applies it without calling the plugin again.
//
// Until #530 the hook is nil: no guard, core's rules alone decide. #530 sets it from the
// enabled plugins' declared `comment.before_create` guards (their order, budget and
// on_error), and must keep this contract: never block longer than its budget, never
// panic out, never log the candidate's email, address or text.

// The verdicts a guard may give.
const (
	readerCommentGuardAllow = ""
	readerCommentGuardHold  = "hold"
	readerCommentGuardSpam  = "spam"
)

// readerCommentCandidate is what a guard sees of a comment about to be stored (14.2).
type readerCommentCandidate struct {
	PostID        int64
	ParentID      int64
	Name          string
	Email         string
	Body          string
	IP            string
	UserAgent     string
	HasBrowserKey bool
}

// readerCommentGuardVerdict is a guard's answer: Action is allow (""), hold or spam;
// Reason is shown to moderators (one line, at most held_detail's 200 characters).
type readerCommentGuardVerdict struct {
	Action string
	Reason string
}

// readerCommentGuardFunc runs the guards for one candidate.
type readerCommentGuardFunc func(ctx context.Context, logger *slog.Logger, candidate readerCommentCandidate) readerCommentGuardVerdict

// guardReaderComment asks the guards (none until #530) about a candidate. Anything but
// hold or spam is allow.
func (server *Server) guardReaderComment(ctx context.Context, logger *slog.Logger, candidate readerCommentCandidate) readerCommentGuardVerdict {
	if server.readerCommentGuard == nil {
		return readerCommentGuardVerdict{}
	}
	verdict := server.readerCommentGuard(ctx, logger, candidate)
	switch verdict.Action {
	case readerCommentGuardHold, readerCommentGuardSpam:
		verdict.Reason = truncateRunes(oneLineText(verdict.Reason), heldDetailMax)
		return verdict
	}
	return readerCommentGuardVerdict{}
}
