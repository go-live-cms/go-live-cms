// Package api — Publish guards (#459, docs/design/plugin-system.md 7.3, 7.7)
//
// A guard is a plugin's Plugin.BeforePublish, declared in plugin.json as
// {"event": "post.before_publish", "on_error": "allow" | "deny", "priority": n}. It
// is how a plugin is designed to stop a publish, kept apart from observers (which
// run after the commit and can't hurt one).
//
// Guards run before the publish's transaction, never inside PublishPostTx (7.3: a
// plugin's code must not run under the post's row lock), on every path that
// publishes:
//
//   - publishPostByID (the Publish/Update button and bulk publish) and
//     publishScheduledPost, after their collab flush, on the working copy that is
//     about to be snapshotted;
//   - applyScheduledUpdate, on the update's frozen snapshot;
//   - POST /posts and PUT /posts/:id when the request sets post_status to published,
//     on the body that goes live (the post's current published body: that path makes
//     no version).
//
// Only enabled, installed plugins whose code is in this build and matches their
// plugin.json run. They run one at a time in (priority, slug) order and the first
// denial wins. Each gets pluginGuardTimeout and all of them together
// pluginGuardBudget, through the context; a guard that ignores its context is no
// longer waited for once its time is up (its goroutine is left to finish, as an
// observer's is). An error, a panic or a timeout is logged and allows the publish,
// unless the plugin declared on_error "deny".
//
// A denial is a 409 plugin_refused with the reason (bulk: that post's failure in the
// report), and in the scheduler a failed attempt with the reason code plugin_refused
// (schedule_failure, or the scheduled update's failure), retried with the usual
// backoff, so fixing the post lets the next attempt through.
//
// It's a policy check, not a lock: an edit stored between the guard and the
// transaction is published unchecked, the same window the collab flush has.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// pluginGuardTimeout bounds one guard, pluginGuardBudget all of a publish's
// (design 7.7). Variables only so tests can run them shorter.
var (
	pluginGuardTimeout = 3 * time.Second
	pluginGuardBudget  = 5 * time.Second
)

const (
	// pluginGuardReasonMax caps a denial's reason, in characters.
	pluginGuardReasonMax = 280
	// codePluginRefused is the 409's code (bulk reports it per post), and the reason
	// code the scheduler records (publish_error, a scheduled update's error).
	codePluginRefused = "plugin_refused"
	// pluginGuardOnErrorDeny is plugin.json's on_error value that makes a failed guard
	// refuse the publish.
	pluginGuardOnErrorDeny = "deny"
)

// publishGuard is one plugin's guard, ready to run.
type publishGuard struct {
	plugin      hookPlugin
	guard       pluginsdk.Guard
	priority    int
	onErrorDeny bool
}

// onError is plugin.json's on_error for the guard, defaulted.
func (g publishGuard) onError() string {
	if g.onErrorDeny {
		return pluginGuardOnErrorDeny
	}
	return "allow"
}

// pluginRefusal is a publish a guard refused.
type pluginRefusal struct {
	// Plugin is the plugin's slug.
	Plugin string
	// Reason is the plain-text reason shown to whoever published.
	Reason string
}

// actionError is the 409 the publish routes answer (and bulk reports).
func (r *pluginRefusal) actionError() *postActionError {
	return &postActionError{Status: http.StatusConflict, Code: codePluginRefused, Message: r.Reason}
}

// errPublishGuardsUnavailable: the guards couldn't be listed, so none could run and
// nothing is published.
var errPublishGuardsUnavailable = errors.New("the publish guards could not be checked")

// publishGuardsFailedError is what a publish route answers when the guards couldn't
// be listed: nothing published, try again.
func publishGuardsFailedError() *postActionError {
	return &postActionError{Status: http.StatusServiceUnavailable, Code: codePostActionFailed,
		Message: "the plugins that check publishing could not be reached; nothing was published, try again"}
}

// hasGuardCode says whether any plugin in this build has a guard: without one no
// publish needs to read the plugins table.
func (server *Server) hasGuardCode() bool {
	for _, code := range server.pluginRegistry {
		if code.BeforePublish != nil {
			return true
		}
	}
	return false
}

// publishGuards lists the guards that run now, in order.
func (server *Server) publishGuards(ctx context.Context) ([]publishGuard, error) {
	if !server.hasGuardCode() {
		return nil, nil
	}
	rows, err := server.store.ListHookPlugins(ctx)
	if err != nil {
		return nil, err
	}
	guards := []publishGuard{}
	for _, row := range rows {
		code, registered := server.pluginRegistry[row.Slug]
		if !registered || code.BeforePublish == nil {
			continue
		}
		var manifest PluginManifest
		if err := json.Unmarshal(row.Manifest, &manifest); err != nil {
			continue
		}
		if mismatch := pluginHooksMismatch(manifest, code, true); mismatch != "" {
			// The startup scan marks it incompatible; until then its guard can't be
			// trusted to be the one plugin.json describes.
			server.logger.Warn("plugin_guard_skipped", "plugin", row.Slug, "reason", mismatch)
			continue
		}
		guard := publishGuard{
			plugin: hookPlugin{id: row.ID, slug: row.Slug, manifest: manifest, code: code},
			guard:  code.BeforePublish,
		}
		for _, hook := range manifest.Server.Hooks {
			if hook.Event == pluginGuardEvent {
				guard.priority = hook.Priority
				guard.onErrorDeny = hook.OnError == pluginGuardOnErrorDeny
			}
		}
		guards = append(guards, guard)
	}
	sort.SliceStable(guards, func(i, j int) bool {
		if guards[i].priority != guards[j].priority {
			return guards[i].priority < guards[j].priority
		}
		return guards[i].plugin.slug < guards[j].plugin.slug
	})
	return guards, nil
}

// runPublishGuards asks every guard about a publish and returns the first refusal,
// or nil when the publish may go ahead. candidate is called only when a guard runs,
// so a site without guards reads nothing more; its error is returned as is. An error
// listing the guards is errPublishGuardsUnavailable.
func (server *Server) runPublishGuards(ctx context.Context, log *slog.Logger, candidate func(context.Context) (pluginsdk.PublishCandidate, error)) (*pluginRefusal, error) {
	guards, err := server.publishGuards(ctx)
	if err != nil {
		log.Error("plugin_guards_list_failed", "error", err)
		return nil, fmt.Errorf("%w: %v", errPublishGuardsUnavailable, err)
	}
	if len(guards) == 0 {
		return nil, nil
	}
	publish, err := candidate(ctx)
	if err != nil {
		return nil, err
	}
	budget, cancel := context.WithTimeout(ctx, pluginGuardBudget)
	defer cancel()
	for _, guard := range guards {
		if refusal := server.runPublishGuard(budget, log, guard, publish); refusal != nil {
			return refusal, nil
		}
	}
	return nil, nil
}

// runPublishGuard runs one guard within what is left of the budget.
func (server *Server) runPublishGuard(budget context.Context, log *slog.Logger, guard publishGuard, publish pluginsdk.PublishCandidate) *pluginRefusal {
	log = log.With("plugin", guard.plugin.slug, "post_id", publish.PostID, "via", publish.Via)
	started := time.Now()
	var decision pluginsdk.Decision
	var err error
	if budget.Err() != nil {
		// The guards before this one used the whole budget.
		err = fmt.Errorf("not run: the %s budget for all guards was used up", pluginGuardBudget)
	} else {
		guardCtx, cancel := context.WithTimeout(budget, pluginGuardTimeout)
		host := &pluginHost{server: server, plugin: guard.plugin, log: log}
		decision, err = callGuard(guardCtx, log, host, guard.guard, publish)
		cancel()
	}
	took := time.Since(started).Milliseconds()

	if err != nil {
		log.Warn("plugin_guard_failed", "error", capPluginHookError(err.Error()), "on_error", guard.onError(), "duration_ms", took)
		if !guard.onErrorDeny {
			return nil
		}
		return &pluginRefusal{Plugin: guard.plugin.slug,
			Reason: fmt.Sprintf("%s couldn't check this post, so it wasn't published. Try again.", pluginDisplayName(guard.plugin))}
	}
	if !decision.Deny {
		return nil
	}
	reason := cleanGuardReason(decision.Reason)
	if reason == "" {
		reason = fmt.Sprintf("%s refused to publish this post.", pluginDisplayName(guard.plugin))
	}
	// The reason is the plugin's text about the post: not logged (ids, not content).
	log.Info("plugin_guard_refused", "duration_ms", took)
	return &pluginRefusal{Plugin: guard.plugin.slug, Reason: reason}
}

// callGuard runs the guard on its own goroutine with panics recovered, and stops
// waiting when ctx is done: a guard that ignores its context can't hold a publish
// past its time.
func callGuard(ctx context.Context, log *slog.Logger, host pluginsdk.Host, guard pluginsdk.Guard, publish pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
	type answer struct {
		decision pluginsdk.Decision
		err      error
	}
	// Each guard gets its own copy of the body: one can't change what the next sees.
	publish.BlockDoc = append(json.RawMessage(nil), publish.BlockDoc...)
	result := make(chan answer, 1)
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Error("plugin_guard_panic", "error", fmt.Sprint(rec), "stack", string(debug.Stack()))
				result <- answer{err: fmt.Errorf("panic: %v", rec)}
			}
		}()
		decision, err := guard(ctx, host, publish)
		result <- answer{decision, err}
	}()
	select {
	case got := <-result:
		return got.decision, got.err
	case <-ctx.Done():
		return pluginsdk.Decision{}, fmt.Errorf("timed out: %w", ctx.Err())
	}
}

// pluginDisplayName is the plugin's name for a reason the API writes itself.
func pluginDisplayName(plugin hookPlugin) string {
	if name := strings.TrimSpace(plugin.manifest.Name); name != "" {
		return name
	}
	return plugin.slug
}

// cleanGuardReason makes a guard's reason one line of plain text: control characters
// and runs of white space become one space, and it's cut at pluginGuardReasonMax.
func cleanGuardReason(reason string) string {
	if !utf8.ValidString(reason) {
		reason = strings.ToValidUTF8(reason, "")
	}
	reason = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, reason)
	reason = strings.Join(strings.Fields(reason), " ")
	if utf8.RuneCountInString(reason) > pluginGuardReasonMax {
		reason = string([]rune(reason)[:pluginGuardReasonMax-1]) + "…"
	}
	return reason
}
