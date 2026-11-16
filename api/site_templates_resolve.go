package api

// Template resolution for the public site (#491, docs/design/theme-builder.md 3.2, 3.3, 4.2,
// 4.3): GET /public/site-templates/resolve. The web asks, for one route, its ranked list of
// template slugs (most specific first) and gets the first that has a published builder
// override or a block template the active theme ships, with everything its render needs in
// one answer: the parts it places, the media of every doc, and the menus its navigation
// blocks name by id. Published copies only: a working copy never reaches /public
// (route_auth_test.go's TestPublicNeverServesDrafts), and previews read drafts elsewhere.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// maxResolveSlugs caps one resolve's slug list: the longest of design 3.2's lists is three
// (the front page's), so this is generous and keeps the query and the cache key small.
const maxResolveSlugs = 8

// maxResolveThemeSlug bounds ?theme= (a directory name), which is part of the cache key.
const maxResolveThemeSlug = 200

// maxResolveMenus caps how many menus by id one answer carries. A template and its parts
// name a handful; more is a doc built to make the read expensive.
const maxResolveMenus = 16

// Where a resolved template or part comes from.
const (
	siteDesignSourceOverride = "override" // a published site_templates row (the builder)
	siteDesignSourceTheme    = "theme"    // the active theme's templates/<slug>.json or parts/<slug>.json
	siteDesignSourceStarter  = "starter"  // core's starter part (sitedesign.Starter)
)

// ResolvedSiteTemplate is the template a route renders: the first of the asked slugs with
// a published override or a shipped block template. Rank is its index in the asked list,
// which the web compares with the theme's code layout's (design 3.3).
type ResolvedSiteTemplate struct {
	Slug   string                 `json:"slug"`
	Rank   int                    `json:"rank"`
	Source string                 `json:"source"`
	Title  string                 `json:"title"`
	Doc    map[string]interface{} `json:"doc"`
}

// ResolvedSitePart is one template part: the published override, else the theme's, else
// core's starter (design 4.2).
type ResolvedSitePart struct {
	Source string                 `json:"source"`
	Title  string                 `json:"title"`
	Doc    map[string]interface{} `json:"doc"`
}

// SiteTemplateResolveResponse is GET /public/site-templates/resolve's answer.
//
//   - Template: null when no asked slug has a builder or shipped template: the route renders
//     its code layout.
//   - Parts: the parts the template places, each resolved (override, theme, starter), plus
//     every published override part, which a code layout's <TemplatePart> renders in place
//     of the theme's own markup. A slug none of the three has is absent.
//   - Menus: the menus a navigation block of the template or of those parts names by id
//     (design 4.1, decision 16.4), keyed by id; a deleted one is absent and renders nothing.
//     No other public route serves a menu by id.
type SiteTemplateResolveResponse struct {
	Theme    string                        `json:"theme"`
	Template *ResolvedSiteTemplate         `json:"template"`
	Parts    map[string]ResolvedSitePart   `json:"parts"`
	Menus    map[string]PublicMenuResponse `json:"menus"`
}

// parseResolveSlugs reads ?slugs=a,b,c: one to maxResolveSlugs distinct slugs, each a
// site_templates slug, in the caller's rank order.
func parseResolveSlugs(raw string) ([]string, bool) {
	if raw == "" {
		return nil, false
	}
	parts := strings.Split(raw, ",")
	if len(parts) > maxResolveSlugs {
		return nil, false
	}
	seen := make(map[string]bool, len(parts))
	slugs := make([]string, 0, len(parts))
	for _, slug := range parts {
		if !sitedesign.SlugPattern.MatchString(slug) || seen[slug] {
			return nil, false
		}
		seen[slug] = true
		slugs = append(slugs, slug)
	}
	return slugs, true
}

// resolvePublicSiteTemplate handles GET /public/site-templates/resolve?theme=<slug>&slugs=<a,b>.
//
// The theme is the one the web renders (Astro.locals.activeTheme), so it is part of the
// cache key (#185) with the slugs; a theme that isn't active is a 404, never another theme's
// design. Everything else the answer depends on (templates, parts, media, menus, the active
// theme) purges the whole public cache when it changes (publicCachePurgeRoutes).
//
// Authentication: none (public, rate limited like the rest of /public)
//
// Returns:
//   - 200 OK: SiteTemplateResolveResponse (template null when none matches)
//   - 400 Bad Request: `invalid_slugs` (none, more than 8, a duplicate or not a slug) or
//     `invalid_theme` (none, or longer than 200 bytes)
//   - 404 Not Found: no active theme, or `theme_inactive`
//   - 500: a database read failed (the web renders the code layout)
func (server *Server) resolvePublicSiteTemplate(c *gin.Context) {
	slugs, ok := parseResolveSlugs(c.Query("slugs"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_slugs", "error": "slugs must be 1 to 8 distinct template slugs"})
		return
	}
	// A theme's slug is its directory's name (themes_scanner.go), so only its equality with the
	// active theme's is checked, after a bound on the key's size.
	themeSlug := c.Query("theme")
	if themeSlug == "" || len(themeSlug) > maxResolveThemeSlug {
		c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_theme", "error": "theme must be the active theme's slug"})
		return
	}
	ctx := c.Request.Context()
	theme, err := server.store.GetActiveTheme(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active theme found"})
			return
		}
		server.requestLog(c).Error("site_template_resolve_failed", "step", "active_theme", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resolve the template"})
		return
	}
	if theme.Slug != themeSlug {
		c.JSON(http.StatusNotFound, gin.H{"code": "theme_inactive", "error": "that theme is not the active theme"})
		return
	}
	rows, err := server.store.ListPublishedSiteTemplatesForResolve(ctx, db.ListPublishedSiteTemplatesForResolveParams{ThemeSlug: theme.Slug, Slugs: slugs})
	if err != nil {
		server.requestLog(c).Error("site_template_resolve_failed", "step", "published_templates", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resolve the template"})
		return
	}

	resolver := server.newSiteDesignResolver(c, theme, rows)
	resp := SiteTemplateResolveResponse{Theme: theme.Slug, Parts: map[string]ResolvedSitePart{}, Menus: map[string]PublicMenuResponse{}}
	resp.Template = resolver.template(slugs)

	// A code layout's <TemplatePart> renders a published override in place of the theme's
	// markup, so every override part is in the answer.
	for slug, part := range resolver.overrideParts {
		resp.Parts[slug] = part
	}
	if resp.Template != nil {
		for _, slug := range placedPartSlugs(resp.Template.Doc) {
			if part, ok := resolver.part(slug); ok {
				resp.Parts[slug] = part
			}
		}
	}

	docs := make([]map[string]interface{}, 0, len(resp.Parts)+1)
	if resp.Template != nil {
		docs = append(docs, resp.Template.Doc)
	}
	for _, slug := range sortedMapKeys(resp.Parts) {
		docs = append(docs, resp.Parts[slug].Doc)
	}
	server.attachBlockMedia(ctx, docs...)
	server.publicizeBlockDocs(ctx, docs...)
	resp.Menus = server.menusNamedByID(c, docs)
	c.JSON(http.StatusOK, resp)
}

// siteDesignResolver resolves slugs against the published overrides of one theme, then the
// block templates and parts it ships (its config, from the scan, design 5.7), then core's
// starter parts.
type siteDesignResolver struct {
	server            *Server
	c                 *gin.Context
	themeSlug         string
	overrideTemplates map[string]ResolvedSitePart
	overrideParts     map[string]ResolvedSitePart
	shippedTemplates  map[string]ThemeBlockTemplate
	shippedParts      map[string]ThemeBlockTemplate
}

func (server *Server) newSiteDesignResolver(c *gin.Context, theme db.Theme, rows []db.ListPublishedSiteTemplatesForResolveRow) *siteDesignResolver {
	r := &siteDesignResolver{
		server:            server,
		c:                 c,
		themeSlug:         theme.Slug,
		overrideTemplates: map[string]ResolvedSitePart{},
		overrideParts:     map[string]ResolvedSitePart{},
		shippedTemplates:  shippedBlockTemplates(theme.Config, "block_templates"),
		shippedParts:      shippedBlockTemplates(theme.Config, "block_parts"),
	}
	for _, row := range rows {
		if !row.PublishedBlockDoc.Valid {
			continue
		}
		doc, ok := r.docMap(row.PublishedBlockDoc.RawMessage, row.Kind, row.Slug)
		if !ok {
			continue
		}
		resolved := ResolvedSitePart{Source: siteDesignSourceOverride, Title: row.Title, Doc: doc}
		if row.Kind == sitedesign.KindPart {
			r.overrideParts[row.Slug] = resolved
		} else {
			r.overrideTemplates[row.Slug] = resolved
		}
	}
	return r
}

// template is the first slug, in rank order, with an override or a shipped template.
func (r *siteDesignResolver) template(slugs []string) *ResolvedSiteTemplate {
	for rank, slug := range slugs {
		if found, ok := r.overrideTemplates[slug]; ok {
			return &ResolvedSiteTemplate{Slug: slug, Rank: rank, Source: found.Source, Title: found.Title, Doc: found.Doc}
		}
		if shipped, ok := r.shippedTemplates[slug]; ok {
			if doc, ok := r.docMap(shipped.Doc, sitedesign.KindTemplate, slug); ok {
				return &ResolvedSiteTemplate{Slug: slug, Rank: rank, Source: siteDesignSourceTheme, Title: shipped.Title, Doc: doc}
			}
		}
	}
	return nil
}

// part resolves a part slug as design 4.2 orders it: the published override, the part the
// theme ships, core's starter. ok is false when none of the three has it.
func (r *siteDesignResolver) part(slug string) (ResolvedSitePart, bool) {
	if found, ok := r.overrideParts[slug]; ok {
		return found, true
	}
	if shipped, ok := r.shippedParts[slug]; ok {
		if doc, ok := r.docMap(shipped.Doc, sitedesign.KindPart, slug); ok {
			return ResolvedSitePart{Source: siteDesignSourceTheme, Title: shipped.Title, Doc: doc}, true
		}
	}
	starter, ok := r.server.starterPart(slug)
	if !ok {
		return ResolvedSitePart{}, false
	}
	docMap, ok := r.docMap(starter.Doc, sitedesign.KindPart, slug)
	if !ok {
		return ResolvedSitePart{}, false
	}
	return ResolvedSitePart{Source: siteDesignSourceStarter, Title: starter.Title, Doc: docMap}, true
}

// normalizedStarterParts caches core's starter parts once they went through the part's
// rules: they are embedded in the binary and hold site blocks only, so one normalization
// serves every request (a cache miss after each purge would otherwise redo it).
var normalizedStarterParts sync.Map // slug → sitedesign.File (Doc normalized), or false for none

// starterPart is core's starter part for slug, through the same rules as a stored part, so
// it renders exactly as a "Customize" copy of it would. ok is false when there is none.
func (server *Server) starterPart(slug string) (sitedesign.File, bool) {
	if cached, ok := normalizedStarterParts.Load(slug); ok {
		file, found := cached.(sitedesign.File)
		return file, found
	}
	starter, ok := sitedesign.Starter(sitedesign.KindPart, slug)
	if !ok {
		normalizedStarterParts.Store(slug, false)
		return sitedesign.File{}, false
	}
	normalized, err := server.normalizeSiteTemplateDoc(starter.Doc, sitedesign.KindPart)
	if err != nil {
		// The embedded starters are tested (TestStartersPassTheirKindsRules): a build bug.
		server.logger.Error("site_design_starter_invalid", "slug", slug, "error", err)
		return sitedesign.File{}, false
	}
	starter.Doc = normalized
	normalizedStarterParts.Store(slug, starter)
	return starter, true
}

// docMap parses a stored doc for the answer; a doc that isn't a Block Spec document (it
// can't be, through publish's checks) is logged and skipped, so the next source renders.
func (r *siteDesignResolver) docMap(raw json.RawMessage, kind, slug string) (map[string]interface{}, bool) {
	var doc map[string]interface{}
	if err := json.Unmarshal(raw, &doc); err != nil || !isBlockDocShape(doc) {
		r.server.requestLog(r.c).Error("site_template_doc_invalid", "theme", r.themeSlug, "kind", kind, "slug", slug)
		return nil, false
	}
	return doc, true
}

// shippedBlockTemplates reads config.block_templates or config.block_parts (slug → {title,
// doc, hash}, written by applyThemeBlockTemplates). Anything unreadable is none.
func shippedBlockTemplates(config json.RawMessage, key string) map[string]ThemeBlockTemplate {
	var stored map[string]json.RawMessage
	if len(config) == 0 || json.Unmarshal(config, &stored) != nil {
		return nil
	}
	var byslug map[string]ThemeBlockTemplate
	if raw, ok := stored[key]; !ok || json.Unmarshal(raw, &byslug) != nil {
		return nil
	}
	return byslug
}

// docBlocks is a parsed doc's blocks, each a map; anything else is skipped.
func resolveDocBlocks(doc map[string]interface{}) []map[string]interface{} {
	blocks, _ := doc["blocks"].(map[string]interface{})
	ids := make([]string, 0, len(blocks))
	for id := range blocks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]map[string]interface{}, 0, len(ids))
	for _, id := range ids {
		if block, ok := blocks[id].(map[string]interface{}); ok {
			out = append(out, block)
		}
	}
	return out
}

func resolveBlockAttrs(block map[string]interface{}) map[string]interface{} {
	attrs, _ := block["attrs"].(map[string]interface{})
	return attrs
}

// placedPartSlugs is every part slug a template's template_part blocks name, sorted. Every
// block counts, wherever it sits (a part inside a group still renders).
func placedPartSlugs(doc map[string]interface{}) []string {
	seen := map[string]bool{}
	for _, block := range resolveDocBlocks(doc) {
		if block["type"] != "template_part" {
			continue
		}
		if slug, ok := resolveBlockAttrs(block)["slug"].(string); ok && sitedesign.SlugPattern.MatchString(slug) {
			seen[slug] = true
		}
	}
	return sortedMapKeys(seen)
}

// navigationMenuIDs is every menu id the docs' navigation blocks name, ascending.
func navigationMenuIDs(docs []map[string]interface{}) []int64 {
	seen := map[int64]bool{}
	for _, doc := range docs {
		for _, block := range resolveDocBlocks(doc) {
			if block["type"] != "navigation" {
				continue
			}
			if id, ok := blockMediaID(resolveBlockAttrs(block)["menuId"]); ok {
				seen[id] = true
			}
		}
	}
	ids := make([]int64, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// menusNamedByID loads the menus the docs' navigation blocks name by id, as
// /public/menus/:location serves one (visible items only). A deleted menu is left out;
// a failed read is logged and left out too, so that block renders nothing and the page
// still renders (design 4.3).
func (server *Server) menusNamedByID(c *gin.Context, docs []map[string]interface{}) map[string]PublicMenuResponse {
	menus := map[string]PublicMenuResponse{}
	ids := navigationMenuIDs(docs)
	if len(ids) > maxResolveMenus {
		server.requestLog(c).Warn("site_template_menu_limit", "limit", maxResolveMenus, "count", len(ids))
		ids = ids[:maxResolveMenus]
	}
	for _, id := range ids {
		menu, err := server.store.GetMenu(c.Request.Context(), id)
		if err != nil {
			if !errors.Is(err, sql.ErrNoRows) {
				server.requestLog(c).Warn("site_template_menu_failed", "menu_id", id, "error", err)
			}
			continue
		}
		items, err := server.resolvedMenuItems(c, menu.ID)
		if err != nil {
			server.requestLog(c).Warn("site_template_menu_failed", "menu_id", id, "error", err)
			continue
		}
		menus[strconv.FormatInt(id, 10)] = PublicMenuResponse{Name: menu.Name, Location: menu.Location.String, Items: publicMenuItems(items)}
	}
	return menus
}

func sortedMapKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
