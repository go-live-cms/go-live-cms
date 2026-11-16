package api

// Publish site design (#492, docs/design/theme-builder.md 8.1, 8.2, 9): one publish puts
// every changed template, part and the global styles of the active theme live together,
// under one release.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Working states of a site_templates row (section 9).
const (
	siteTemplateCustom = "custom"
	siteTemplateReset  = "reset"
)

// What a publish does to a row with unpublished changes (8.1).
const (
	siteTemplateChangePublish = "publish" // the working copy goes live
	siteTemplateChangeReset   = "reset"   // the published copy becomes NULL: the theme's default renders
)

// siteTemplateChange is what publishing would do to a row, "" when it has no unpublished
// changes (8.1): a custom row whose working copy differs from its published copy (or that
// was never published), or a reset row that still has a published override.
func siteTemplateChange(row db.SiteTemplate) string {
	if row.WorkingState == siteTemplateReset {
		if row.PublishedBlockDoc.Valid {
			return siteTemplateChangeReset
		}
		return ""
	}
	if !row.PublishedBlockDoc.Valid || !sameJSON(row.BlockDoc, row.PublishedBlockDoc.RawMessage) {
		return siteTemplateChangePublish
	}
	return ""
}

// sameJSON compares two JSON documents by value (key order and spacing aside).
func sameJSON(a, b json.RawMessage) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return false
	}
	return reflect.DeepEqual(left, right)
}

// blockDocIsEmpty: nothing renders. No blocks, or only paragraphs with no inline content
// (what the editor adds on its own), the collab server's hasContent the other way round
// (web/collab-server/store.ts).
func blockDocIsEmpty(doc BlockDocV1) bool {
	for _, id := range doc.BlocksOrder {
		block, _ := doc.Blocks[id].(map[string]any)
		if block == nil || block["type"] != "paragraph" {
			return false
		}
		attrs, _ := block["attrs"].(map[string]any)
		if text, _ := attrs["text"].(string); text != "" {
			return false
		}
		if pm, _ := attrs["pm"].(map[string]any); pm != nil {
			if content, _ := pm["content"].([]any); len(content) > 0 {
				return false
			}
		}
	}
	return true
}

// templatePartSlugs are the slugs of every template_part block in a doc, nested ones too
// (the blocks map holds every block), sorted and unique.
func templatePartSlugs(doc BlockDocV1) []string {
	seen := map[string]bool{}
	for _, value := range doc.Blocks {
		block, _ := value.(map[string]any)
		if block == nil || block["type"] != "template_part" {
			continue
		}
		attrs, _ := block["attrs"].(map[string]any)
		if slug, _ := attrs["slug"].(string); slug != "" {
			seen[slug] = true
		}
	}
	slugs := make([]string, 0, len(seen))
	for slug := range seen {
		slugs = append(slugs, slug)
	}
	sort.Strings(slugs)
	return slugs
}

// SiteDesignProblem is one reason a publish was refused: the item (kind, slug) and what
// failed. Part is the unresolved part's slug (code part_unresolved).
type SiteDesignProblem struct {
	Code   string `json:"code"`
	ID     int64  `json:"id,omitempty"`
	Kind   string `json:"kind"`
	Slug   string `json:"slug"`
	Part   string `json:"part,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// Codes of SiteDesignProblem.
const (
	siteDesignTemplateEmpty   = "template_empty"
	siteDesignTemplateInvalid = "template_invalid"
	siteDesignPartUnresolved  = "part_unresolved"
)

// siteDesignPlan is what a publish of the theme would do, read from its rows.
type siteDesignPlan struct {
	rows    []db.SiteTemplate
	changes map[int64]string // row id → siteTemplateChange, changed rows only
}

func newSiteDesignPlan(rows []db.SiteTemplate) siteDesignPlan {
	plan := siteDesignPlan{rows: rows, changes: map[int64]string{}}
	for _, row := range rows {
		if change := siteTemplateChange(row); change != "" {
			plan.changes[row.ID] = change
		}
	}
	return plan
}

// changed are the changed rows, templates first, then by slug.
func (p siteDesignPlan) changed() []db.SiteTemplate {
	var rows []db.SiteTemplate
	for _, row := range p.rows {
		if _, ok := p.changes[row.ID]; ok {
			rows = append(rows, row)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Kind != rows[j].Kind {
			return rows[i].Kind == sitedesign.KindTemplate
		}
		return rows[i].Slug < rows[j].Slug
	})
	return rows
}

// liveDoc is a row's published copy after this publish: nil when the theme's default
// renders (never published, or reset).
func (p siteDesignPlan) liveDoc(row db.SiteTemplate) json.RawMessage {
	switch p.changes[row.ID] {
	case siteTemplateChangePublish:
		return row.BlockDoc
	case siteTemplateChangeReset:
		return nil
	}
	if row.PublishedBlockDoc.Valid {
		return row.PublishedBlockDoc.RawMessage
	}
	return nil
}

// validate checks what this publish would put live (8.2 step 1): each published working
// copy passes its kind's store checks (a block uninstalled since is template_invalid), no
// template is empty, and every template_part slug of every template live afterwards
// resolves (4.2): to a part this theme has live after the publish, else the part the
// theme ships, else core's starter part. An empty part is allowed: a site may have no
// footer.
func (server *Server) validateSiteDesignPlan(theme db.Theme, plan siteDesignPlan) []SiteDesignProblem {
	problems := []SiteDesignProblem{}
	liveParts := map[string]bool{}
	for _, row := range plan.rows {
		if row.Kind == sitedesign.KindPart && plan.liveDoc(row) != nil {
			liveParts[row.Slug] = true
		}
	}
	resolves := func(slug string) bool {
		if liveParts[slug] {
			return true
		}
		if _, ok := themeBlockTemplateFromConfig(theme.Config, sitedesign.KindPart, slug); ok {
			return true
		}
		_, ok := sitedesign.Starter(sitedesign.KindPart, slug)
		return ok
	}

	for _, row := range plan.rows {
		live := plan.liveDoc(row)
		if live == nil {
			continue
		}
		problem := SiteDesignProblem{ID: row.ID, Kind: row.Kind, Slug: row.Slug}
		doc, err := parseStoredBlockDoc(live)
		if err != nil {
			problem.Code, problem.Reason = siteDesignTemplateInvalid, "the blocks can't be read"
			problems = append(problems, problem)
			continue
		}
		if plan.changes[row.ID] == siteTemplateChangePublish {
			// The store already checked it; re-checked because the build may have
			// changed since (a theme or plugin block uninstalled).
			checked := doc
			if err := checked.prepareForStoreAs(server.themeBlocks, blockDocKind(row.Kind)); err != nil {
				problem.Code, problem.Reason = siteDesignTemplateInvalid, err.Error()
				problems = append(problems, problem)
				continue
			}
			if row.Kind == sitedesign.KindTemplate && blockDocIsEmpty(doc) {
				problem.Code, problem.Reason = siteDesignTemplateEmpty, "the template has no blocks"
				problems = append(problems, problem)
				continue
			}
		}
		if row.Kind != sitedesign.KindTemplate {
			continue
		}
		for _, part := range templatePartSlugs(doc) {
			if !resolves(part) {
				problems = append(problems, SiteDesignProblem{
					Code: siteDesignPartUnresolved, ID: row.ID, Kind: row.Kind, Slug: row.Slug, Part: part,
					Reason: fmt.Sprintf("the part %q is neither customized, shipped by the theme nor a core starter", part),
				})
			}
		}
	}
	return problems
}

// siteDesignTheme reads the active theme, answering the request itself when ok is false.
func (server *Server) siteDesignTheme(c *gin.Context) (db.Theme, bool) {
	theme, err := server.store.GetActiveTheme(c)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active theme found"})
			return db.Theme{}, false
		}
		server.requestLog(c).Error("site_design_read_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get active theme"})
		return db.Theme{}, false
	}
	return theme, true
}

// listSiteDesignRows reads a theme's templates and parts, answering a 500 itself.
func (server *Server) listSiteDesignRows(c *gin.Context, theme string) ([]db.SiteTemplate, bool) {
	rows, err := server.store.ListSiteTemplatesByTheme(c, theme)
	if err != nil {
		server.requestLog(c).Error("site_design_read_failed", "theme", theme, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the site design"})
		return nil, false
	}
	return rows, true
}

// flushSiteDesign asks the collab server to store every custom template and part of the
// theme now (8.2 step 1), outside any transaction, so block_doc holds every edit made
// before the publish. A reset row's working copy isn't published, so it isn't flushed.
// The first failure stops it: nothing is published (as for posts, #206).
func (server *Server) flushSiteDesign(c *gin.Context, rows []db.SiteTemplate) (db.SiteTemplate, error) {
	for _, row := range rows {
		if row.WorkingState == siteTemplateReset {
			continue
		}
		if err := server.flushCollabTemplate(c.Request.Context(), row.ID, requestIDFromContext(c)); err != nil {
			return row, err
		}
	}
	return db.SiteTemplate{}, nil
}

// publishedSiteTemplateHook is the hook PublishSiteDesignTx runs inside its transaction
// for every row it publishes (design 8.2: "sync site_template_media's published rows").
// #496 ("Used in" for templates) returns its sync here; nil until then.
func (server *Server) publishedSiteTemplateHook() func(ctx context.Context, q *db.Queries, row db.SiteTemplate) error {
	return nil
}

// maxActivitySlugs caps the slugs site_design_published lists, so its payload stays
// under the activity table's 1 KiB (the release's summary has them all).
const maxActivitySlugs = 8

// publishSiteDesign handles POST /site-design/publish (admin, design 8.2): it publishes
// every item of the active theme with unpublished changes, together. The body is
// `{confirm_contrast}`, as for #485's styles-only publish, which this generalizes, and
// the response keeps that one's keys (global_styles is null when the styles had no
// changes).
//
//  1. Outside any transaction: flush every custom template and part (503
//     collab_unavailable naming it, nothing published), read the rows again, then
//     validate: nothing changed → 409 nothing_to_publish; a template or part that fails
//     → 409 design_invalid with `problems` (template_empty, template_invalid,
//     part_unresolved); the styles as #485 did (styles_invalid, global_styles_unsupported,
//     and contrast_unconfirmed with `pairs` unless confirm_contrast: it asks, never
//     refuses).
//  2. PublishSiteDesignTx: the theme's rows locked and checked against what was
//     validated (409 design_changed / styles_changed if they moved), one release, a
//     version for each changed item only, the published copies (a reset publishes NULL).
//     It makes no network call.
//  3. After commit: the public cache purge (purgePublicCacheAfterWrite: this route is in
//     publicCachePurgeRoutes; a failed purge is logged and never fails the publish) and
//     site_design_published on the release.
func (server *Server) publishSiteDesign(c *gin.Context) {
	var req PublishSiteDesignRequest
	if !bindOptionalJSON(c, &req) {
		return
	}
	theme, ok := server.siteDesignTheme(c)
	if !ok {
		return
	}
	rows, ok := server.listSiteDesignRows(c, theme.Slug)
	if !ok {
		return
	}
	if failed, err := server.flushSiteDesign(c, rows); err != nil {
		server.requestLog(c).Warn("collab flush before site design publish failed", "template_id", failed.ID, "error", err)
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": fmt.Sprintf("the collaboration server could not save the latest edits to %s %q; nothing was published, try again", failed.Kind, failed.Slug),
			"code":  codeCollabSaveFailed,
			"id":    failed.ID,
			"kind":  failed.Kind,
			"slug":  failed.Slug,
		})
		return
	}
	// Read again: the flush may have stored edits.
	if rows, ok = server.listSiteDesignRows(c, theme.Slug); !ok {
		return
	}
	plan := newSiteDesignPlan(rows)

	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	draft := decodeStoredStyles(state.row.Draft)
	published := decodeStoredStyles(state.row.Published)
	stylesChanged := !reflect.DeepEqual(draft, published)
	if !stylesChanged && len(plan.changes) == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "the site design has no unpublished changes", "code": "nothing_to_publish"})
		return
	}

	if problems := server.validateSiteDesignPlan(theme, plan); len(problems) > 0 {
		c.JSON(http.StatusConflict, gin.H{
			"error":    siteDesignProblemsMessage(problems),
			"code":     "design_invalid",
			"problems": problems,
		})
		return
	}

	var (
		groups   []string
		failures []ContrastFailure
	)
	if stylesChanged {
		if !globalStylesSupported(state.tokens, state.known) {
			respondGlobalStylesUnsupported(c, state.theme)
			return
		}
		if _, verr := ValidateGlobalStyles(emptyObjectIfBlank(state.row.Draft), state.tokens); verr != nil {
			c.JSON(http.StatusConflict, gin.H{
				"error":  "the styles draft no longer fits the theme: " + verr.Error(),
				"code":   "styles_invalid",
				"reason": verr.Code,
				"path":   verr.Path,
			})
			return
		}
		failures = globalStyleContrast(state.tokens, draft)
		if len(failures) > 0 && !req.ConfirmContrast {
			c.JSON(http.StatusConflict, gin.H{
				"error": "some colour pairs fail contrast; publish again with confirm_contrast to publish anyway",
				"code":  "contrast_unconfirmed",
				"pairs": failures,
			})
			return
		}
		groups = changedGlobalStyleGroups(published, draft)
	}

	changed := plan.changed()
	items := make([]map[string]any, 0, len(changed))
	publish := make([]int64, 0, len(changed))
	for _, row := range changed {
		publish = append(publish, row.ID)
		items = append(items, map[string]any{"id": row.ID, "kind": row.Kind, "slug": row.Slug, "reset": plan.changes[row.ID] == siteTemplateChangeReset})
	}
	summaryData := map[string]any{"templates": items}
	if stylesChanged {
		summaryData["global_styles"] = map[string]any{"groups": groups, "contrast_failures": len(failures)}
	}
	summary, err := json.Marshal(summaryData)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to publish the site design"})
		return
	}
	stamps := make([]db.SiteTemplateStamp, 0, len(rows))
	for _, row := range rows {
		stamps = append(stamps, db.StampOf(row))
	}
	params := db.PublishSiteDesignTxParams{
		ThemeSlug:         theme.Slug,
		PublishedBy:       sql.NullInt64{Int64: getAuthPayload(c).UserID, Valid: true},
		Summary:           summary,
		Rows:              stamps,
		Publish:           publish,
		PublishedTemplate: server.publishedSiteTemplateHook(),
	}
	if stylesChanged {
		revision := state.row.DraftRevision
		params.StylesDraftRevision = &revision
	}

	result, err := server.store.PublishSiteDesignTx(c, params)
	switch {
	case errors.Is(err, db.ErrGlobalStylesChanged):
		if current, ok := server.loadGlobalStylesState(c); ok {
			respondStylesChanged(c, current.response())
		}
		return
	case errors.Is(err, db.ErrSiteDesignChanged):
		c.JSON(http.StatusConflict, gin.H{"error": "the site design changed while it was being published; nothing was published, publish again", "code": "design_changed"})
		return
	case err != nil:
		server.requestLog(c).Error("site_design_publish_failed", "theme", theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to publish the site design"})
		return
	}

	response := SiteDesignPublishResponse{
		Release: SiteDesignReleaseResponse{
			ID:          result.Release.ID,
			ThemeSlug:   result.Release.ThemeSlug,
			PublishedAt: result.Release.PublishedAt.Format(time.RFC3339),
		},
		Templates: make([]SiteTemplatePublished, 0, len(result.Templates)),
	}
	if result.Styles != nil {
		state.row = *result.Styles
		response.GlobalStyles = &GlobalStylesPublished{VersionNo: result.StylesVersion.VersionNo, Groups: groups, ContrastFailures: len(failures)}
	}
	response.Styles = state.response()

	payload := map[string]any{"theme_slug": theme.Slug}
	var templates, parts, resets int
	slugs := []string{}
	for _, item := range result.Templates {
		published := SiteTemplatePublished{ID: item.Template.ID, Kind: item.Template.Kind, Slug: item.Template.Slug, Title: item.Template.Title,
			VersionNo: item.Version.VersionNo, Reset: !item.Version.BlockDoc.Valid}
		response.Templates = append(response.Templates, published)
		if item.Template.Kind == sitedesign.KindPart {
			parts++
		} else {
			templates++
		}
		if published.Reset {
			resets++
		}
		if len(slugs) < maxActivitySlugs {
			slugs = append(slugs, item.Template.Kind+":"+item.Template.Slug)
		}
	}
	payload["templates"] = templates
	payload["parts"] = parts
	payload["resets"] = resets
	payload["slugs"] = slugs
	if result.Styles != nil {
		payload["global_styles_groups"] = groups
		payload["contrast_failures"] = len(failures)
	}
	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivitySiteDesignPublished,
		ObjectType: db.ActivityObjectSiteDesign,
		ObjectID:   result.Release.ID,
		Payload:    payload,
	})
	c.JSON(http.StatusOK, response)
}

// siteDesignProblemsMessage is design_invalid's error: the first problem, and how many more.
func siteDesignProblemsMessage(problems []SiteDesignProblem) string {
	first := problems[0]
	var message string
	switch first.Code {
	case siteDesignTemplateEmpty:
		message = fmt.Sprintf("the %s %q is empty", first.Kind, first.Slug)
	case siteDesignPartUnresolved:
		message = fmt.Sprintf("the %s %q uses the part %q, which doesn't exist", first.Kind, first.Slug, first.Part)
	default:
		message = fmt.Sprintf("the %s %q can't be published: %s", first.Kind, first.Slug, first.Reason)
	}
	if len(problems) > 1 {
		message += fmt.Sprintf(" (and %d more)", len(problems)-1)
	}
	return "nothing was published: " + strings.TrimSpace(message)
}
