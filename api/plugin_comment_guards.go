// Package api — Comment guards (#530, docs/design/reader-comments.md 14.2)
//
// A comment guard is a plugin's Plugin.BeforeCommentCreate, declared in plugin.json as
// {"event": "comment.before_create", "on_error": "allow" | "hold", "priority": n} with
// the comments:private capability (the validator requires it: the guard receives the
// commenter's email and IP address). It is #459's publish guard pattern on the comment
// write path:
//
//   - It runs where discussion_guard.go's hook point is: after core's checks and before
//     the insert, in the request of a keyed comment and after the response for a keyless
//     one. That is the only point where the client's address exists.
//   - Only enabled, installed plugins whose code is in this build and matches their
//     plugin.json run, one at a time in (priority, slug) order. The first spam wins and
//     stops the rest; a hold is kept (the first one's reason) while the others run, so a
//     later guard can still say spam.
//   - Each gets commentGuardTimeout and all of them together commentGuardBudget, through
//     the context; one that ignores its context is no longer waited for (its goroutine
//     is left to finish, and its calls are capped like a publish guard's).
//   - An error, a panic or a timeout is logged and allows the comment (core's rules then
//     decide), unless the plugin declared on_error "hold".
//   - It answers allow, hold or spam. There is no approve: anything else is allow, and
//     moderation stays core's.
//
// The verdict becomes held_reason "plugin" (with status pending, or spam) and
// held_detail the plugin's name and reason, stored with the comment, so a confirmation
// applies it without asking again (discussion_write.go). Logs carry ids, the plugin and
// the verdict: never the candidate's name, email, address, user agent or text, nor a
// guard's reason; a guard's error is logged with those values blanked.
package api

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// commentGuardTimeout bounds one comment guard, commentGuardBudget all of a comment's
// (14.2). Variables only so tests can run them shorter.
var (
	commentGuardTimeout = 2 * time.Second
	commentGuardBudget  = 3 * time.Second
)

// commentGuardOnErrorHold is plugin.json's on_error value that makes a failed comment
// guard hold the comment.
const commentGuardOnErrorHold = "hold"

// commentGuard is one plugin's comment guard, ready to run.
type commentGuard struct {
	plugin      hookPlugin
	guard       pluginsdk.CommentGuard
	onErrorHold bool
}

// onError is plugin.json's on_error for the guard, defaulted.
func (g commentGuard) onError() string {
	if g.onErrorHold {
		return commentGuardOnErrorHold
	}
	return "allow"
}

// hasCommentGuardCode says whether any plugin in this build has a comment guard:
// without one no comment reads the plugins table.
func (server *Server) hasCommentGuardCode() bool {
	for _, code := range server.pluginRegistry {
		if code.BeforeCommentCreate != nil {
			return true
		}
	}
	return false
}

// commentGuards lists the comment guards that run now, in order.
func (server *Server) commentGuards(ctx context.Context) ([]commentGuard, error) {
	plugins, err := server.guardPlugins(ctx, pluginCommentGuardEvent, func(p pluginsdk.Plugin) bool { return p.BeforeCommentCreate != nil })
	if err != nil {
		return nil, err
	}
	guards := make([]commentGuard, 0, len(plugins))
	for _, p := range plugins {
		guards = append(guards, commentGuard{plugin: p.plugin, guard: p.plugin.code.BeforeCommentCreate,
			onErrorHold: p.onError == commentGuardOnErrorHold})
	}
	return guards, nil
}

// runCommentGuards is the comment guard hook (server.readerCommentGuard): it asks every
// comment guard about a candidate and returns the verdict core stores. A build without
// comment guard code returns allow without reading anything. When the guards can't be
// listed the comment is held: a guard this build has may have wanted to see it.
func (server *Server) runCommentGuards(ctx context.Context, logger *slog.Logger, candidate readerCommentCandidate) readerCommentGuardVerdict {
	if !server.hasCommentGuardCode() {
		return readerCommentGuardVerdict{}
	}
	if logger == nil {
		logger = server.logger
	}
	guards, err := server.commentGuards(ctx)
	if err != nil {
		logger.Error("plugin_comment_guards_list_failed", "post_id", candidate.PostID, "error", err)
		return readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "The plugins that check comments couldn't be reached."}
	}
	if len(guards) == 0 {
		return readerCommentGuardVerdict{}
	}
	sdkCandidate := pluginsdk.CommentCandidate{
		PostID: candidate.PostID, ParentID: candidate.ParentID,
		Name: candidate.Name, Email: candidate.Email, Body: candidate.Body,
		IP: candidate.IP, UserAgent: candidate.UserAgent, HasBrowserKey: candidate.HasBrowserKey,
	}
	budget, cancel := context.WithTimeout(ctx, commentGuardBudget)
	defer cancel()
	var held *readerCommentGuardVerdict
	for _, guard := range guards {
		verdict := server.runCommentGuard(budget, logger, guard, sdkCandidate)
		switch verdict.Action {
		case readerCommentGuardSpam:
			return verdict
		case readerCommentGuardHold:
			if held == nil {
				held = &verdict
			}
		}
	}
	if held != nil {
		return *held
	}
	return readerCommentGuardVerdict{}
}

// runCommentGuard runs one comment guard within what is left of the budget.
func (server *Server) runCommentGuard(budget context.Context, logger *slog.Logger, guard commentGuard, candidate pluginsdk.CommentCandidate) readerCommentGuardVerdict {
	slug := guard.plugin.slug
	log := logger.With("plugin", slug, "post_id", candidate.PostID)
	started := time.Now()
	var decision pluginsdk.CommentDecision
	var err error
	if budget.Err() != nil {
		// The guards before this one used the whole budget.
		err = fmt.Errorf("not run: the %s budget for all comment guards was used up", commentGuardBudget)
	} else if !server.commentGuardCalls.acquire(slug) {
		// Its calls are all taken, likely by ones that outlived their time.
		err = fmt.Errorf("not run: %d calls of this guard are already running", pluginGuardCallsMax)
	} else {
		guardCtx, cancel := context.WithTimeout(budget, commentGuardTimeout)
		host := &pluginHost{server: server, plugin: guard.plugin, log: log}
		decision, err = callWithDeadline(guardCtx, func(ctx context.Context) (pluginsdk.CommentDecision, error) {
			return guard.guard(ctx, host, candidate)
		}, func(rec any, stack []byte) {
			log.Error("plugin_comment_guard_panic", "error", redactCandidate(fmt.Sprint(rec), candidate), "stack", string(stack))
		}, func() { server.commentGuardCalls.release(slug) })
		cancel()
	}
	took := time.Since(started).Milliseconds()
	name := pluginDisplayName(guard.plugin)

	if err != nil {
		log.Warn("plugin_comment_guard_failed", "error", capPluginHookError(redactCandidate(err.Error(), candidate)),
			"on_error", guard.onError(), "duration_ms", took)
		if !guard.onErrorHold {
			return readerCommentGuardVerdict{}
		}
		return readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: name + " couldn't check this comment."}
	}
	var verdict readerCommentGuardVerdict
	switch decision.Verdict {
	case pluginsdk.CommentHold:
		verdict = readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: commentGuardReason(name, decision.Reason, "held it for review.")}
	case pluginsdk.CommentSpam:
		verdict = readerCommentGuardVerdict{Action: readerCommentGuardSpam, Reason: commentGuardReason(name, decision.Reason, "marked it as spam.")}
	case pluginsdk.CommentAllow, "":
	default:
		// Not a verdict a guard can give (an "approve", say): allow, and core's rules decide.
		log.Warn("plugin_comment_guard_unknown_verdict", "verdict", capPluginHookError(string(decision.Verdict)), "duration_ms", took)
		return readerCommentGuardVerdict{}
	}
	// The reason is the plugin's text about the comment: not logged.
	log.Info("plugin_comment_guard_verdict", "verdict", verdictName(verdict.Action), "duration_ms", took)
	return verdict
}

// verdictName is a verdict as logs say it.
func verdictName(action string) string {
	if action == readerCommentGuardAllow {
		return string(pluginsdk.CommentAllow)
	}
	return action
}

// commentGuardReason is what moderators see beside a held comment (held_detail): the
// plugin's name and its reason as one plain line, or a default when it gave none. Cut to
// held_detail's width by guardReaderComment.
func commentGuardReason(name, reason, fallback string) string {
	if reason = cleanGuardReason(reason); reason == "" {
		return name + " " + fallback
	}
	return name + ": " + reason
}

// redactCandidate blanks the candidate's personal values in text a plugin produced (an
// error, a panic), which may quote them: the logs never hold a commenter's name, email,
// address, user agent or text.
func redactCandidate(text string, c pluginsdk.CommentCandidate) string {
	values := []string{c.Body, c.Email, strings.ToLower(c.Email), c.UserAgent, c.Name, c.IP}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			text = strings.ReplaceAll(text, value, "[redacted]")
		}
	}
	return text
}
