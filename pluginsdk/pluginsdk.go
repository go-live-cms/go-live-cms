// Package pluginsdk is the contract between GoLive and a plugin's server code (#458,
// docs/design/plugin-system.md section 7.8).
//
// A plugin with server hooks has a Go package at web/plugins/<slug>/server that calls
// Register from init(). cmd/gen-plugins links every such package into the API with a
// blank import in api/plugins_gen.go, so installing a plugin's hooks means building it
// into the image, like the rest of the plugin.
//
//	package server
//
//	import "github.com/go-live-cms/go-live-cms/pluginsdk"
//
//	func init() {
//		pluginsdk.Register("reading-time", pluginsdk.Plugin{
//			Observers: map[string]pluginsdk.Observer{
//				pluginsdk.EventPostPublished: onPublished,
//			},
//		})
//	}
//
// The hooks a plugin registers must be exactly the ones its plugin.json declares under
// server.hooks; a plugin whose two lists differ is listed as incompatible and its hooks
// don't run.
//
// Hooks observe; they can't change anything on the way through. An observer runs after
// the change it describes has committed, outside any transaction, as the system rather
// than as the member who caused it. It can't fail, slow or roll back that change: an
// error, a panic or a timeout is retried with backoff (at most 8 attempts), and a
// plugin's hooks run at most two at a time. Delivery is at least once, so Event.ID is
// the idempotency key. Within one plugin a post's events arrive in order.
//
// There is no write access to posts on purpose: only the collab server writes a post's
// block_doc (web/gl-admin/lib/collaboration/CLAUDE.md, rule 11). A plugin that needs a
// derived value stores it somewhere of its own.
//
// This package imports nothing from GoLive's api or db packages, so a plugin depends on
// the contract only. New capabilities are added as new fields of Plugin and new
// methods on Host's accessors.
package pluginsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"sync"
	"time"
)

// The events an observer may subscribe to (section 7.2). The names are the ones
// plugin.json's server.hooks[].event uses.
const (
	// EventPostSaved: a post was created or saved (a body store from the editor, or a
	// settings save). Saves are coalesced, so a hook may see one for several; read the
	// post when it runs.
	EventPostSaved = "post.saved"
	// EventPostPublished: a post was published, or a published post updated. ActorID
	// is the member the new version is credited to (0 for a status set through the
	// API). Data["version_id"] is the published version.
	EventPostPublished = "post.published"
	// EventPostUnpublished: a published post went back to draft (or another status
	// that isn't the trash).
	EventPostUnpublished = "post.unpublished"
	// EventPostTrashed: a post was moved to the trash.
	EventPostTrashed = "post.trashed"
	// EventPostRestored: a post was taken out of the trash.
	EventPostRestored = "post.restored"
	// EventPostDeleted: a post was deleted permanently. The post is gone when the hook
	// runs; Data["post_type"] says what it was.
	EventPostDeleted = "post.deleted"
)

// ObserverEvents lists the events an observer may subscribe to.
var ObserverEvents = []string{
	EventPostSaved, EventPostPublished, EventPostUnpublished,
	EventPostTrashed, EventPostRestored, EventPostDeleted,
}

// Capabilities a plugin.json may declare (section 2). Host hands out an accessor only
// when its capability is declared.
const (
	CapabilityPostsRead = "posts:read"
	CapabilityMediaRead = "media:read"
	CapabilityUsersRead = "users:read"
	CapabilityNetwork   = "network"
)

// Event is one change to a post, as an observer receives it.
type Event struct {
	// ID is unique per event and stable across retries: the idempotency key.
	ID int64
	// PostID is the post the event is about.
	PostID int64
	// ActorID is the member the change is credited to, when the event names one (see
	// the event's constant); 0 otherwise. The hook itself runs as the system.
	ActorID int64
	// Name is one of the Event* constants.
	Name string
	// Data holds ids and small facts: always "post_type" and "post_status" (the status
	// after the change, or before a delete), "from_status" on a status change, and
	// "version_id" on post.published. Never content.
	Data map[string]any
	// OccurredAt is when the change was made (its transaction's time).
	OccurredAt time.Time
}

// Host is what a hook may use. Accessors for undeclared capabilities are nil.
type Host interface {
	// Settings are the plugin's settings: plugin.json's defaults overlaid with what an
	// admin saved.
	Settings(ctx context.Context) (map[string]any, error)
	// Posts is nil unless plugin.json declares posts:read.
	Posts() PostReader
	// Media is nil unless plugin.json declares media:read.
	Media() MediaReader
	// Users is nil unless plugin.json declares users:read.
	Users() UserReader
	// Log is the API's logger, with the plugin and event attached. The API's rules
	// apply: no secrets, and ids rather than names or content.
	Log() *slog.Logger
}

// ErrNotFound is what a reader returns for an id that doesn't exist (or no longer
// does).
var ErrNotFound = errors.New("pluginsdk: not found")

// PostReader reads posts. Read-only: see the package documentation.
type PostReader interface {
	// Get is the post's working copy: what editors see now.
	Get(ctx context.Context, id int64) (Post, error)
	// GetPublished is what the site shows: the published snapshot of the body and
	// settings. ErrNotFound when the post isn't published.
	GetPublished(ctx context.Context, id int64) (Post, error)
}

// Post is a post as a hook sees it.
type Post struct {
	ID        int64
	Type      string
	Status    string
	Slug      string
	URL       string
	Title     string
	Excerpt   string
	OwnerID   int64
	CreatedAt time.Time
	ChangedAt time.Time
	// BlockDoc is the body as Block Spec v1 JSON (the working copy, or the published
	// snapshot for GetPublished).
	BlockDoc json.RawMessage
	// PublishedVersionID is the live version's id; 0 when unpublished.
	PublishedVersionID int64
}

// MediaReader reads media library items.
type MediaReader interface {
	Get(ctx context.Context, id int64) (Media, error)
}

// Media is a media library item.
type Media struct {
	ID          int64
	Name        string
	Alt         string
	Description string
	MimeType    string
	// URL is the file's path under the site (/uploads/media/...).
	URL       string
	Width     int
	Height    int
	FileSize  int64
	CreatedAt time.Time
}

// UserReader reads members. Only public fields: never an email or a password.
type UserReader interface {
	Get(ctx context.Context, id int64) (User, error)
}

// User is a member's public fields.
type User struct {
	ID       int64
	Username string
	Name     string
	Role     string
}

// Observer handles one event. A non-nil error (or a panic, or running past the hook's
// timeout_ms) is a failed attempt, retried later. ctx carries the timeout.
type Observer func(ctx context.Context, host Host, event Event) error

// Plugin is what a plugin registers.
type Plugin struct {
	// Observers maps an event name (an Event* constant) to its hook. Each must be
	// declared in plugin.json's server.hooks, and each declared observer event must be
	// here.
	Observers map[string]Observer
}

// HookEvents lists the events p has a hook for, sorted: what plugin.json's
// server.hooks must declare.
func (p Plugin) HookEvents() []string {
	events := make([]string, 0, len(p.Observers))
	for event := range p.Observers {
		events = append(events, event)
	}
	sort.Strings(events)
	return events
}

var slugRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

var (
	registryMu sync.RWMutex
	registry   = map[string]Plugin{}
)

// Register makes a plugin's server code known, under its plugin.json id. Call it from
// init(). It panics on an invalid or already registered slug, an unknown event or a
// nil observer: mistakes a build should not get past.
func Register(slug string, p Plugin) {
	if err := validate(slug, p); err != nil {
		panic(err)
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, taken := registry[slug]; taken {
		panic(fmt.Sprintf("pluginsdk: plugin %q registered twice", slug))
	}
	observers := make(map[string]Observer, len(p.Observers))
	for event, observer := range p.Observers {
		observers[event] = observer
	}
	p.Observers = observers
	registry[slug] = p
}

func validate(slug string, p Plugin) error {
	if !slugRe.MatchString(slug) {
		return fmt.Errorf("pluginsdk: %q is not a plugin id", slug)
	}
	for event, observer := range p.Observers {
		known := false
		for _, name := range ObserverEvents {
			known = known || name == event
		}
		if !known {
			return fmt.Errorf("pluginsdk: plugin %q: %q is not an observer event", slug, event)
		}
		if observer == nil {
			return fmt.Errorf("pluginsdk: plugin %q: the %s observer is nil", slug, event)
		}
	}
	return nil
}

// Registered returns a copy of every registered plugin by slug. The API reads it once
// at startup.
func Registered() map[string]Plugin {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make(map[string]Plugin, len(registry))
	for slug, p := range registry {
		out[slug] = p
	}
	return out
}
