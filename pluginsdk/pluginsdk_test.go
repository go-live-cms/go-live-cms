package pluginsdk

import (
	"context"
	"go/build"
	"strings"
	"testing"
)

func noop(context.Context, Host, Event) error { return nil }

func mustPanic(t *testing.T, want string, f func()) {
	t.Helper()
	defer func() {
		rec := recover()
		if rec == nil {
			t.Fatalf("no panic, want one containing %q", want)
		}
		if msg := strings.TrimSpace(strings.ReplaceAll(toString(rec), "\n", " ")); !strings.Contains(msg, want) {
			t.Fatalf("panic %q, want one containing %q", msg, want)
		}
	}()
	f()
}

func toString(v any) string {
	if err, ok := v.(error); ok {
		return err.Error()
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func TestRegister(t *testing.T) {
	Register("sdk-test-ok", Plugin{Observers: map[string]Observer{EventPostPublished: noop, EventPostSaved: noop}})
	got, ok := Registered()["sdk-test-ok"]
	if !ok {
		t.Fatal("not registered")
	}
	if events := got.HookEvents(); strings.Join(events, ",") != "post.published,post.saved" {
		t.Fatalf("HookEvents = %v", events)
	}

	// Registered hands out a copy: changing it doesn't change the registry.
	copied := Registered()
	delete(copied, "sdk-test-ok")
	Registered()["sdk-test-ok"].Observers[EventPostDeleted] = noop
	if len(Registered()["sdk-test-ok"].Observers) != 2 {
		t.Fatal("Registered shares the registry's observers")
	}
	if _, ok := Registered()["sdk-test-ok"]; !ok {
		t.Fatal("Registered returned the registry itself")
	}

	mustPanic(t, "registered twice", func() { Register("sdk-test-ok", Plugin{}) })
	mustPanic(t, "not a plugin id", func() { Register("Bad Slug", Plugin{}) })
	mustPanic(t, "not an observer event", func() {
		Register("sdk-test-guard", Plugin{Observers: map[string]Observer{"post.before_publish": noop}})
	})
	mustPanic(t, "not an observer event", func() {
		Register("sdk-test-unknown", Plugin{Observers: map[string]Observer{"post.viewed": noop}})
	})
	mustPanic(t, "observer is nil", func() {
		Register("sdk-test-nil", Plugin{Observers: map[string]Observer{EventPostDeleted: nil}})
	})
	if _, ok := Registered()["sdk-test-nil"]; ok {
		t.Fatal("a refused plugin was registered")
	}
}

// A guard is BeforePublish: it counts among HookEvents (plugin.json must declare it)
// but not among the observed events, and it can't be registered as an observer.
func TestRegisterGuard(t *testing.T) {
	guard := func(context.Context, Host, PublishCandidate) (Decision, error) { return Deny("no"), nil }
	Register("sdk-test-guarded", Plugin{BeforePublish: guard, Observers: map[string]Observer{EventPostSaved: noop}})
	got := Registered()["sdk-test-guarded"]
	if events := strings.Join(got.HookEvents(), ","); events != "post.before_publish,post.saved" {
		t.Fatalf("HookEvents = %v", events)
	}
	if events := strings.Join(got.ObserverEvents(), ","); events != "post.saved" {
		t.Fatalf("ObserverEvents = %v", events)
	}
	if got.BeforePublish == nil {
		t.Fatal("the guard was not registered")
	}
	decision, err := got.BeforePublish(context.Background(), nil, PublishCandidate{})
	if err != nil || !decision.Deny || decision.Reason != "no" {
		t.Fatalf("guard = %+v, %v", decision, err)
	}

	Register("sdk-test-guard-only", Plugin{BeforePublish: guard})
	if events := Registered()["sdk-test-guard-only"].HookEvents(); strings.Join(events, ",") != EventBeforePublish {
		t.Fatalf("HookEvents = %v", events)
	}
	mustPanic(t, "set Plugin.BeforePublish", func() {
		Register("sdk-test-guard-observer", Plugin{Observers: map[string]Observer{EventBeforePublish: noop}})
	})

	if d := Allow(); d.Deny || d.Reason != "" {
		t.Fatalf("Allow() = %+v", d)
	}
	if d := (Decision{}); d.Deny {
		t.Fatal("the zero Decision must allow")
	}
}

// The registry keeps its own copy of the observers map.
func TestRegisterCopiesObservers(t *testing.T) {
	observers := map[string]Observer{EventPostTrashed: noop}
	Register("sdk-test-copy", Plugin{Observers: observers})
	observers[EventPostRestored] = noop
	if events := Registered()["sdk-test-copy"].HookEvents(); len(events) != 1 {
		t.Fatalf("HookEvents = %v, want only post.trashed", events)
	}
}

// pluginsdk is the plugins' only dependency on GoLive: it imports nothing from api/ or
// db/ (or any other package of this module).
func TestImportsNothingFromGoLive(t *testing.T) {
	pkg, err := build.ImportDir(".", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range pkg.Imports {
		if strings.HasPrefix(path, "github.com/go-live-cms/") {
			t.Fatalf("pluginsdk imports %s", path)
		}
		if strings.Contains(path, ".") {
			t.Fatalf("pluginsdk imports %s; only the standard library is allowed", path)
		}
	}
}
