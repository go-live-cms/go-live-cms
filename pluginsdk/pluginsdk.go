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
// A plugin may also guard publishing (#459): Plugin.BeforePublish, declared in
// plugin.json as {"event": "post.before_publish", "on_error": "allow" | "deny"}, is
// asked before every publish and may refuse it with a reason (see Guard).
//
//	pluginsdk.Register("alt-text-check", pluginsdk.Plugin{
//		BeforePublish: func(ctx context.Context, host pluginsdk.Host, c pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
//			if missingAlt(c.BlockDoc) {
//				return pluginsdk.Deny("Add alt text to every image."), nil
//			}
//			return pluginsdk.Allow(), nil
//		},
//	})
//
// A plugin may also check reader comments (#530, docs/design/reader-comments.md 14.2):
// Plugin.BeforeCommentCreate, declared as {"event": "comment.before_create", "on_error":
// "allow" | "hold"} with the comments:private capability, is asked about every reader
// comment before it is stored and may hold it for a moderator or mark it as spam (see
// CommentGuard). It can't approve one: moderation stays core's.
//
// Observers observe; they can't change anything on the way through. An observer runs after
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

// The reader comment events (#530, docs/design/reader-comments.md 14.1). Event.PostID is
// the comment's post, so a thread's events arrive in order. Data holds ids and small
// facts only, never a name, text or address: "comment_id"; "root_id" (absent on a
// top-level comment); "status", the comment's status after the change (pending,
// approved, spam or trash; on comment.deleted the one it had); "previous_status" (absent
// on a new comment and on comment.deleted); and "by_member", true for a staff member's
// comment. ActorID is the member who wrote it on comment.created, and the moderator on a
// change a moderator made. A plugin that wants the text declares comments:read and reads
// it with Host.Comments.
const (
	// EventCommentCreated: a comment exists for the site: a reader's comment was
	// confirmed (or stored at once, from a browser that holds the address's key, or as
	// spam), or a member's comment was written. Status says where it went. An unconfirmed
	// comment is not created yet.
	EventCommentCreated = "comment.created"
	// EventCommentApproved: a comment became approved, by a moderator or by core's rules
	// (then it follows comment.created). ActorID is the moderator, when one did it.
	EventCommentApproved = "comment.approved"
	// EventCommentUnapproved: an approved comment went back to pending.
	EventCommentUnapproved = "comment.unapproved"
	// EventCommentSpammed: a comment was marked as spam (by a moderator, or by core's
	// rules or a guard, then after comment.created).
	EventCommentSpammed = "comment.spammed"
	// EventCommentTrashed: a comment was moved to the trash.
	EventCommentTrashed = "comment.trashed"
	// EventCommentDeleted: a comment was deleted, or removed and kept as a placeholder
	// because approved replies answer it. Its text is gone when the hook runs. Not sent
	// for the comments of a post deleted for good: its post.deleted stands for them.
	EventCommentDeleted = "comment.deleted"
)

// ObserverEvents lists the events an observer may subscribe to.
var ObserverEvents = []string{
	EventPostSaved, EventPostPublished, EventPostUnpublished,
	EventPostTrashed, EventPostRestored, EventPostDeleted,
	EventCommentCreated, EventCommentApproved, EventCommentUnapproved,
	EventCommentSpammed, EventCommentTrashed, EventCommentDeleted,
}

// EventCommentBeforeCreate is the comment guard's name in plugin.json's server.hooks
// (#530). Like EventBeforePublish it is not an event: a guard is
// Plugin.BeforeCommentCreate, called before a reader's comment is stored.
const EventCommentBeforeCreate = "comment.before_create"

// EventBeforePublish is the publish guard's name in plugin.json's server.hooks
// (section 7.7). It is not an event: a guard is Plugin.BeforePublish, called before a
// publish, and it may refuse it.
const EventBeforePublish = "post.before_publish"

// The ways a post gets published: PublishCandidate.Via.
const (
	// PublishViaButton: the editor's Publish or Update, or a bulk publish.
	PublishViaButton = "publish"
	// PublishViaSchedule: the scheduler publishing a scheduled post.
	PublishViaSchedule = "schedule"
	// PublishViaScheduledUpdate: the scheduler applying a published post's scheduled
	// update (its body frozen when it was scheduled).
	PublishViaScheduledUpdate = "scheduled_update"
	// PublishViaStatus: post_status set to published through POST or PUT /posts. That
	// makes no new version: the body that goes live is the post's current published
	// body (empty when it has none).
	PublishViaStatus = "status"
	// PublishViaImport: the importer (#150) publishing a post that was published in the
	// export it reads. A refusal imports the post as a draft.
	PublishViaImport = "import"
)

// PublishCandidate is a publish a guard is asked about.
type PublishCandidate struct {
	// PostID is the post; 0 for a post that POST /posts is creating as published.
	PostID int64
	// PostType is the post's type ("post", "page", ...).
	PostType string
	// ActorID is the member publishing (for the scheduler, who scheduled it); 0 when
	// none is known.
	ActorID int64
	// Via is one of the PublishVia* constants.
	Via string
	// BlockDoc is the body that goes live, as Block Spec v1 JSON. It is the guard's own
	// copy: changing it changes nothing.
	BlockDoc json.RawMessage
}

// Decision is a guard's answer. The zero value allows the publish.
type Decision struct {
	// Deny refuses the publish.
	Deny bool
	// Reason is shown to whoever published, as plain text: one short sentence that
	// says what to fix ("Add alt text to every image."). Longer reasons are cut, and
	// line breaks and control characters become spaces.
	Reason string
}

// Allow lets the publish go ahead.
func Allow() Decision { return Decision{} }

// Deny refuses the publish with a short plain-text reason.
func Deny(reason string) Decision { return Decision{Deny: true, Reason: reason} }

// Guard decides whether a publish may go ahead. It runs before the publish's
// transaction, on every path that publishes, in the request (or the scheduler's
// attempt) that publishes: keep it fast. Guards run one after another, ordered by
// plugin.json's priority (lowest first) and then the plugin id; the first denial
// wins and the rest don't run. A guard gets 3 seconds, and all of them together 5.
// An error, a panic or running past its time allows the publish (and is logged)
// unless plugin.json declares "on_error": "deny" for it.
//
// A guard is a policy check, not a lock: an edit stored between the guard and the
// publish is published unchecked. It can't change the content (no mutating filters).
type Guard func(ctx context.Context, host Host, candidate PublishCandidate) (Decision, error)

// CommentCandidate is a reader's comment a comment guard is asked about, as the request
// carried it. It holds personal data (the address, the network address, the user agent):
// a guard may send it to the service it uses, which is why declaring the guard needs
// comments:private, but never logs or stores it. The IP address exists only here: core
// never stores it.
type CommentCandidate struct {
	// PostID is the post the comment is on.
	PostID int64
	// ParentID is the comment it answers; 0 for a top-level comment.
	ParentID int64
	// Name and Email are what the reader typed; Body the text, as stored (normalized).
	Name  string
	Email string
	Body  string
	// IP is the reader's address, and UserAgent their browser's, as the request gave them.
	IP        string
	UserAgent string
	// HasBrowserKey: the browser holds the address's key (it confirmed a comment before),
	// so the comment is published or held at once instead of waiting for a confirmation.
	HasBrowserKey bool
}

// CommentVerdict is what a comment guard says: allow, hold or spam. There is no approve:
// moderation stays core's, and any other value counts as allow.
type CommentVerdict string

const (
	// CommentAllow leaves the comment to core's rules.
	CommentAllow CommentVerdict = "allow"
	// CommentHold puts it in the moderation queue, with the guard's reason.
	CommentHold CommentVerdict = "hold"
	// CommentSpam sends it to spam, silently: the reader is answered as for a held one
	// and nothing is mailed.
	CommentSpam CommentVerdict = "spam"
)

// CommentDecision is a comment guard's answer. The zero value allows the comment.
type CommentDecision struct {
	Verdict CommentVerdict
	// Reason is shown to moderators beside the held comment, as one line of plain text
	// ("Looks automated (score 0.91)."). Longer reasons are cut at 200 characters.
	Reason string
}

// AllowComment leaves the comment to core's rules.
func AllowComment() CommentDecision { return CommentDecision{Verdict: CommentAllow} }

// HoldComment holds the comment for a moderator, with a short plain-text reason.
func HoldComment(reason string) CommentDecision {
	return CommentDecision{Verdict: CommentHold, Reason: reason}
}

// SpamComment sends the comment to spam, with a short plain-text reason.
func SpamComment(reason string) CommentDecision {
	return CommentDecision{Verdict: CommentSpam, Reason: reason}
}

// CommentGuard checks a reader's comment before it is stored (#530). It runs on the
// comment's write path, after core's own checks: keep it fast. Guards run one after
// another in plugin.json's priority order (lowest first, then the plugin id); the first
// spam wins and stops the rest, a hold is kept while the others still run. A guard gets
// 2 seconds, and all of them together 3. An error, a panic or running past its time
// allows the comment (and is logged) unless plugin.json declares "on_error": "hold".
//
// The verdict is stored with the comment, so confirming it later applies it without
// asking again.
type CommentGuard func(ctx context.Context, host Host, candidate CommentCandidate) (CommentDecision, error)

// Capabilities a plugin.json may declare (section 2). Host hands out an accessor only
// when its capability is declared.
const (
	CapabilityPostsRead = "posts:read"
	CapabilityMediaRead = "media:read"
	CapabilityUsersRead = "users:read"
	CapabilityNetwork   = "network"
	// CapabilityCommentsRead gives Host.Comments: a comment's name, text, status and
	// post. Never the commenter's address.
	CapabilityCommentsRead = "comments:read"
	// CapabilityCommentsPrivate is required to declare the comment guard, which receives
	// commenters' email and IP address (CommentCandidate).
	CapabilityCommentsPrivate = "comments:private"
)

// Event is one change to a post or a reader comment, as an observer receives it.
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
	// Data holds ids and small facts, never content. A post event has "post_type" and
	// "post_status" (the status after the change, or before a delete), "from_status" on
	// a status change, and "version_id" on post.published. A comment event's are listed
	// with EventCommentCreated.
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
	// Comments is nil unless plugin.json declares comments:read.
	Comments() CommentReader
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

// CommentReader reads reader comments (comments:read). Read-only, and never the
// commenter's address: observers can't read addresses at all.
type CommentReader interface {
	// Get is the comment as moderators see it. ErrNotFound for an id that doesn't exist,
	// or a comment still waiting for its confirmation (it isn't created yet).
	Get(ctx context.Context, id int64) (Comment, error)
}

// Comment is a reader comment as a hook sees it.
type Comment struct {
	ID     int64
	PostID int64
	// ParentID is the comment it answers and RootID its thread's top-level comment; 0
	// for a top-level comment (and ParentID 0 when the comment it answered is gone).
	ParentID int64
	RootID   int64
	// Name is the name as posted and Body the plain text. Both are empty on a removed
	// comment.
	Name string
	Body string
	// Status is pending, approved, spam or trash.
	Status string
	// MemberID is the member who wrote it, for a staff comment; 0 for a reader's.
	MemberID int64
	// Removed: deleted and kept as a placeholder because approved replies answer it.
	Removed   bool
	CreatedAt time.Time
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
	// BeforePublish is the plugin's publish guard, or nil. plugin.json must declare it
	// as {"event": "post.before_publish"}, and a declared guard must be set here.
	BeforePublish Guard
	// BeforeCommentCreate is the plugin's comment guard, or nil. plugin.json must
	// declare it as {"event": "comment.before_create"} (with the comments:private
	// capability), and a declared guard must be set here.
	BeforeCommentCreate CommentGuard
}

// HookEvents lists the events p has a hook for, sorted, the guards
// (EventBeforePublish, EventCommentBeforeCreate) included: what plugin.json's
// server.hooks must declare.
func (p Plugin) HookEvents() []string {
	events := p.ObserverEvents()
	if p.BeforePublish != nil {
		events = append(events, EventBeforePublish)
	}
	if p.BeforeCommentCreate != nil {
		events = append(events, EventCommentBeforeCreate)
	}
	sort.Strings(events)
	return events
}

// ObserverEvents lists the events p observes, sorted: HookEvents without the guards.
func (p Plugin) ObserverEvents() []string {
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
		if !known && event == EventBeforePublish {
			return fmt.Errorf("pluginsdk: plugin %q: %q is not an observer event; set Plugin.BeforePublish", slug, event)
		}
		if !known && event == EventCommentBeforeCreate {
			return fmt.Errorf("pluginsdk: plugin %q: %q is not an observer event; set Plugin.BeforeCommentCreate", slug, event)
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

// Registered returns a copy of every registered plugin by slug, observers included. The API reads it once
// at startup.
func Registered() map[string]Plugin {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make(map[string]Plugin, len(registry))
	for slug, p := range registry {
		observers := make(map[string]Observer, len(p.Observers))
		for event, observer := range p.Observers {
			observers[event] = observer
		}
		p.Observers = observers
		out[slug] = p
	}
	return out
}
