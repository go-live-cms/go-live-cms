package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/cache"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Caching the site design (#495, docs/design/theme-builder.md 11) against the test
// database (skipped without one) and #185's cache (miniredis speaks Valkey's protocol, the
// same client and namespace as production). The design's public reads are #185's
// cache-aside: /public/site-templates/resolve (templates, parts, their media and menus)
// keyed by the theme and the ranked slugs, and the published global styles with
// /themes/active. Every event that changes them purges after its commit: a design publish,
// a reset publish, a restore once published, a theme switch, a site logo or front page
// change (settings), a menu save and a media delete. A purge that fails never fails the
// write, and a previewed (draft) read never reads or writes the cache.

// designCacheDB is the publish fixture plus the cache's miniredis.
type designCacheDB struct {
	publishDB
	mr *miniredis.Miniredis
}

func newDesignCacheDB(t *testing.T) designCacheDB {
	t.Helper()
	p := publishDB{siteDesignDBFixture: newSiteDesignDBFixture(t), t: t}
	return designCacheDB{publishDB: p, mr: withMiniredis(t, p.server)}
}

// resolvePath is a route's resolve: the theme and its ranked slugs, the whole cache key.
func (d designCacheDB) resolvePath(slugs string) string {
	return "/public/site-templates/resolve?theme=" + d.theme.Slug + "&slugs=" + slugs
}

// resolve reads it anonymously, as the web does: the body and X-Cache.
func (d designCacheDB) resolve(slugs string) (SiteTemplateResolveResponse, string, string) {
	d.t.Helper()
	recorder := cacheGet(d.t, d.server, d.resolvePath(slugs))
	require.Equal(d.t, http.StatusOK, recorder.Code, recorder.Body.String())
	var res SiteTemplateResolveResponse
	require.NoError(d.t, json.Unmarshal(recorder.Body.Bytes(), &res))
	return res, recorder.Body.String(), recorder.Header().Get(publicCacheHeader)
}

// warm reads slugs twice and checks the second read was a hit.
func (d designCacheDB) warm(slugs string) {
	d.t.Helper()
	d.resolve(slugs)
	_, _, result := d.resolve(slugs)
	require.Equal(d.t, "HIT", result, "the resolve is cached before the event")
}

// afterEvent reads slugs once: the event must have purged (a miss) and the body must say want.
func (d designCacheDB) afterEvent(slugs, want, event string) string {
	d.t.Helper()
	_, body, result := d.resolve(slugs)
	require.Equal(d.t, "MISS", result, "%s didn't purge the public cache", event)
	require.Contains(d.t, body, want, "%s: the next request shows it", event)
	return body
}

func (d designCacheDB) publish() map[string]json.RawMessage {
	d.t.Helper()
	status, out := d.call(http.MethodPost, "/api/v1/site-design/publish", `{"confirm_contrast":true}`)
	require.Equal(d.t, http.StatusOK, status, out)
	return out
}

// The cache key carries everything the resolve depends on that a request says: the theme
// and the slugs in rank order (the route kind is its slug list). The rest (templates,
// parts, media, menus, the active theme) purges.
func TestSiteDesignResolveCacheKeys(t *testing.T) {
	d := newDesignCacheDB(t)
	d.warm("single,index")
	_, _, result := d.resolve("index,single")
	require.Equal(t, "MISS", result, "another rank order is another route")
	_, _, result = d.resolve("single")
	require.Equal(t, "MISS", result, "another slug list is another route")
	recorder := cacheGet(t, d.server, "/public/site-templates/resolve?theme="+d.theme.Slug+"x&slugs=single,index")
	require.Equal(t, http.StatusNotFound, recorder.Code, "another theme is never this one's answer")
	_, _, result = d.resolve("single,index")
	require.Equal(t, "HIT", result)
}

// Each event that changes the published design purges after its commit, so the next
// request shows it.
func TestSiteDesignPurgedByEveryEvent(t *testing.T) {
	d := newDesignCacheDB(t)
	ctx := context.Background()
	const slugs = "single"

	// 1. A design publish: the part goes live on the next request.
	header := d.create("part", "header", "blank")
	d.store(header.ID, designDoc("HEADER-V1"))
	res, _, _ := d.resolve(slugs)
	require.NotContains(t, res.Parts, "header", "nothing is published yet")
	d.warm(slugs)
	d.publish()
	d.afterEvent(slugs, "HEADER-V1", "a design publish")
	res, _, _ = d.resolve(slugs)
	require.Equal(t, siteDesignSourceOverride, res.Parts["header"].Source)

	// The published styles (/themes/active) too.
	d.activeThemeStyles(t)
	_, cached := d.activeThemeStyles(t)
	require.Equal(t, "HIT", cached)
	status, _ := d.call(http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"colors":{"light":{"text":"#141414"}}},"base_revision":0}`)
	require.Equal(t, http.StatusOK, status)
	_, cached = d.activeThemeStyles(t)
	require.Equal(t, "HIT", cached, "a styles draft save changes nothing public and doesn't purge")
	d.publish()
	styles, cached := d.activeThemeStyles(t)
	require.Equal(t, "MISS", cached, "the styles publish purged")
	require.Contains(t, styles, "#141414")

	// 2. A reset publish: the part's published copy goes, the next request has none.
	d.warm(slugs)
	status, _ = d.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/reset", header.ID), "")
	require.Equal(t, http.StatusOK, status)
	_, _, result := d.resolve(slugs)
	require.Equal(t, "HIT", result, "a reset reaches the site on publish, not before")
	d.publish()
	_, body, result := d.resolve(slugs)
	require.Equal(t, "MISS", result, "a reset publish didn't purge")
	require.NotContains(t, body, "HEADER-V1")

	// 3. A restore: recorded into the working copy (nothing public changes, so the cached
	// answer is still right), live on the next publish, which purges.
	var version struct {
		BlockDoc map[string]any `json:"block_doc"`
	}
	_, out := d.call(http.MethodGet, fmt.Sprintf("/api/v1/site-design/templates/%d/versions/1", header.ID), "")
	require.NoError(t, json.Unmarshal(out["block_doc"], &version.BlockDoc))
	d.warm(slugs)
	d.store(header.ID, version.BlockDoc)
	status, _ = d.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/versions/1/restore", header.ID), "")
	require.Equal(t, http.StatusOK, status)
	_, body, result = d.resolve(slugs)
	require.Equal(t, "HIT", result, "a restore changes only the working copy")
	require.NotContains(t, body, "HEADER-V1")
	d.publish()
	d.afterEvent(slugs, "HEADER-V1", "publishing a restore")

	// 4. A menu save: a navigation block's menu by id comes with the resolve.
	var menuID int64
	require.NoError(t, d.conn.QueryRow(`INSERT INTO menus (name) VALUES ('Design cache menu') RETURNING id`).Scan(&menuID))
	t.Cleanup(func() { _, _ = d.conn.Exec(`DELETE FROM menus WHERE id = $1`, menuID) })
	withNav := designDoc("HEADER-V2")
	withNav["blocks"].(map[string]any)["navi-00001"] = map[string]any{"id": "navi-00001", "type": "navigation", "version": 1, "attrs": map[string]any{"menuId": menuID}}
	withNav["blocks_order"] = append(withNav["blocks_order"].([]string), "navi-00001")
	d.store(header.ID, withNav)
	d.publish()
	d.warm(slugs)
	requireStatus(t, d.request(t, &d.admin, http.MethodPut, fmt.Sprintf("/api/v1/menus/%d/items", menuID),
		`{"items":[{"type":"custom","label":"Design cache link","url":"/design-cache"}]}`), http.StatusOK)
	d.afterEvent(slugs, "Design cache link", "a menu save")

	// 5. The site logo (settings): the site_logo block renders it on every page.
	settings, err := d.siteDesignDBFixture.store.GetSettings(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = d.conn.Exec(`UPDATE settings SET site_logo_media_id = $1`, settings.SiteLogoMediaID)
	})
	logo, err := d.siteDesignDBFixture.store.CreateMedia(ctx, db.CreateMediaParams{Name: "design cache logo", MediaPath: "/x/design-cache-logo.png", UserID: d.admin.ID, MimeType: "image/png"})
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = d.conn.Exec(`DELETE FROM media WHERE id = $1`, logo.ID) })
	d.warm(slugs)
	requireStatus(t, d.request(t, &d.admin, http.MethodPut, "/api/v1/settings", fmt.Sprintf(`{"site_logo_media_id":%d}`, logo.ID)), http.StatusOK)
	_, _, result = d.resolve(slugs)
	require.Equal(t, "MISS", result, "a site logo change purges")
	// The front page is the same settings route (front_page_id): it purges the same way.
	d.warm(slugs)
	requireStatus(t, d.request(t, &d.admin, http.MethodPut, "/api/v1/settings", `{"site_logo_media_id":null}`), http.StatusOK)
	_, _, result = d.resolve(slugs)
	require.Equal(t, "MISS", result, "removing the site logo purges")

	// 6. A theme switch: another theme's answer is never served, and the old one's read
	// isn't served from the cache either.
	other, err := d.siteDesignDBFixture.store.CreateTheme(ctx, db.CreateThemeParams{Name: "Design cache other", Slug: "gl495-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12], Version: "1.0.0", Config: json.RawMessage(`{}`)})
	require.NoError(t, err)
	t.Cleanup(func() { _ = d.siteDesignDBFixture.store.DeleteTheme(ctx, other.ID) })
	d.warm(slugs)
	d.activeThemeStyles(t)
	requireStatus(t, d.request(t, &d.admin, http.MethodPut, fmt.Sprintf("/api/v1/themes/%d/activate", other.ID), ""), http.StatusOK)
	recorder := cacheGet(t, d.server, d.resolvePath(slugs))
	require.Equal(t, http.StatusNotFound, recorder.Code, "the old theme's design isn't served after a switch")
	active := cacheGet(t, d.server, "/api/v1/themes/active")
	require.Equal(t, "MISS", active.Header().Get(publicCacheHeader), "a theme switch purges")
	require.Contains(t, active.Body.String(), other.Slug)
	// Switching back brings the design back (decision 16.6), again on the next request.
	requireStatus(t, d.request(t, &d.admin, http.MethodPut, fmt.Sprintf("/api/v1/themes/%d/activate", d.theme.ID), ""), http.StatusOK)
	d.afterEvent(slugs, "HEADER-V2", "switching back")
}

// purgeWatch wraps #185's cache and runs check whenever the public namespace is purged
// (Namespace.Purge is the only Set of its generation key).
type purgeWatch struct {
	cache.Cache
	check func()
}

func (w purgeWatch) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if key == publicCacheNamespace+":gen" && w.check != nil {
		w.check()
	}
	return w.Cache.Set(ctx, key, value, ttl)
}

// No purge fires inside a transaction: when the publish purges, its commit is visible
// from another connection, so a read racing the purge can't cache the old design under
// the new generation.
func TestSiteDesignPurgeRunsAfterCommit(t *testing.T) {
	d := newDesignCacheDB(t)
	header := d.create("part", "header", "blank")
	d.store(header.ID, designDoc("AFTER-COMMIT"))

	var mu sync.Mutex
	var seen []bool
	client := redis.NewClient(&redis.Options{Addr: d.mr.Addr(), DialerRetries: 1})
	t.Cleanup(func() { _ = client.Close() })
	d.server.SetCache(purgeWatch{Cache: cache.NewRedisFromClient(client), check: func() {
		// A connection of its own: inside the publish's transaction this would still see NULL.
		var published sql.NullString
		require.NoError(t, d.conn.QueryRow(`SELECT published_block_doc::text FROM site_templates WHERE id = $1`, header.ID).Scan(&published))
		mu.Lock()
		seen = append(seen, published.Valid && strings.Contains(published.String, "AFTER-COMMIT"))
		mu.Unlock()
	}})

	d.resolve("single")
	d.publish()
	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []bool{true}, seen, "one purge, after the published copy committed")
}

// A purge that fails (Valkey down) never fails the publish; reads bypass the cache until
// a purge goes through.
func TestSiteDesignPurgeFailureDoesNotFailThePublish(t *testing.T) {
	d := newDesignCacheDB(t)
	header := d.create("part", "header", "blank")
	d.store(header.ID, designDoc("PURGE-DOWN"))
	d.warm("single")
	d.mr.Close()

	d.publish()
	require.True(t, d.row(header.ID).PublishedBlockDoc.Valid, "published despite the failed purge")
	_, body, result := d.resolve("single")
	require.Equal(t, "BYPASS", result)
	require.Contains(t, body, "PURGE-DOWN")
}

// A previewed request never touches the cache: the draft read (#486) carries the preview
// token as its bearer and answers private, no-store; the same request with an
// Authorization header to a cached route reads Postgres and stores nothing.
func TestSiteDesignPreviewNeverCached(t *testing.T) {
	d := newDesignCacheDB(t)
	status, _ := d.call(http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"colors":{"light":{"text":"#161616"}}},"base_revision":0}`)
	require.Equal(t, http.StatusOK, status)
	status, out := d.call(http.MethodPost, "/api/v1/site-design/preview", "")
	require.Equal(t, http.StatusOK, status)
	var token string
	require.NoError(t, json.Unmarshal(out["token"], &token))

	before := publicCacheEntries(d.mr)
	for i := 0; i < 2; i++ {
		recorder := cacheGet(t, d.server, "/api/v1/site-design/draft", "Authorization", "Bearer "+token)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), "#161616", "the preview reads the draft")
		require.Empty(t, recorder.Header().Get(publicCacheHeader), "never read from or stored in the cache")
		require.Contains(t, recorder.Header().Get("Cache-Control"), "no-store")

		signed := cacheGet(t, d.server, d.resolvePath("single"), "Authorization", "Bearer "+token)
		require.Equal(t, http.StatusOK, signed.Code)
		require.Empty(t, signed.Header().Get(publicCacheHeader))
	}
	require.Equal(t, before, publicCacheEntries(d.mr), "nothing a preview read was stored")

	// The published answers don't carry the draft, cached or not.
	styles, _ := d.activeThemeStyles(t)
	require.NotContains(t, styles, "#161616")
	styles, cached := d.activeThemeStyles(t)
	require.Equal(t, "HIT", cached)
	require.NotContains(t, styles, "#161616")
}
