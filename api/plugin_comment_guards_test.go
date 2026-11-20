package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// Comment guards (#530) without a database: which guards run and in what order, spam
// over hold, errors, panics and timeouts for both on_error values, the budget, the
// verdicts a guard can't give, and the logs. plugin_comment_events_db_test.go runs them
// on the real write path.

// commentGuardRow is an enabled plugin's row whose plugin.json declares the comment guard.
func commentGuardRow(id int64, slug string, priority int, onError string) db.ListHookPluginsRow {
	hook := map[string]any{"event": pluginCommentGuardEvent}
	if priority != 0 {
		hook["priority"] = priority
	}
	if onError != "" {
		hook["on_error"] = onError
	}
	manifest, _ := json.Marshal(map[string]any{
		"manifest_version": 1, "id": slug, "name": "Check " + slug, "version": "1.0.0", "plugin_api": 1,
		"capabilities": []string{pluginsdk.CapabilityCommentsPrivate},
		"server":       map[string]any{"hooks": []any{hook}},
	})
	return db.ListHookPluginsRow{ID: id, Slug: slug, Manifest: manifest}
}

// commentGuardLog records which guards ran, in order.
type commentGuardLog struct {
	mu  sync.Mutex
	ran []string
}

func (g *commentGuardLog) guard(name string, answer func(ctx context.Context) (pluginsdk.CommentDecision, error)) pluginsdk.Plugin {
	return pluginsdk.Plugin{BeforeCommentCreate: func(ctx context.Context, _ pluginsdk.Host, _ pluginsdk.CommentCandidate) (pluginsdk.CommentDecision, error) {
		g.mu.Lock()
		g.ran = append(g.ran, name)
		g.mu.Unlock()
		return answer(ctx)
	}}
}

func (g *commentGuardLog) names() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string{}, g.ran...)
}

func answering(d pluginsdk.CommentDecision) func(context.Context) (pluginsdk.CommentDecision, error) {
	return func(context.Context) (pluginsdk.CommentDecision, error) { return d, nil }
}

func shortCommentGuardBudgets(t *testing.T, each, total time.Duration) {
	t.Helper()
	oldEach, oldTotal := commentGuardTimeout, commentGuardBudget
	commentGuardTimeout, commentGuardBudget = each, total
	t.Cleanup(func() { commentGuardTimeout, commentGuardBudget = oldEach, oldTotal })
}

var testCommentCandidate = readerCommentCandidate{
	PostID: 7, ParentID: 3, Name: "Maya Rivers", Email: "Maya.Rivers@Example.test",
	Body: "My private words about this post.", IP: "203.0.113.9", UserAgent: "TestBrowser/1.0", HasBrowserKey: true,
}

func TestCommentGuardBudgets(t *testing.T) {
	require.Equal(t, 2*time.Second, commentGuardTimeout, "14.2: 2s each")
	require.Equal(t, 3*time.Second, commentGuardBudget, "14.2: 3s in total")
}

// NewServer wires the hook; a build without comment guard code reads nothing.
func TestCommentGuardsNoneInThisBuild(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	require.NotNil(t, server.readerCommentGuard, "NewServer sets the hook")
	server.pluginRegistry = pluginHookRegistry{
		"watcher":   observing(pluginsdk.EventCommentCreated),
		"publisher": guarding(allowGuard),
	}
	store.EXPECT().ListHookPlugins(gomock.Any()).Times(0)
	require.Equal(t, readerCommentGuardVerdict{}, server.guardReaderComment(context.Background(), quietLog(), testCommentCandidate))
}

// Only enabled plugins with a comment guard in this build whose plugin.json matches run,
// in (priority, slug) order, and they see the request.
func TestCommentGuardsWhichAndInWhatOrder(t *testing.T) {
	ran := &commentGuardLog{}
	var seen pluginsdk.CommentCandidate
	registry := pluginHookRegistry{
		"b-check": ran.guard("b-check", answering(pluginsdk.AllowComment())),
		"a-check": ran.guard("a-check", answering(pluginsdk.AllowComment())),
		"first": {BeforeCommentCreate: func(_ context.Context, host pluginsdk.Host, c pluginsdk.CommentCandidate) (pluginsdk.CommentDecision, error) {
			seen = c
			require.Nil(t, host.Comments(), "comments:private alone gives no reader")
			return pluginsdk.AllowComment(), nil
		}},
		// Registered with a publish guard only: its plugin.json's comment guard has no code.
		"mismatch":   guarding(allowGuard),
		"not-loaded": ran.guard("not-loaded", answering(pluginsdk.SpamComment("never asked"))),
	}
	server, _ := guardServer(t, registry,
		commentGuardRow(1, "b-check", 0, ""),
		commentGuardRow(2, "a-check", 0, ""),
		commentGuardRow(3, "first", -5, ""),
		commentGuardRow(4, "mismatch", 0, ""),
	)
	require.Equal(t, readerCommentGuardVerdict{}, server.guardReaderComment(context.Background(), quietLog(), testCommentCandidate))
	require.Equal(t, []string{"a-check", "b-check"}, ran.names())
	require.Equal(t, pluginsdk.CommentCandidate{PostID: 7, ParentID: 3, Name: "Maya Rivers", Email: "Maya.Rivers@Example.test",
		Body: "My private words about this post.", IP: "203.0.113.9", UserAgent: "TestBrowser/1.0", HasBrowserKey: true}, seen)
}

// The first spam wins and stops the rest; a hold is kept while later guards run, so a
// later spam still wins over it; two holds keep the first one's reason.
func TestCommentGuardsSpamWinsOverHold(t *testing.T) {
	ran := &commentGuardLog{}
	registry := pluginHookRegistry{
		"a-hold":  ran.guard("a-hold", answering(pluginsdk.HoldComment("looks odd"))),
		"b-hold":  ran.guard("b-hold", answering(pluginsdk.HoldComment("second opinion"))),
		"c-spam":  ran.guard("c-spam", answering(pluginsdk.SpamComment("  known\nspammer  "))),
		"d-later": ran.guard("d-later", answering(pluginsdk.HoldComment("never asked"))),
	}
	server, _ := guardServer(t, registry, commentGuardRow(1, "a-hold", 0, ""), commentGuardRow(2, "b-hold", 0, ""),
		commentGuardRow(3, "c-spam", 0, ""), commentGuardRow(4, "d-later", 0, ""))
	verdict := server.guardReaderComment(context.Background(), quietLog(), testCommentCandidate)
	require.Equal(t, readerCommentGuardVerdict{Action: readerCommentGuardSpam, Reason: "Check c-spam: known spammer"}, verdict)
	require.Equal(t, []string{"a-hold", "b-hold", "c-spam"}, ran.names())

	holds, _ := guardServer(t, registry, commentGuardRow(1, "a-hold", 0, ""), commentGuardRow(2, "b-hold", 0, ""))
	verdict = holds.guardReaderComment(context.Background(), quietLog(), testCommentCandidate)
	require.Equal(t, readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "Check a-hold: looks odd"}, verdict)
}

// A guard can't approve: an "approve", or any verdict it can't give, is allow, and core's
// rules decide. No reason gets a default naming the plugin.
func TestCommentGuardVerdicts(t *testing.T) {
	cases := map[string]struct {
		decision pluginsdk.CommentDecision
		want     readerCommentGuardVerdict
	}{
		"allow":            {pluginsdk.AllowComment(), readerCommentGuardVerdict{}},
		"zero":             {pluginsdk.CommentDecision{}, readerCommentGuardVerdict{}},
		"approve":          {pluginsdk.CommentDecision{Verdict: "approve", Reason: "trust me"}, readerCommentGuardVerdict{}},
		"unknown":          {pluginsdk.CommentDecision{Verdict: "HOLD"}, readerCommentGuardVerdict{}},
		"hold, no reason":  {pluginsdk.HoldComment(""), readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "Check g held it for review."}},
		"spam, no reason":  {pluginsdk.SpamComment(" "), readerCommentGuardVerdict{Action: readerCommentGuardSpam, Reason: "Check g marked it as spam."}},
		"long reason, cut": {pluginsdk.HoldComment(strings.Repeat("x", 400)), readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "Check g: " + strings.Repeat("x", heldDetailMax-len("Check g: "))}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			server, _ := guardServer(t, pluginHookRegistry{"g": {BeforeCommentCreate: func(context.Context, pluginsdk.Host, pluginsdk.CommentCandidate) (pluginsdk.CommentDecision, error) {
				return tc.decision, nil
			}}}, commentGuardRow(1, "g", 0, ""))
			require.Equal(t, tc.want, server.guardReaderComment(context.Background(), quietLog(), testCommentCandidate))
		})
	}
}

// An error, a panic, a timeout or a guard that hangs: allow, unless on_error is hold.
// Nothing the guard returned about the commenter reaches the logs.
func TestCommentGuardFailuresFollowOnError(t *testing.T) {
	shortCommentGuardBudgets(t, 30*time.Millisecond, time.Second)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	c := testCommentCandidate
	failures := map[string]func(ctx context.Context) (pluginsdk.CommentDecision, error){
		"error": func(context.Context) (pluginsdk.CommentDecision, error) {
			return pluginsdk.CommentDecision{}, errors.New("service refused " + c.Email + " from " + c.IP + ": " + c.Body)
		},
		"panic": func(context.Context) (pluginsdk.CommentDecision, error) {
			panic("bad input from " + strings.ToLower(c.Email) + " " + c.Name)
		},
		"timeout": func(ctx context.Context) (pluginsdk.CommentDecision, error) {
			<-ctx.Done()
			return pluginsdk.CommentDecision{}, ctx.Err()
		},
		"hang": func(context.Context) (pluginsdk.CommentDecision, error) {
			<-release
			return pluginsdk.SpamComment("too late"), nil
		},
	}
	for name, fail := range failures {
		for _, onError := range []string{"", "allow", "hold"} {
			t.Run(name+"/"+onError, func(t *testing.T) {
				ran := &commentGuardLog{}
				server, _ := guardServer(t, pluginHookRegistry{"flaky": ran.guard("flaky", fail)}, commentGuardRow(1, "flaky", 0, onError))
				var logs bytes.Buffer
				var mu sync.Mutex
				log := slog.New(slog.NewJSONHandler(&lockedWriter{mu: &mu, w: &logs}, nil))
				started := time.Now()
				verdict := server.guardReaderComment(context.Background(), log, c)
				require.Less(t, time.Since(started), 500*time.Millisecond, "not waited for past its time")
				if onError == "hold" {
					require.Equal(t, readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "Check flaky couldn't check this comment."}, verdict)
				} else {
					require.Equal(t, readerCommentGuardVerdict{}, verdict)
				}
				mu.Lock()
				text := logs.String()
				mu.Unlock()
				require.Contains(t, text, "plugin_comment_guard_failed")
				requireNoPersonalData(t, text, c.Email, c.IP, c.Body, c.Name, c.UserAgent)
			})
		}
	}
}

// The budget is for all the guards together: once it is used up, the rest are failures
// (their on_error decides) and aren't called.
func TestCommentGuardTotalBudget(t *testing.T) {
	shortCommentGuardBudgets(t, 40*time.Millisecond, 60*time.Millisecond)
	ran := &commentGuardLog{}
	slow := func(ctx context.Context) (pluginsdk.CommentDecision, error) {
		<-ctx.Done()
		return pluginsdk.CommentDecision{}, ctx.Err()
	}
	server, _ := guardServer(t, pluginHookRegistry{
		"a-slow": ran.guard("a-slow", slow),
		"b-slow": ran.guard("b-slow", slow),
		"c-late": ran.guard("c-late", answering(pluginsdk.SpamComment("never asked"))),
	}, commentGuardRow(1, "a-slow", 0, ""), commentGuardRow(2, "b-slow", 0, ""), commentGuardRow(3, "c-late", 0, "hold"))
	started := time.Now()
	verdict := server.guardReaderComment(context.Background(), quietLog(), testCommentCandidate)
	require.Less(t, time.Since(started), 500*time.Millisecond)
	require.Equal(t, []string{"a-slow", "b-slow"}, ran.names(), "the last one isn't called once the budget is gone")
	require.Equal(t, readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "Check c-late couldn't check this comment."}, verdict,
		"and its on_error applies")
}

// The guards can't be listed: the comment is held (a guard this build has may have
// wanted to see it), logged without the candidate.
func TestCommentGuardsListFailureHolds(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	server.pluginRegistry = pluginHookRegistry{"g": {BeforeCommentCreate: func(context.Context, pluginsdk.Host, pluginsdk.CommentCandidate) (pluginsdk.CommentDecision, error) {
		return pluginsdk.AllowComment(), nil
	}}}
	store.EXPECT().ListHookPlugins(gomock.Any()).Return(nil, errors.New("connection refused"))
	verdict := server.guardReaderComment(context.Background(), quietLog(), testCommentCandidate)
	require.Equal(t, readerCommentGuardHold, verdict.Action)
	require.NotEmpty(t, verdict.Reason)
}

// A guard that ignores its context costs at most pluginGuardCallsMax goroutines: past
// that it isn't called and counts as failed.
func TestCommentGuardCallsAreCapped(t *testing.T) {
	shortCommentGuardBudgets(t, 5*time.Millisecond, 50*time.Millisecond)
	release := make(chan struct{})
	var calls sync.WaitGroup
	var mu sync.Mutex
	called := 0
	server, _ := guardServer(t, pluginHookRegistry{"stuck": {BeforeCommentCreate: func(context.Context, pluginsdk.Host, pluginsdk.CommentCandidate) (pluginsdk.CommentDecision, error) {
		calls.Add(1)
		defer calls.Done()
		mu.Lock()
		called++
		mu.Unlock()
		<-release
		return pluginsdk.AllowComment(), nil
	}}}, commentGuardRow(1, "stuck", 0, ""))
	for i := 0; i < pluginGuardCallsMax+3; i++ {
		require.Equal(t, readerCommentGuardVerdict{}, server.guardReaderComment(context.Background(), quietLog(), testCommentCandidate))
	}
	mu.Lock()
	require.Equal(t, pluginGuardCallsMax, called)
	mu.Unlock()
	close(release)
	calls.Wait()
	require.Eventually(t, func() bool { return server.commentGuardCalls.acquire("stuck") }, time.Second, 5*time.Millisecond,
		"the slots come back when the calls return")
}

// redactCandidate blanks the candidate's personal values in a plugin's error text.
func TestRedactCandidate(t *testing.T) {
	c := pluginsdk.CommentCandidate{Name: "Ana", Email: "Ana@Example.test", Body: "hello there", IP: "198.51.100.4", UserAgent: "UA/2"}
	got := redactCandidate("ana@example.test (Ana@Example.test) at 198.51.100.4 said hello there with UA/2; Ana", c)
	require.Equal(t, "[redacted] ([redacted]) at [redacted] said [redacted] with [redacted]; [redacted]", got)
	require.Equal(t, "nothing to hide", redactCandidate("nothing to hide", pluginsdk.CommentCandidate{}))
}
