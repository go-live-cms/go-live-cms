// Package api — Server hooks (#458): the dispatcher
//
// Plugins observe posts through events the database writes (000055): one trigger on
// posts inserts post.saved, post.published, post.unpublished, post.trashed,
// post.restored and post.deleted into plugin_events, in the transaction of the change,
// and only when an enabled plugin subscribes. No Go call site writes an event, so
// every publish path (the button, bulk, the scheduler, scheduled updates, post_status
// through PUT or POST /posts) produces one, and a path added later can't forget it.
//
// RunPluginHooks, started from main.go in every replica like RunScheduledPublishing,
// drains that outbox every PLUGIN_HOOKS_INTERVAL (1s):
//
//  1. Fan out: one plugin_hook_runs row per event and plugin enabled and subscribed
//     now (FanOutPluginEvents, one replica at a time, in event order).
//  2. Skip the runs of plugins disabled, missing or incompatible since.
//  3. Claim due runs FOR UPDATE SKIP LOCKED with a two-minute lease, which is also
//     the fencing token the result is recorded under. A run whose lease passed (the
//     process died) is claimed again, so delivery is at least once.
//  4. Run each hook on its own goroutine, outside any transaction, with its
//     timeout_ms (default 10s, at most 30s) on the context and panics recovered.
//  5. Record done, or a failure with the scheduler's backoff (30s to 10 min), at most
//     8 attempts, then failed; plugin_hook_failed goes to the activity log, at most
//     once per plugin per 10 minutes (a final failure always).
//
// A hook can't touch the change that caused its event: that transaction committed
// before the event was visible. It can't slow one either: the only work inside it is
// the trigger's insert. A hook that ignores its context can't be killed, so each
// plugin gets two slots in this process and all plugins eight; a stuck hook holds its
// slot until it returns, which stalls only that plugin.
//
// Within one plugin a post's events run in order: a run isn't claimed while an earlier
// run of the same plugin for the same post is unfinished (pending or running), so a
// failing run holds the later ones for that pair until it succeeds or gives up.
// Plugins don't wait for each other.
//
// Hooks only observe (no mutating filters), and pluginsdk has no write access to
// posts: only the collab server writes block_doc (rule 11).
//
// Retention: done and skipped runs go after 7 days, failed after 30, and an event
// once it has no runs left. While no enabled plugin has a hook, the loop only looks
// every 30 seconds.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

const (
	// pluginHookLease is how long a claim keeps other replicas off a run: well past
	// the longest timeout, so a live run never loses it.
	pluginHookLease = 2 * time.Minute
	// pluginHookDefaultTimeout and pluginHookMaxTimeout bound one attempt
	// (plugin.json's timeout_ms; the validator caps it at 30s as well).
	pluginHookDefaultTimeout = 10 * time.Second
	pluginHookMaxTimeout     = 30 * time.Second
	// pluginHookMaxAttempts: then the run is failed for good.
	pluginHookMaxAttempts = 8
	// Concurrency in this process: per plugin, and for all plugins.
	pluginHookSlotsPerPlugin = 2
	pluginHookSlotsTotal     = 8
	// pluginHooksIdleCheck: how often to look again while no plugin has a hook.
	pluginHooksIdleCheck = 30 * time.Second
	// pluginHooksFanOutBatch events per FanOutPluginEvents; pluginHooksFanOutRounds
	// bounds the batches per round.
	pluginHooksFanOutBatch  = 500
	pluginHooksFanOutRounds = 20
	// pluginHookStatementTimeout bounds each dispatcher statement.
	pluginHookStatementTimeout = 10 * time.Second
	// pluginHookErrorMax caps last_error (000055's CHECK), in characters.
	pluginHookErrorMax = 1000
	// pluginHookFailedWindow throttles plugin_hook_failed per plugin.
	pluginHookFailedWindow = 10 * time.Minute

	// Retention.
	pluginHookPruneInterval   = time.Hour
	pluginHookDoneRetention   = 7 * 24 * time.Hour
	pluginHookFailedRetention = 30 * 24 * time.Hour
	pluginHookPruneBatch      = 5000
)

// pluginHookRegistry is the plugins' server code by slug: pluginsdk.Registered() in
// the API (filled by api/plugins_gen.go's imports), a test's own map in tests.
type pluginHookRegistry map[string]pluginsdk.Plugin

// pluginHooksMismatch says how a plugin's registered hooks differ from the ones its
// plugin.json declares, or "" when they match. A plugin with neither has nothing to
// compare. Every declared hook counts, the publish guard (post.before_publish) too:
// until the contract has guards (#459) a plugin that declares one can't honour it.
//
// A webhook plugin (server.webhook, #460) has its hooks delivered to a URL, so it must
// have no Go code: one plugin's hooks are either compiled in or a webhook, never both.
func pluginHooksMismatch(manifest PluginManifest, registered pluginsdk.Plugin, isRegistered bool) string {
	if manifest.Server.Webhook != nil {
		if isRegistered {
			return "declares server.webhook but also registers hooks in Go"
		}
		return ""
	}
	declared := make([]string, 0, len(manifest.Server.Hooks))
	for _, hook := range manifest.Server.Hooks {
		declared = append(declared, hook.Event)
	}
	slices.Sort(declared)
	var implemented []string
	if isRegistered {
		implemented = registered.HookEvents()
	}
	if slices.Equal(declared, implemented) || (len(declared) == 0 && len(implemented) == 0) {
		return ""
	}
	var missing, undeclared []string
	for _, event := range declared {
		if !slices.Contains(implemented, event) {
			missing = append(missing, event)
		}
	}
	for _, event := range implemented {
		if !slices.Contains(declared, event) {
			undeclared = append(undeclared, event)
		}
	}
	var parts []string
	if len(missing) > 0 {
		parts = append(parts, "declared without a hook in Go: "+strings.Join(missing, ", "))
	}
	if len(undeclared) > 0 {
		parts = append(parts, "hooks in Go not declared in plugin.json: "+strings.Join(undeclared, ", "))
	}
	return strings.Join(parts, "; ")
}

// hookPlugin is one plugin whose hooks this process can run in a round.
type hookPlugin struct {
	id       int64
	slug     string
	manifest PluginManifest
	code     pluginsdk.Plugin
	events   []string
}

// timeout is the hook's timeout_ms, defaulted and capped.
func (p hookPlugin) timeout(event string) time.Duration {
	for _, hook := range p.manifest.Server.Hooks {
		if hook.Event == event && hook.TimeoutMS > 0 {
			return min(time.Duration(hook.TimeoutMS)*time.Millisecond, pluginHookMaxTimeout)
		}
	}
	return pluginHookDefaultTimeout
}

// pluginHookDispatcher runs hooks for one Server. Slots are counted here and held
// until the hook's goroutine returns, not until its result is recorded: a hook that
// ignores its context keeps costing its slot.
type pluginHookDispatcher struct {
	server   *Server
	registry pluginHookRegistry

	mu       sync.Mutex
	inUse    map[string]int
	inUseAll int

	// inFlight counts the runs being executed or recorded (not the hook goroutines
	// themselves): what a shutdown waits for.
	inFlight sync.WaitGroup

	// nextSkip is when round runs skipInactive again (only the loop's goroutine).
	nextSkip time.Time
}

func newPluginHookDispatcher(server *Server, registry pluginHookRegistry) *pluginHookDispatcher {
	return &pluginHookDispatcher{server: server, registry: registry, inUse: map[string]int{}}
}

// RunPluginHooks drains the plugin event outbox every interval until ctx is done, then
// returns once the runs in flight are recorded (a hook gets at most its timeout).
// interval 0 turns it off in this process; other replicas still run hooks. main.go
// runs it beside the HTTP listeners.
func (server *Server) RunPluginHooks(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		server.logger.Info("plugin hooks are off in this process (PLUGIN_HOOKS_INTERVAL=0)")
		return
	}
	dispatcher := newPluginHookDispatcher(server, server.pluginRegistry)
	server.logger.Info("plugin hooks started", "interval", interval.String(), "registered_plugins", len(server.pluginRegistry))
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var nextLook, nextPrune time.Time
	for {
		now := time.Now()
		if !now.Before(nextPrune) {
			dispatcher.prune(ctx)
			nextPrune = now.Add(pluginHookPruneInterval)
		}
		if !now.Before(nextLook) {
			if active := dispatcher.round(ctx); !active {
				nextLook = now.Add(pluginHooksIdleCheck)
			}
		}
		select {
		case <-ctx.Done():
			dispatcher.inFlight.Wait()
			server.logger.Info("plugin hooks stopped")
			return
		case <-ticker.C:
		}
	}
}

// round is one pass: fan out, skip what can't run, claim and start due runs. It
// returns whether any enabled plugin has hooks (false: the loop can idle). The runs it
// starts go on in the background; inFlight.Wait waits for them.
func (d *pluginHookDispatcher) round(ctx context.Context) bool {
	log := d.server.logger
	plugins, err := d.activePlugins(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Warn("plugin_hooks_list_failed", "error", err)
		}
		return true
	}
	d.fanOut(ctx)
	// Disabling a plugin or dropping a hook is rare, and the claim never takes such runs
	// meanwhile: the skip only has to catch up, not run every round.
	if now := time.Now(); !now.Before(d.nextSkip) {
		d.skipInactive(ctx)
		d.nextSkip = now.Add(pluginHooksIdleCheck)
	}
	if len(plugins) == 0 {
		return false
	}
	for _, plugin := range plugins {
		if ctx.Err() != nil {
			break
		}
		d.claimAndStart(ctx, plugin)
	}
	return true
}

// skipInactive marks the runs that can never run as skipped (SkipInactivePluginHookRuns).
func (d *pluginHookDispatcher) skipInactive(ctx context.Context) {
	statementCtx, cancel := context.WithTimeout(ctx, pluginHookStatementTimeout)
	defer cancel()
	skipped, err := d.server.store.SkipInactivePluginHookRuns(statementCtx)
	switch {
	case err != nil:
		if ctx.Err() == nil {
			d.server.logger.Warn("plugin_hooks_skip_failed", "error", err)
		}
	case skipped > 0:
		d.server.logger.Info("plugin hook runs skipped: their plugin or hook no longer runs", "runs", skipped)
	}
}

// activePlugins is the plugins table's enabled plugins with hooks, limited to those
// whose code this process has. A plugin enabled in the database but not registered
// here (another build in a rolling deploy) is left to the replicas that have it. A
// webhook plugin (#460) needs no code: every replica delivers its hooks, through an
// observer per hook that POSTs the event (plugin_webhooks.go).
func (d *pluginHookDispatcher) activePlugins(ctx context.Context) ([]hookPlugin, error) {
	statementCtx, cancel := context.WithTimeout(ctx, pluginHookStatementTimeout)
	defer cancel()
	rows, err := d.server.store.ListHookPlugins(statementCtx)
	if err != nil {
		return nil, err
	}
	out := make([]hookPlugin, 0, len(rows))
	for _, row := range rows {
		code, ok := d.registry[row.Slug]
		var manifest PluginManifest
		if err := json.Unmarshal(row.Manifest, &manifest); err != nil {
			continue
		}
		if pluginHooksMismatch(manifest, code, ok) != "" {
			// Not ours to run: the startup scan marks a mismatch incompatible.
			continue
		}
		switch {
		case manifest.Server.Webhook != nil:
			code = d.server.webhookPlugin(row.Slug, manifest)
		case !ok:
			continue
		}
		// Register refuses any event that isn't an observer event.
		plugin := hookPlugin{id: row.ID, slug: row.Slug, manifest: manifest, code: code, events: code.HookEvents()}
		if len(plugin.events) > 0 {
			out = append(out, plugin)
		}
	}
	return out, nil
}

// fanOut writes the runs of pending events, a batch at a time.
func (d *pluginHookDispatcher) fanOut(ctx context.Context) {
	for i := 0; i < pluginHooksFanOutRounds && ctx.Err() == nil; i++ {
		statementCtx, cancel := context.WithTimeout(ctx, pluginHookStatementTimeout)
		result, err := d.server.store.FanOutPluginEvents(statementCtx, pluginHooksFanOutBatch)
		cancel()
		if err != nil {
			if ctx.Err() == nil {
				d.server.logger.Warn("plugin_events_fan_out_failed", "error", err)
			}
			return
		}
		if !result.Locked || result.FannedOut+result.Dropped < pluginHooksFanOutBatch {
			return
		}
	}
}

// acquire takes a slot for plugin slug when one is free.
func (d *pluginHookDispatcher) acquire(slug string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.inUse[slug] >= pluginHookSlotsPerPlugin || d.inUseAll >= pluginHookSlotsTotal {
		return false
	}
	d.inUse[slug]++
	d.inUseAll++
	return true
}

func (d *pluginHookDispatcher) release(slug string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.inUse[slug]--
	d.inUseAll--
}

// free is how many runs of slug this process can start now.
func (d *pluginHookDispatcher) free(slug string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return min(pluginHookSlotsPerPlugin-d.inUse[slug], pluginHookSlotsTotal-d.inUseAll)
}

// claimAndStart claims as many due runs of plugin as it has free slots, and starts
// them.
func (d *pluginHookDispatcher) claimAndStart(ctx context.Context, plugin hookPlugin) {
	free := d.free(plugin.slug)
	if free <= 0 {
		return
	}
	statementCtx, cancel := context.WithTimeout(ctx, pluginHookStatementTimeout)
	claims, err := d.server.store.ClaimDuePluginHookRuns(statementCtx, db.ClaimDuePluginHookRunsParams{
		PluginID:     plugin.id,
		Events:       plugin.events,
		LeaseSeconds: pluginHookLease.Seconds(),
		MaxRuns:      int32(free),
	})
	cancel()
	if err != nil {
		if ctx.Err() == nil {
			d.server.logger.Warn("plugin_hooks_claim_failed", "plugin", plugin.slug, "error", err)
		}
		return
	}
	for _, claim := range claims {
		// Only this goroutine acquires, so the slots counted free are still free.
		if !d.acquire(plugin.slug) {
			// Unreachable; the lease runs out and another round takes the run.
			d.server.logger.Error("plugin hook claimed without a free slot", "plugin", plugin.slug, "event_id", claim.EventID)
			continue
		}
		d.inFlight.Add(1)
		go d.execute(ctx, plugin, claim)
	}
}

// execute runs one claimed run and records the result. The hook gets its own
// goroutine, which releases the slot when it returns; execute stops waiting at the
// timeout and records it, so a hung hook costs a slot, not the record.
func (d *pluginHookDispatcher) execute(ctx context.Context, plugin hookPlugin, claim db.ClaimDuePluginHookRunsRow) {
	defer d.inFlight.Done()
	requestID := uuid.NewString()
	log := d.server.logger.With(requestIDKey, requestID, "plugin", plugin.slug, "event", claim.Event,
		"event_id", claim.EventID, "post_id", claim.PostID, "attempt", claim.Attempts)

	observer := plugin.code.Observers[claim.Event]
	event := pluginEventFromClaim(claim)
	timeout := plugin.timeout(claim.Event)
	// Not cancelled with ctx: on shutdown the run in flight gets its timeout, as the
	// scheduler's attempt does.
	hookCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	host := &pluginHost{server: d.server, plugin: plugin, log: log}

	result := make(chan error, 1)
	started := time.Now()
	go func() {
		defer d.release(plugin.slug)
		result <- callObserver(hookCtx, log, observer, host, event)
	}()
	var err error
	select {
	case err = <-result:
	case <-hookCtx.Done():
		err = fmt.Errorf("timed out after %s", timeout)
	}
	d.record(ctx, log, plugin, claim, err, time.Since(started))
}

// callObserver calls the hook with panics recovered: a plugin's panic is a failed
// attempt, never a crashed API.
func callObserver(ctx context.Context, log *slog.Logger, observer pluginsdk.Observer, host pluginsdk.Host, event pluginsdk.Event) (err error) {
	defer func() {
		if rec := recover(); rec != nil {
			log.Error("plugin_hook_panic", "error", fmt.Sprint(rec), "stack", string(debug.Stack()))
			err = fmt.Errorf("panic: %v", rec)
		}
	}()
	if observer == nil {
		return errors.New("no hook registered for this event")
	}
	return observer(ctx, host, event)
}

func pluginEventFromClaim(claim db.ClaimDuePluginHookRunsRow) pluginsdk.Event {
	data := map[string]any{}
	_ = json.Unmarshal(claim.Data, &data)
	return pluginsdk.Event{
		ID:         claim.EventID,
		PostID:     claim.PostID,
		ActorID:    claim.ActorID.Int64,
		Name:       claim.Event,
		Data:       data,
		OccurredAt: claim.CreatedAt,
	}
}

// record stores a run's result under its claim. A lost claim (the lease ran out and
// another replica took the run) records nothing: that replica's attempt counts.
func (d *pluginHookDispatcher) record(ctx context.Context, log *slog.Logger, plugin hookPlugin, claim db.ClaimDuePluginHookRunsRow, runErr error, took time.Duration) {
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pluginHookStatementTimeout)
	defer cancel()
	if runErr == nil {
		rows, err := d.server.store.RecordPluginHookRunDone(recordCtx, db.RecordPluginHookRunDoneParams{
			EventID: claim.EventID, PluginID: claim.PluginID, Claim: claim.Claim,
		})
		switch {
		case err != nil:
			log.Error("recording a plugin hook run failed; it runs again when the claim expires", "error", err)
		case rows == 0:
			log.Warn("plugin hook result not recorded: the claim was lost")
		default:
			log.Info("plugin hook ran", "duration_ms", took.Milliseconds())
		}
		return
	}

	retry := scheduledPublishRetryAfter(claim.Attempts)
	message := capPluginHookError(runErr.Error())
	outcome, err := d.server.store.RecordPluginHookRunFailure(recordCtx, db.RecordPluginHookRunFailureParams{
		MaxAttempts:       pluginHookMaxAttempts,
		RetryAfterSeconds: retry.Seconds(),
		LastError:         message,
		EventID:           claim.EventID,
		PluginID:          claim.PluginID,
		Claim:             claim.Claim,
	})
	if errors.Is(err, sql.ErrNoRows) {
		log.Warn("plugin hook failure not recorded: the claim was lost", "error", message)
		return
	}
	if err != nil {
		log.Error("recording a failed plugin hook run failed; it runs again when the claim expires", "error", err)
		return
	}
	final := outcome.Status == "failed"
	if final {
		log.Warn("plugin_hook_failed", "error", message, "attempts", outcome.Attempts, "final", true, "duration_ms", took.Milliseconds())
	} else {
		log.Warn("plugin_hook_failed", "error", message, "attempts", outcome.Attempts, "retry_in", retry.String(), "duration_ms", took.Milliseconds())
	}
	payload, _ := json.Marshal(map[string]any{
		"event": claim.Event, "event_id": claim.EventID, "attempts": outcome.Attempts, "final": final,
	})
	// Retries are throttled; a run given up for good is always recorded: its event is
	// lost to this plugin, which an admin has to be able to see.
	window := pluginHookFailedWindow.Seconds()
	if final {
		window = 0
	}
	if _, err := d.server.store.CreatePluginHookFailedActivity(recordCtx, db.CreatePluginHookFailedActivityParams{
		PluginID:      plugin.id,
		Payload:       payload,
		WindowSeconds: window,
	}); err != nil {
		log.Warn("activity_record_failed", "verb", db.ActivityPluginHookFailed, "object_type", db.ActivityObjectPlugin, "object_id", plugin.id, "error", err)
	}
}

// capPluginHookError keeps last_error within 000055's limit, on a rune boundary.
func capPluginHookError(message string) string {
	if utf8.RuneCountInString(message) <= pluginHookErrorMax {
		return message
	}
	runes := []rune(message)
	return string(runes[:pluginHookErrorMax-1]) + "…"
}

// prune applies the retention: finished runs by age, then events with no runs left.
func (d *pluginHookDispatcher) prune(ctx context.Context) {
	now := time.Now()
	for _, rule := range []struct {
		status string
		keep   time.Duration
	}{
		{"done", pluginHookDoneRetention},
		{"skipped", pluginHookDoneRetention},
		{"failed", pluginHookFailedRetention},
	} {
		if _, err := d.pruneBatches(ctx, func(ctx context.Context) (int64, error) {
			return d.server.store.DeleteFinishedPluginHookRuns(ctx, db.DeleteFinishedPluginHookRunsParams{
				Status: rule.status, Cutoff: now.Add(-rule.keep), BatchSize: pluginHookPruneBatch,
			})
		}); err != nil {
			if ctx.Err() == nil {
				d.server.logger.Warn("plugin_hook_runs_prune_failed", "status", rule.status, "error", err)
			}
			return
		}
	}
	if _, err := d.pruneBatches(ctx, func(ctx context.Context) (int64, error) {
		return d.server.store.DeleteSpentPluginEvents(ctx, pluginHookPruneBatch)
	}); err != nil && ctx.Err() == nil {
		d.server.logger.Warn("plugin_events_prune_failed", "error", err)
	}
}

func (d *pluginHookDispatcher) pruneBatches(ctx context.Context, batch func(context.Context) (int64, error)) (int64, error) {
	var total int64
	for ctx.Err() == nil {
		batchCtx, cancel := context.WithTimeout(ctx, activityPruneTimeout)
		n, err := batch(batchCtx)
		cancel()
		total += n
		if err != nil {
			return total, err
		}
		if n < pluginHookPruneBatch {
			return total, nil
		}
	}
	return total, ctx.Err()
}

// pluginHooksMismatch compares a plugin.json with this build's code for slug.
func (server *Server) pluginHooksMismatch(slug string, manifest PluginManifest) string {
	code, ok := server.pluginRegistry[slug]
	return pluginHooksMismatch(manifest, code, ok)
}
