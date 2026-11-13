package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/cache"
	"golang.org/x/sync/singleflight"
)

// Public read cache (#185): cache-aside for the reads the public site makes on every
// page, in Valkey (cache/), purged after every write that changes public output.
//
//   - What is cached: the whole response (status, Content-Type, body) of the GET routes in
//     publicCacheRoutes, anonymous requests only. Every one of them answers published
//     content or site config only (#393), the same for every caller, so a request carrying
//     an Authorization header is never served from or stored in the cache (an admin always
//     reads Postgres). Never: drafts and previews (no /public route serves one), the
//     admin's /api/v1/posts* (sign-in required), search (/public/search: any text, one key
//     per query) and redirect lookups.
//   - The key is the method, the escaped path and the canonical query string (sorted
//     keys), so it carries everything the response can depend on: type, id or slug, page,
//     term, location, limit. No public handler reads a header, a cookie or the clock
//     (checked when this was written; a new one that does must not be listed here).
//   - Invalidation is one namespace ("public", cache.Namespace): every key carries the
//     current generation, and a purge moves to a new one. One purge clears every public
//     response at once, because they reference each other: a post's title is in menus,
//     archives, term and author pages, related and adjacent posts, the front page; a
//     member's name in bylines and mentions; an image's alt text in every block that shows
//     it. Content writes are rare next to page views, so an exact dependency graph isn't
//     worth its bugs.
//   - Purges run after the write committed: purgePublicCacheAfterWrite (every mutating
//     /api/v1 route in publicCachePurgeRoutes, after its handler) and the scheduler
//     (scheduled_publish.go). TestMutatingRoutesDeclarePublicCachePurge makes
//     every new mutating route pick a side. A purge failure is logged and never fails the
//     write; entries then live out publicCacheTTL at most.
//   - Valkey down or slow (cache/'s timeouts): the read goes to Postgres (BYPASS), reads
//     then skip Valkey for publicCacheRetryAfter, and errors are logged at most once per
//     publicCacheErrorLogInterval. A failed purge does the same, and the first read once
//     Valkey answers again purges before using anything stored, so a purge missed during
//     an outage this process saw can't leave stale pages behind. (Another replica that
//     never lost Valkey keeps serving until the TTL; that's the bound.)
//   - Concurrent misses for one key share one handler run (singleflight), so an expired
//     front page doesn't send every waiting request to Postgres at once.

// publicCacheTTL bounds how long an entry lives even if a purge is missed.
const publicCacheTTL = 5 * time.Minute

// publicCacheMaxBody: larger responses (a very long post's blocks) aren't stored.
const publicCacheMaxBody = 2 << 20

// publicCachePurgeTimeout bounds a purge; it must not hold up the write's response.
const publicCachePurgeTimeout = time.Second

// publicCacheErrorLogInterval: one warning per interval while Valkey is failing.
const publicCacheErrorLogInterval = time.Minute

// publicCacheHeader says how a cacheable response was answered: HIT, MISS or BYPASS
// (the cache failed). Only the web server sees it (SSR); it's for debugging.
const publicCacheHeader = "X-Cache"

// publicCacheRoute is how one route is cached.
type publicCacheRoute struct {
	// notFound also caches a 404: routes where "nothing here" is the normal answer
	// for a whole site (no front page, no footer menu), asked on every page view.
	notFound bool
}

// publicCacheRoutes are the GET routes whose anonymous responses are cached, by route
// template. Each must be a public route (/public/*, or listed in publicGETRoutes).
var publicCacheRoutes = map[string]publicCacheRoute{
	// The post page, lists, feeds and the sitemap (#349, #351, #358).
	"/public/posts":              {},
	"/public/posts/slug/:slug":   {},
	"/public/posts/:id":          {},
	"/public/posts/:id/blocks":   {},
	"/public/posts/:id/adjacent": {},
	"/public/posts/:id/related":  {},
	"/public/posts/type/:type":   {},
	"/public/posts/:id/authors":  {},
	"/public/front-page":         {notFound: true},
	// Author and term pages (#350, #348).
	"/public/authors":                                {},
	"/public/authors/:username":                      {},
	"/public/authors/:username/posts":                {},
	"/public/taxonomies/:taxonomy/terms/:slug/posts": {},
	"/public/terms":                                  {},
	// Menus (#347): a location with no menu is a 404 on every page.
	"/public/menus/:location": {notFound: true},
	// Site config the public site reads on every request.
	"/api/v1/settings":                   {},
	"/api/v1/themes/active":              {},
	"/api/v1/extension-settings":         {},
	"/api/v1/post-types":                 {},
	"/api/v1/taxonomy/types":             {},
	"/api/v1/taxonomy/types/:name/terms": {},
}

// publicCache is the server's public read cache. A nil *publicCache or a disabled
// cache (no REDIS_URL) makes every method a no-op.
type publicCache struct {
	cache  cache.Cache
	ns     *cache.Namespace
	ttl    time.Duration
	flight singleflight.Group
	logger *slog.Logger
	// lastErrorLog is the unix nano time of the last logged cache error.
	lastErrorLog atomic.Int64

	// After a failure, reads skip Valkey for retryAfter (an unreachable host would
	// otherwise cost every page view a dial timeout); skipUntil is that time in unix
	// nanos. unhealthy stays set until a purge succeeds: a purge may have been missed
	// while Valkey was out of reach, so the first read after it purges before trusting
	// anything stored.
	retryAfter time.Duration
	skipUntil  atomic.Int64
	unhealthy  atomic.Bool
	// recovering: one request runs the recovery purge; the others bypass meanwhile
	// instead of each writing its own generation.
	recovering atomic.Bool
}

// publicCacheNamespace prefixes every public cache key in Valkey.
const publicCacheNamespace = "public"

// publicCacheRetryAfter is how long reads skip Valkey after it failed.
const publicCacheRetryAfter = 5 * time.Second

func newPublicCache(c cache.Cache, logger *slog.Logger) *publicCache {
	return &publicCache{
		cache:      c,
		ns:         cache.NewNamespace(c, publicCacheNamespace),
		ttl:        publicCacheTTL,
		logger:     logger,
		retryAfter: publicCacheRetryAfter,
	}
}

// failed records a cache failure: reads skip Valkey for a while, the next read after
// that purges first, and the error is logged (throttled) on log, the request's logger.
func (pc *publicCache) failed(log *slog.Logger, msg string, err error) {
	pc.unhealthy.Store(true)
	pc.skipUntil.Store(time.Now().Add(pc.retryAfter).UnixNano())
	pc.logError(log, msg, err)
}

// usable reports whether reads may use Valkey now. After a failure: not until
// retryAfter has passed, and then only once a purge has gone through. One request
// runs that purge; the others read the database until it's done.
func (pc *publicCache) usable(ctx context.Context, log *slog.Logger) bool {
	if time.Now().UnixNano() < pc.skipUntil.Load() {
		return false
	}
	if !pc.unhealthy.Load() {
		return true
	}
	if !pc.recovering.CompareAndSwap(false, true) {
		return false
	}
	defer pc.recovering.Store(false)
	if !pc.unhealthy.Load() { // another request recovered it meanwhile
		return true
	}
	if err := pc.ns.Purge(ctx); err != nil {
		pc.failed(log, "public cache still unavailable; reading the database", err)
		return false
	}
	pc.unhealthy.Store(false)
	log.Info("public cache available again; purged in case a purge was missed")
	return true
}

// PurgePublicCache purges every cached public response in c, for commands that change
// public output outside a running server (main.go's backfill-variants).
func PurgePublicCache(ctx context.Context, c cache.Cache) error {
	if !c.Enabled() {
		return nil
	}
	return cache.NewNamespace(c, publicCacheNamespace).Purge(ctx)
}

func (pc *publicCache) enabled() bool {
	return pc != nil && pc.cache != nil && pc.cache.Enabled()
}

// SetCache replaces the server's cache client (tests; main.go builds it from REDIS_URL
// in NewServer).
func (server *Server) SetCache(c cache.Cache) {
	server.publicCache = newPublicCache(c, server.logger)
}

// Cache is the server's cache client, for main.go to close on shutdown.
func (server *Server) Cache() cache.Cache {
	if server.publicCache == nil {
		return cache.Noop{}
	}
	return server.publicCache.cache
}

// logError logs a cache failure, at most once per publicCacheErrorLogInterval.
func (pc *publicCache) logError(log *slog.Logger, msg string, err error, attrs ...any) {
	now := time.Now().UnixNano()
	last := pc.lastErrorLog.Load()
	if now-last < int64(publicCacheErrorLogInterval) || !pc.lastErrorLog.CompareAndSwap(last, now) {
		return
	}
	log.Warn(msg, append(attrs, "error", err)...)
}

// publicCacheKeySuffix is the part of the key that identifies the request: method,
// escaped path and the canonical query (url.Values.Encode sorts by key). Long ones are
// hashed so a junk query can't make huge keys.
func publicCacheKeySuffix(r *http.Request) string {
	suffix := r.Method + " " + r.URL.EscapedPath()
	if query := r.URL.Query().Encode(); query != "" {
		suffix += "?" + query
	}
	if len(suffix) > 512 {
		sum := sha256.Sum256([]byte(suffix))
		return "h:" + hex.EncodeToString(sum[:])
	}
	return suffix
}

// cachePublicResponses serves the routes in publicCacheRoutes from the cache and stores
// their cacheable answers (cache-aside). Installed on the /public and /api/v1 groups; any
// other route passes straight through.
func (server *Server) cachePublicResponses() gin.HandlerFunc {
	return func(c *gin.Context) {
		pc := server.publicCache
		route, listed := publicCacheRoutes[c.FullPath()]
		if !listed || !pc.enabled() || c.Request.Method != http.MethodGet || c.GetHeader("Authorization") != "" {
			c.Next()
			return
		}
		ctx := c.Request.Context()
		log := server.requestLog(c)
		if !pc.usable(ctx, log) {
			c.Header(publicCacheHeader, "BYPASS")
			c.Next()
			return
		}
		// The generation first, then Postgres: see cache.Namespace.
		key, err := pc.ns.Key(ctx, publicCacheKeySuffix(c.Request))
		if err != nil {
			pc.failed(log, "public cache unavailable; reading the database", err)
			c.Header(publicCacheHeader, "BYPASS")
			c.Next()
			return
		}
		if stored, err := pc.cache.Get(ctx, key); err == nil {
			if entry, ok := decodePublicCacheEntry(stored); ok {
				entry.write(c, "HIT")
				c.Abort()
				return
			}
		} else if !errors.Is(err, cache.ErrMiss) {
			pc.failed(log, "public cache read failed; reading the database", err)
		}

		leader := false
		shared, _, _ := pc.flight.Do(key, func() (any, error) {
			leader = true
			c.Header(publicCacheHeader, "MISS")
			recorder := &publicCacheRecorder{ResponseWriter: c.Writer}
			c.Writer = recorder
			c.Next()
			c.Writer = recorder.ResponseWriter
			entry, ok := recorder.entry(route)
			if !ok {
				return nil, nil
			}
			// Stored with the request's context gone or not: the response is already out.
			storeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), publicCachePurgeTimeout)
			defer cancel()
			if err := pc.cache.Set(storeCtx, key, entry.encode(), pc.ttl); err != nil {
				pc.failed(log, "public cache write failed", err)
			}
			return entry, nil
		})
		if leader {
			return
		}
		// Waited on another request's run: replay its answer if it was cacheable,
		// else (an error, a 404 that isn't cached) run the handler ourselves.
		if entry, ok := shared.(*publicCacheEntry); ok && entry != nil {
			entry.write(c, "HIT")
			c.Abort()
			return
		}
		c.Next()
	}
}

// publicCacheEntry is a stored response.
type publicCacheEntry struct {
	status      int
	contentType string
	body        []byte
}

// encode frames the entry as "<status>\n<content type>\n<body>".
func (e *publicCacheEntry) encode() []byte {
	out := make([]byte, 0, len(e.body)+64)
	out = strconv.AppendInt(out, int64(e.status), 10)
	out = append(out, '\n')
	out = append(out, e.contentType...)
	out = append(out, '\n')
	return append(out, e.body...)
}

func decodePublicCacheEntry(b []byte) (*publicCacheEntry, bool) {
	statusText, rest, ok := bytes.Cut(b, []byte{'\n'})
	if !ok {
		return nil, false
	}
	contentType, body, ok := bytes.Cut(rest, []byte{'\n'})
	if !ok {
		return nil, false
	}
	status, err := strconv.Atoi(string(statusText))
	if err != nil || status < 200 || status > 599 {
		return nil, false
	}
	return &publicCacheEntry{status: status, contentType: string(contentType), body: body}, true
}

// write answers the request with the entry. A 404's body goes through the request id
// writer like a handler's, so it carries this request's id, not the one that stored it.
func (e *publicCacheEntry) write(c *gin.Context, result string) {
	c.Header(publicCacheHeader, result)
	if e.contentType != "" {
		c.Header("Content-Type", e.contentType)
	}
	c.Status(e.status)
	_, _ = c.Writer.Write(e.body)
}

// publicCacheRecorder keeps a copy of what the handler writes. It sits inside the
// request id writer, so it sees the body before a request id is added to an error.
type publicCacheRecorder struct {
	gin.ResponseWriter
	body     bytes.Buffer
	tooLarge bool
}

func (w *publicCacheRecorder) Write(b []byte) (int, error) {
	if !w.tooLarge {
		if w.body.Len()+len(b) > publicCacheMaxBody {
			w.tooLarge = true
			w.body.Reset()
		} else {
			w.body.Write(b)
		}
	}
	return w.ResponseWriter.Write(b)
}

func (w *publicCacheRecorder) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

// entry returns what to store, if the response may be: a 200 (or a 404 where the route
// allows it), not too large, no cookie set and not marked no-store by the handler.
func (w *publicCacheRecorder) entry(route publicCacheRoute) (*publicCacheEntry, bool) {
	status := w.Status()
	if status != http.StatusOK && (status != http.StatusNotFound || !route.notFound) {
		return nil, false
	}
	header := w.Header()
	if w.tooLarge || header.Get("Set-Cookie") != "" || header.Get("Cache-Control") == "no-store" {
		return nil, false
	}
	return &publicCacheEntry{
		status:      status,
		contentType: header.Get("Content-Type"),
		body:        bytes.Clone(w.body.Bytes()),
	}, true
}

// purgePublicCache invalidates every cached public response. Call it after the write
// committed. It never fails the caller: a failure is logged on log (the request's or the
// job's logger, so it carries the id of the write that needed it, with reason: a route
// template or the job) and reads stop trusting the cache until a purge goes through.
func (server *Server) purgePublicCache(ctx context.Context, log *slog.Logger, reason string) {
	pc := server.publicCache
	if !pc.enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), publicCachePurgeTimeout)
	defer cancel()
	if err := pc.ns.Purge(ctx); err != nil {
		// Reads stop trusting the cache until a purge goes through (usable).
		pc.unhealthy.Store(true)
		pc.skipUntil.Store(time.Now().Add(pc.retryAfter).UnixNano())
		// Not throttled: a missed purge is worth seeing every time.
		log.Error("public cache purge failed; reads skip the cache until a purge succeeds",
			"reason", reason, "error", err)
	}
}

// purgePublicCacheAfterWrite purges after every request to a route in
// publicCachePurgeRoutes, once its handler has returned (so after its transaction
// committed). Not after a 4xx: the request was refused and wrote nothing. A 5xx still
// purges, in case it failed after its commit.
//
// The routes in publicCachePostDetailRoutes change one post's fields, and the editor
// saves some of them on a debounce while someone types. When that post was neither
// published before the request nor after it, nothing public changed, so they don't purge:
// otherwise editing a draft would empty the cache every second.
func (server *Server) purgePublicCacheAfterWrite() gin.HandlerFunc {
	return func(c *gin.Context) {
		route := c.Request.Method + " " + c.FullPath()
		if _, purges := publicCachePurgeRoutes[route]; !purges || !server.publicCache.enabled() {
			c.Next()
			return
		}
		postScoped := publicCachePostDetailRoutes[route]
		wasPublished, known := false, false
		if postScoped {
			wasPublished, known = server.postIsPublished(c)
		}
		c.Next()
		if status := c.Writer.Status(); status >= http.StatusBadRequest && status < http.StatusInternalServerError {
			return
		}
		if postScoped && known && !wasPublished {
			if isPublished, ok := server.postIsPublished(c); ok && !isPublished {
				return
			}
		}
		server.purgePublicCache(c.Request.Context(), server.requestLog(c), route)
	}
}

// postIsPublished reports whether the post named by the route's :id is published now.
// ok is false when that can't be told (bad id, lookup error): the caller then purges.
func (server *Server) postIsPublished(c *gin.Context) (published, ok bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return false, false
	}
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		return false, false
	}
	return post.PostStatus == postStatusPublished, true
}

// publicCachePostDetailRoutes are the purge routes that write one post's own fields
// (/posts/:id): they purge only when that post was or is published. Status changes go
// through PUT /posts/:id, so a draft published (or a post unpublished) there still purges.
var publicCachePostDetailRoutes = map[string]bool{
	"PUT /api/v1/posts/:id":                    true,
	"POST /api/v1/posts/:id/meta":              true,
	"DELETE /api/v1/posts/:id/meta/:key":       true,
	"POST /api/v1/posts/:id/featured-image":    true,
	"DELETE /api/v1/posts/:id/featured-image":  true,
	"POST /api/v1/posts/:id/media":             true,
	"DELETE /api/v1/posts/:id/media/:media_id": true,
}

// publicCachePurgeRoutes are the mutating routes after which the public cache is purged:
// everything that can change what the public site shows. Reasons in
// publicCacheNoPurgeRoutes for the others. TestMutatingRoutesDeclarePublicCachePurge
// fails until a new mutating route is in one of the two.
var publicCachePurgeRoutes = map[string]string{
	// Posts: every path that publishes, unpublishes, trashes, restores or deletes, and
	// the live fields (slug, status) that change at once.
	"POST /api/v1/posts":                       "a post may be created published",
	"POST /api/v1/posts/bulk":                  "bulk publish, trash, restore, delete",
	"PUT /api/v1/posts/:id":                    "post_status, slug and parent change the live post at once",
	"DELETE /api/v1/posts/:id":                 "trash: off the site",
	"POST /api/v1/posts/:id/restore":           "back on the site if it was published",
	"DELETE /api/v1/posts/:id/permanent":       "deleted",
	"POST /api/v1/posts/:id/publish":           "publish and Update",
	"POST /api/v1/posts/:id/unpublish":         "off the site",
	"POST /api/v1/posts/:id/meta":              "with_meta list rows carry meta",
	"DELETE /api/v1/posts/:id/meta/:key":       "with_meta list rows carry meta",
	"POST /api/v1/posts/:id/featured-image":    "featured image meta",
	"DELETE /api/v1/posts/:id/featured-image":  "featured image meta",
	"POST /api/v1/posts/:id/media":             "media links",
	"DELETE /api/v1/posts/:id/media/:media_id": "media links",
	"POST /api/v1/posts/:id/transfer":          "the owner is the byline's fallback",
	// Post terms are snapshotted, but the public term lookups and popular terms count
	// working links.
	"PUT /api/v1/posts/:id/taxonomy-terms/:term_id":    "term links and counts",
	"DELETE /api/v1/posts/:id/taxonomy-terms/:term_id": "term links and counts",
	// Media shown on published pages (alt, focal point, file, missing).
	"PUT /api/v1/media/:id":          "alt text, decorative, focal point",
	"POST /api/v1/media/:id/replace": "the file and its variants",
	"DELETE /api/v1/media/:id":       "published blocks leave it out",
	// Site config.
	"PUT /api/v1/settings":                   "title, tagline, language, front page, URL structure",
	"PUT /api/v1/extension-settings":         "theme settings",
	"DELETE /api/v1/extension-settings/:key": "theme settings",
	"PUT /api/v1/themes/:id/activate":        "the active theme",
	"PUT /api/v1/themes/:id/settings/:key":   "theme settings",
	"PUT /api/v1/themes/active/settings":     "theme settings",
	"POST /api/v1/post-types":                "which types are public",
	"PUT /api/v1/post-types/:name":           "which types are public",
	"POST /api/v1/plugins/:slug/enable":      "plugin blocks and features on public pages",
	"POST /api/v1/plugins/:slug/disable":     "plugin blocks and features on public pages",
	"PUT /api/v1/plugins/:slug/settings":     "plugin settings may change public output",
	"DELETE /api/v1/plugins/:slug/settings":  "plugin settings may change public output",
	"POST /api/v1/menus":                     "menus",
	"PUT /api/v1/menus/:id":                  "menus",
	"PUT /api/v1/menus/:id/items":            "menus",
	"DELETE /api/v1/menus/:id":               "menus",
	"POST /api/v1/taxonomy/types":            "taxonomy config",
	"POST /api/v1/taxonomy/terms":            "public term lists",
	"PUT /api/v1/taxonomy/terms/:id":         "term names, slugs (term pages, chips)",
	"DELETE /api/v1/taxonomy/terms/:id":      "posts move to the default category",
	"POST /api/v1/taxonomy/terms/:id/merge":  "terms merged on published posts",
	"PUT /api/v1/users/:id":                  "names, bio, website: bylines, author pages, mentions",
	"PUT /api/v1/users/me/avatar":            "avatars on author cards",
	"DELETE /api/v1/users/me/avatar":         "avatars on author cards",
	"DELETE /api/v1/users/:id":               "their posts move to another member",
	"PUT /api/v1/users/:id/role":             "conservative: who is listed as an author",
}

// publicCacheNoPurgeRoutes are the mutating routes that change nothing the public site
// shows, with why.
var publicCacheNoPurgeRoutes = map[string]string{
	"POST /api/v1/auth/login":                                      "sessions",
	"POST /api/v1/auth/refresh":                                    "sessions",
	"POST /api/v1/auth/logout":                                     "sessions",
	"POST /api/v1/auth/sessions/sign-out-others":                   "sessions",
	"PUT /api/v1/sessions/block":                                   "sessions",
	"POST /api/v1/auth/password/forgot":                            "account email",
	"POST /api/v1/auth/password/reset":                             "account password",
	"POST /api/v1/auth/invitations/preview":                        "reads an invitation",
	"POST /api/v1/auth/invitations/accept":                         "a new member, credited on nothing yet",
	"POST /api/v1/auth/email-change/confirm":                       "the email isn't public",
	"POST /api/v1/auth/register":                                   "a pending signup",
	"POST /api/v1/auth/register/verify":                            "a new member, credited on nothing yet",
	"POST /api/v1/invitations":                                     "invitations",
	"POST /api/v1/invitations/:id/resend":                          "invitations",
	"DELETE /api/v1/invitations/:id":                               "invitations",
	"POST /api/v1/users":                                           "a new member, credited on nothing yet",
	"POST /api/v1/users/me/email":                                  "the email isn't public",
	"POST /api/v1/collab/tickets":                                  "a socket ticket",
	"POST /api/v1/embeds/resolve":                                  "a lookup",
	"POST /api/v1/posts/:id/duplicate":                             "a new draft",
	"POST /api/v1/post-templates":                                  "templates are never public",
	"PUT /api/v1/post-templates/:id":                               "templates are never public",
	"DELETE /api/v1/post-templates/:id":                            "templates are never public",
	"POST /api/v1/post-templates/:id/posts":                        "a new draft",
	"PUT /api/v1/posts/:id/schedule":                               "a draft or scheduled post isn't public; the scheduler purges when it publishes",
	"DELETE /api/v1/posts/:id/schedule":                            "back to draft from scheduled: wasn't public",
	"PUT /api/v1/posts/:id/scheduled-update":                       "frozen until the scheduler applies it (and purges)",
	"DELETE /api/v1/posts/:id/scheduled-update":                    "the live post is unchanged",
	"POST /api/v1/posts/:id/versions/:version_no/restore-settings": "the working copy only; reaches the site on Update",
	"PUT /api/v1/posts/:id/seo":                                    "snapshotted (#357): reaches the site on Update",
	"PUT /api/v1/posts/:id/template":                               "snapshotted (#336): reaches the site on Update",
	"PUT /api/v1/posts/:id/authors":                                "snapshotted (#319): reaches the site on Update",
	"POST /api/v1/posts/:id/review-request":                        "review requests aren't public",
	"POST /api/v1/review-requests/:id/dismiss":                     "review requests aren't public",
	"POST /api/v1/review-requests/:id/request-changes":             "review requests aren't public",
	"POST /api/v1/posts/:id/access-requests":                       "edit access isn't public",
	"POST /api/v1/posts/:id/access-requests/:request_id/grant":     "edit access isn't public",
	"POST /api/v1/posts/:id/access-requests/:request_id/decline":   "edit access isn't public",
	"DELETE /api/v1/posts/:id/collaborators/:user_id":              "edit access isn't public",
	"POST /api/v1/posts/:id/comments":                              "block comments are never public (#192)",
	"PUT /api/v1/posts/:id/comments/:comment_id":                   "block comments are never public (#192)",
	"DELETE /api/v1/posts/:id/comments/:comment_id":                "block comments are never public (#192)",
	"POST /api/v1/posts/:id/comment-threads/:thread_id/replies":    "block comments are never public (#192)",
	"POST /api/v1/posts/:id/comment-threads/:thread_id/resolve":    "block comments are never public (#192)",
	"POST /api/v1/posts/:id/comment-threads/:thread_id/unresolve":  "block comments are never public (#192)",
	"POST /api/v1/posts/:id/html-snippets":                         "the working markup; publish copies it (#428)",
	"PUT /api/v1/posts/:id/html-snippets/:snippet_id":              "the working markup; publish copies it (#428)",
	"POST /api/v1/media":                                           "a new upload is on no published page",
	"POST /api/v1/media/batch":                                     "a new upload is on no published page",
	"POST /api/v1/media/bulk":                                      "a new upload is on no published page",
	"POST /api/v1/redirects":                                       "redirect lookups aren't cached; the web caches its own 301s",
	"DELETE /api/v1/redirects/:id":                                 "redirect lookups aren't cached; the web caches its own 301s",
	// Internal listener.
	"PUT /internal/posts/:id/collab": "the working copy; publish purges",
}
