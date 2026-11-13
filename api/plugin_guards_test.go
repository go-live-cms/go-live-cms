package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// Publish guards (#459) without a database: which guards run and in what order,
// denial, errors, panics and timeouts for both on_error values, and the budgets.
// plugin_guards_db_test.go runs them on every publish path against the real one.

func allowGuard(context.Context, pluginsdk.Host, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
	return pluginsdk.Allow(), nil
}

func guarding(guard pluginsdk.Guard) pluginsdk.Plugin {
	return pluginsdk.Plugin{BeforePublish: guard}
}

// guardRow is an enabled plugin's row whose plugin.json declares a guard.
func guardRow(id int64, slug string, priority int, onError string) db.ListHookPluginsRow {
	hook := map[string]any{"event": pluginGuardEvent}
	if priority != 0 {
		hook["priority"] = priority
	}
	if onError != "" {
		hook["on_error"] = onError
	}
	manifest, _ := json.Marshal(map[string]any{
		"manifest_version": 1, "id": slug, "name": "Guard " + slug, "version": "1.0.0", "plugin_api": 1,
		"server": map[string]any{"hooks": []any{hook}},
	})
	return db.ListHookPluginsRow{ID: id, Slug: slug, Manifest: manifest}
}

// guardLog records which guards ran, in order.
type guardLog struct {
	mu  sync.Mutex
	ran []string
}

func (g *guardLog) guard(name string, answer func(ctx context.Context, c pluginsdk.PublishCandidate) (pluginsdk.Decision, error)) pluginsdk.Guard {
	return func(ctx context.Context, host pluginsdk.Host, c pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
		g.mu.Lock()
		g.ran = append(g.ran, name)
		g.mu.Unlock()
		return answer(ctx, c)
	}
}

func (g *guardLog) names() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string{}, g.ran...)
}

func allowing(context.Context, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
	return pluginsdk.Allow(), nil
}

func denying(reason string) func(context.Context, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
	return func(context.Context, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
		return pluginsdk.Deny(reason), nil
	}
}

func guardServer(t *testing.T, registry pluginHookRegistry, rows ...db.ListHookPluginsRow) (*Server, *mockdb.MockStore) {
	t.Helper()
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	server.pluginRegistry = registry
	store.EXPECT().ListHookPlugins(gomock.Any()).AnyTimes().Return(rows, nil)
	return server, store
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func fixedCandidate(c pluginsdk.PublishCandidate) func(context.Context) (pluginsdk.PublishCandidate, error) {
	return func(context.Context) (pluginsdk.PublishCandidate, error) { return c, nil }
}

// shortGuardBudgets runs the timeout tests in milliseconds rather than seconds.
func shortGuardBudgets(t *testing.T, each, total time.Duration) {
	t.Helper()
	oldEach, oldTotal := pluginGuardTimeout, pluginGuardBudget
	pluginGuardTimeout, pluginGuardBudget = each, total
	t.Cleanup(func() { pluginGuardTimeout, pluginGuardBudget = oldEach, oldTotal })
}

func TestPublishGuardBudgets(t *testing.T) {
	require.Equal(t, 3*time.Second, pluginGuardTimeout, "design 7.7: 3s each")
	require.Equal(t, 5*time.Second, pluginGuardBudget, "design 7.7: 5s in total")
}

// No plugin in this build has a guard: nothing is read and the candidate isn't
// built, so a site without guards pays nothing.
func TestPublishGuardsNoneInThisBuild(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	server.pluginRegistry = pluginHookRegistry{"watcher": observing(pluginsdk.EventPostSaved)}
	store.EXPECT().ListHookPlugins(gomock.Any()).Times(0)
	refusal, err := server.runPublishGuards(context.Background(), quietLog(), func(context.Context) (pluginsdk.PublishCandidate, error) {
		t.Fatal("the candidate was built with no guard to ask")
		return pluginsdk.PublishCandidate{}, nil
	})
	require.NoError(t, err)
	require.Nil(t, refusal)
}

// Only enabled plugins with a guard in this build whose plugin.json matches it run,
// in (priority, slug) order.
func TestPublishGuardsWhichAndInWhatOrder(t *testing.T) {
	ran := &guardLog{}
	registry := pluginHookRegistry{
		"bravo":    guarding(ran.guard("bravo", allowing)),
		"alpha":    guarding(ran.guard("alpha", allowing)),
		"first":    guarding(ran.guard("first", allowing)),
		"last":     guarding(ran.guard("last", allowing)),
		"observer": observing(pluginsdk.EventPostSaved),
		// plugin.json declares an observer too; the Go code has none: incompatible.
		"drifted": guarding(ran.guard("drifted", allowing)),
	}
	drifted := guardRow(6, "drifted", 0, "")
	drifted.Manifest = json.RawMessage(`{"id":"drifted","server":{"hooks":[{"event":"post.before_publish"},{"event":"post.saved"}]}}`)
	server, _ := guardServer(t, registry,
		guardRow(1, "alpha", 0, ""),
		guardRow(2, "bravo", 0, ""),
		guardRow(3, "last", 10, ""),
		guardRow(4, "first", -5, ""),
		// Enabled here but not in this build (a rolling deploy).
		guardRow(5, "elsewhere", 0, ""),
		drifted,
		db.ListHookPluginsRow{ID: 7, Slug: "observer", Manifest: json.RawMessage(`{"server":{"hooks":[{"event":"post.saved"}]}}`)},
		db.ListHookPluginsRow{ID: 8, Slug: "bravo-broken", Manifest: json.RawMessage(`not json`)},
	)
	refusal, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{PostID: 1}))
	require.NoError(t, err)
	require.Nil(t, refusal)
	require.Equal(t, []string{"first", "alpha", "bravo", "last"}, ran.names())
}

// The first denial wins: the guards after it don't run, and the reason is cleaned.
func TestPublishGuardFirstDenialWins(t *testing.T) {
	ran := &guardLog{}
	server, _ := guardServer(t, pluginHookRegistry{
		"a-allow": guarding(ran.guard("a-allow", allowing)),
		"b-deny":  guarding(ran.guard("b-deny", denying("  Add alt text\nto every image.\t "))),
		"c-deny":  guarding(ran.guard("c-deny", denying("never asked"))),
	}, guardRow(1, "a-allow", 0, ""), guardRow(2, "b-deny", 0, ""), guardRow(3, "c-deny", 0, ""))

	refusal, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{PostID: 9}))
	require.NoError(t, err)
	require.NotNil(t, refusal)
	require.Equal(t, "b-deny", refusal.Plugin)
	require.Equal(t, "Add alt text to every image.", refusal.Reason)
	require.Equal(t, []string{"a-allow", "b-deny"}, ran.names())

	failure := refusal.actionError()
	require.Equal(t, 409, failure.Status)
	require.Equal(t, codePluginRefused, failure.Code)
	require.Equal(t, refusal.Reason, failure.Message)
}

// A denial without a reason gets one naming the plugin.
func TestPublishGuardDenialWithoutReason(t *testing.T) {
	server, _ := guardServer(t, pluginHookRegistry{"quiet": guarding((&guardLog{}).guard("quiet", denying(" \n ")))},
		guardRow(1, "quiet", 0, ""))
	refusal, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
	require.NoError(t, err)
	require.Equal(t, "Guard quiet refused to publish this post.", refusal.Reason)
}

// An error, a panic or a timeout allows the publish unless on_error is "deny".
func TestPublishGuardFailures(t *testing.T) {
	shortGuardBudgets(t, 50*time.Millisecond, 500*time.Millisecond)
	failures := map[string]pluginsdk.Guard{
		"error": func(context.Context, pluginsdk.Host, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
			// The decision that comes with an error doesn't count.
			return pluginsdk.Deny("ignored"), errors.New("upstream down")
		},
		"panic": func(context.Context, pluginsdk.Host, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
			panic("boom")
		},
		"timeout": func(ctx context.Context, _ pluginsdk.Host, _ pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
			<-ctx.Done()
			return pluginsdk.Allow(), nil
		},
		// Ignores its context: no longer waited for once its time is up.
		"hang": func(context.Context, pluginsdk.Host, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
			time.Sleep(time.Second)
			return pluginsdk.Allow(), nil
		},
	}
	for name, guard := range failures {
		for _, onError := range []string{"", "allow", "deny"} {
			t.Run(name+"/on_error="+onError, func(t *testing.T) {
				server, _ := guardServer(t, pluginHookRegistry{"flaky": guarding(guard)}, guardRow(1, "flaky", 0, onError))
				started := time.Now()
				refusal, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
				require.NoError(t, err)
				require.Less(t, time.Since(started), 400*time.Millisecond, "waited past the guard's time")
				if onError != "deny" {
					require.Nil(t, refusal, "a failed guard allows by default")
					return
				}
				require.NotNil(t, refusal)
				require.Equal(t, "flaky", refusal.Plugin)
				require.Equal(t, "Guard flaky couldn't check this post, so it wasn't published. Try again.", refusal.Reason)
			})
		}
	}
}

// All guards together get pluginGuardBudget: a guard whose turn comes after it is
// used up doesn't run, and counts as a timeout (on_error decides).
func TestPublishGuardTotalBudget(t *testing.T) {
	shortGuardBudgets(t, 150*time.Millisecond, 250*time.Millisecond)
	ran := &guardLog{}
	slow := func(ctx context.Context, _ pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
		select {
		case <-time.After(140 * time.Millisecond):
		case <-ctx.Done():
		}
		return pluginsdk.Allow(), nil
	}
	registry := pluginHookRegistry{
		"a": guarding(ran.guard("a", slow)),
		"b": guarding(ran.guard("b", slow)),
		"c": guarding(ran.guard("c", allowing)),
	}

	t.Run("allow", func(t *testing.T) {
		ran.ran = nil
		server, _ := guardServer(t, registry, guardRow(1, "a", 0, ""), guardRow(2, "b", 0, ""), guardRow(3, "c", 0, ""))
		started := time.Now()
		refusal, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
		require.NoError(t, err)
		require.Nil(t, refusal)
		require.Less(t, time.Since(started), 400*time.Millisecond)
		require.Equal(t, []string{"a", "b"}, ran.names(), "c's turn came after the budget")
	})
	t.Run("deny", func(t *testing.T) {
		ran.ran = nil
		server, _ := guardServer(t, registry, guardRow(1, "a", 0, ""), guardRow(2, "b", 0, ""), guardRow(3, "c", 0, "deny"))
		refusal, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
		require.NoError(t, err)
		require.NotNil(t, refusal)
		require.Equal(t, "c", refusal.Plugin)
		require.Equal(t, []string{"a", "b"}, ran.names())
	})
}

// A guard gets the candidate and its own copy of the body; a host for its plugin.
func TestPublishGuardCandidate(t *testing.T) {
	var seen []pluginsdk.PublishCandidate
	var hosts []pluginsdk.Host
	record := func(mutate bool) pluginsdk.Guard {
		return func(_ context.Context, host pluginsdk.Host, c pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
			seen = append(seen, c)
			hosts = append(hosts, host)
			if mutate {
				copy(c.BlockDoc, "XXXX")
			}
			return pluginsdk.Allow(), nil
		}
	}
	server, _ := guardServer(t, pluginHookRegistry{"one": guarding(record(true)), "two": guarding(record(false))},
		guardRow(1, "one", 0, ""), guardRow(2, "two", 0, ""))
	body := []byte(`{"doc_version":1}`)
	want := pluginsdk.PublishCandidate{PostID: 4, PostType: "page", ActorID: 8, Via: pluginsdk.PublishViaButton, BlockDoc: body}
	_, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(want))
	require.NoError(t, err)
	require.Len(t, seen, 2)
	require.Equal(t, want.PostID, seen[1].PostID)
	require.Equal(t, "page", seen[1].PostType)
	require.Equal(t, int64(8), seen[1].ActorID)
	require.Equal(t, pluginsdk.PublishViaButton, seen[1].Via)
	require.JSONEq(t, `{"doc_version":1}`, string(seen[1].BlockDoc), "the first guard's change reached the second")
	require.Equal(t, `{"doc_version":1}`, string(body), "the caller's body changed")
	require.Nil(t, hosts[0].Posts(), "posts:read isn't declared")
	require.NotNil(t, hosts[0].Log())
}

// The guards can't be listed: nothing is published (the caller answers 503); the
// candidate's own error comes back as is.
func TestPublishGuardErrors(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	server.pluginRegistry = pluginHookRegistry{"g": guarding(allowGuard)}
	store.EXPECT().ListHookPlugins(gomock.Any()).Return(nil, errors.New("db down"))
	_, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
	require.ErrorIs(t, err, errPublishGuardsUnavailable)

	server, _ = guardServer(t, pluginHookRegistry{"g": guarding(allowGuard)}, guardRow(1, "g", 0, ""))
	gone := errors.New("gone")
	_, err = server.runPublishGuards(context.Background(), quietLog(), func(context.Context) (pluginsdk.PublishCandidate, error) {
		return pluginsdk.PublishCandidate{}, gone
	})
	require.ErrorIs(t, err, gone)
}

// A plugin with pluginGuardCallsMax calls already running (guards that ignored their
// context) isn't called again: it counts as failed, and on_error decides. A call that
// returns gives its slot back.
func TestPublishGuardCallsCap(t *testing.T) {
	for _, onError := range []string{"", "deny"} {
		t.Run("on_error="+onError, func(t *testing.T) {
			ran := &guardLog{}
			server, _ := guardServer(t, pluginHookRegistry{"stuck": guarding(ran.guard("stuck", allowing))}, guardRow(1, "stuck", 0, onError))
			for i := 0; i < pluginGuardCallsMax; i++ {
				require.True(t, server.guardCalls.acquire("stuck"))
			}
			refusal, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
			require.NoError(t, err)
			require.Empty(t, ran.names(), "called past the cap")
			if onError == "deny" {
				require.NotNil(t, refusal)
			} else {
				require.Nil(t, refusal)
			}

			// Once a slot is free it runs again, and gives the slot back.
			server.guardCalls.release("stuck")
			_, err = server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
			require.NoError(t, err)
			require.Equal(t, []string{"stuck"}, ran.names())
			require.Eventually(t, func() bool {
				server.guardCalls.mu.Lock()
				defer server.guardCalls.mu.Unlock()
				return server.guardCalls.inUse["stuck"] == pluginGuardCallsMax-1
			}, time.Second, 5*time.Millisecond)
		})
	}
}

// A hung guard keeps its slot until it returns, however late.
func TestPublishGuardHungCallHoldsSlot(t *testing.T) {
	shortGuardBudgets(t, 20*time.Millisecond, 100*time.Millisecond)
	release := make(chan struct{})
	hung := func(context.Context, pluginsdk.Host, pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
		<-release
		return pluginsdk.Allow(), nil
	}
	server, _ := guardServer(t, pluginHookRegistry{"hung": guarding(hung)}, guardRow(1, "hung", 0, ""))
	inUse := func() int {
		server.guardCalls.mu.Lock()
		defer server.guardCalls.mu.Unlock()
		return server.guardCalls.inUse["hung"]
	}
	_, err := server.runPublishGuards(context.Background(), quietLog(), fixedCandidate(pluginsdk.PublishCandidate{}))
	require.NoError(t, err)
	require.Equal(t, 1, inUse(), "still running past its time")
	close(release)
	require.Eventually(t, func() bool { return inUse() == 0 }, time.Second, 5*time.Millisecond)
}

// A request lists the guards once, however many posts it publishes (bulk).
func TestRequestPublishGuardsListedOnce(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	server.pluginRegistry = pluginHookRegistry{"g": guarding(allowGuard)}
	store.EXPECT().ListHookPlugins(gomock.Any()).Times(1).Return([]db.ListHookPluginsRow{guardRow(1, "g", 0, "")}, nil)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/", nil)
	for i := 0; i < 3; i++ {
		guards, err := server.requestPublishGuards(c)
		require.NoError(t, err)
		require.Len(t, guards, 1)
	}
}

// Guards see a custom HTML block's markup, as the version will hold it (sanitized),
// though block_doc holds only its snippet id.
func TestGuardBodyMaterializesHTML(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	const snippet = "11111111-1111-4111-8111-111111111111"
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":["h"],"blocks":{"h":{"id":"h","type":"html","version":1,"attrs":{"snippetId":"` + snippet + `"}}}}`)
	store.EXPECT().ListPostHTMLSnippets(gomock.Any(), int64(5)).Return([]db.PostHtmlSnippet{
		{PostID: 5, SnippetID: snippet, Html: `<p onclick="x()">Hi <a href="https://example.test">there</a></p>`},
	}, nil)
	body, err := server.guardBody(context.Background(), 5, doc)
	require.NoError(t, err)
	require.Contains(t, string(body), "https://example.test")
	require.NotContains(t, string(body), "onclick")

	// No html block: nothing read, the body as it is.
	plain := json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)
	body, err = server.guardBody(context.Background(), 5, plain)
	require.NoError(t, err)
	require.Equal(t, string(plain), string(body))
}

func TestCleanGuardReason(t *testing.T) {
	require.Equal(t, "", cleanGuardReason("  \n\t "))
	require.Equal(t, "One line only.", cleanGuardReason("One\r\nline\x00only."))
	require.Equal(t, "bad", cleanGuardReason("bad\xff"))
	long := cleanGuardReason(strings.Repeat("é", pluginGuardReasonMax+20))
	require.Equal(t, pluginGuardReasonMax, len([]rune(long)))
	require.True(t, strings.HasSuffix(long, "…"))
}
