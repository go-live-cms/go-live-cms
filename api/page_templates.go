// Package api — Page templates (#336)
//
// A page picks one of the active theme's page layouts, themes/<slug>/layouts/page/
// <name>.astro, as its template. posts.page_template stores the name ("" = the
// theme's default for pages; "default" is stored as ""). It is a post setting
// (#358, 000045): golive_post_settings() snapshots it, so on a published page a new
// template reaches the site on Update, and /public answers the published one.
//
// Which templates a theme has comes from the theme scan (themes_scanner.go): the
// .astro files in layouts/page/, named and described by theme.config.ts's
// layouts.page entries ({ file, label, description }), stored as the theme's
// config.page_templates. PUT /posts/:id/template accepts only a name the active
// theme has. The public site resolves the name against its own build (the layout
// globs); a page whose template the active theme doesn't have (after a theme
// switch) is rendered with the default layout and keeps its name, so switching
// back brings it back.
//
// Builder page templates (#494, docs/design/theme-builder.md section 10): a page may
// also pick a page template made in the Site editor, the active theme's published site
// template of slug custom-<name> (#490). It is stored as block:<name> (000062 widened
// the CHECK; a layout file's name can't hold a ':'), a reference by name only: a
// template reset, deleted or of another theme leaves the name in place, the page renders
// with the default and picks it up again once it's published, as after a theme switch.
// PUT /posts/:id/template accepts one only while it is published; GET
// /posts/page-templates lists both kinds for the Template field.
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// defaultPageTemplate is the layout every theme has (layouts/page/default.astro).
const defaultPageTemplate = "default"

// pageTemplateNameRe is a template name: a layout file's name without .astro. The
// same rule as the posts_page_template_name CHECK (000045), which also allows "".
var pageTemplateNameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// A stored builder page template (#494) is block:<name>, and renders the active theme's
// site template custom-<name>.
const (
	builderPageTemplatePrefix = "block:"
	customPageTemplateSlug    = "custom-"
)

// builderPageTemplateNameRe is a builder page template's <name>: the same rule as
// 000062's CHECK. A custom-<name> slug the site template CHECK allows but this doesn't
// (an underscore) can't be picked.
var builderPageTemplateNameRe = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// builderPageTemplateName is the <name> of a stored block:<name>, or "" when the value
// isn't a builder page template.
func builderPageTemplateName(stored string) string {
	name, ok := strings.CutPrefix(stored, builderPageTemplatePrefix)
	if !ok || !builderPageTemplateNameRe.MatchString(name) {
		return ""
	}
	return name
}

// BuilderPageTemplate is a published Site editor page template, as the Template field
// lists it: Name is the stored value (block:<name>), Label the template's title.
type BuilderPageTemplate struct {
	Name  string `json:"name"`
	Label string `json:"label"`
}

// builderPageTemplates are the rows of ListPublishedCustomPageTemplates a page can
// store: every custom-<name> whose <name> fits block:<name>, labelled by its title.
func builderPageTemplates(rows []db.ListPublishedCustomPageTemplatesRow) []BuilderPageTemplate {
	templates := []BuilderPageTemplate{}
	for _, row := range rows {
		name, ok := strings.CutPrefix(row.Slug, customPageTemplateSlug)
		if !ok || !builderPageTemplateNameRe.MatchString(name) {
			continue
		}
		label := strings.TrimSpace(row.Title)
		if label == "" {
			label = humanizeTemplateName(name)
		}
		templates = append(templates, BuilderPageTemplate{Name: builderPageTemplatePrefix + name, Label: label})
	}
	return templates
}

// PageTemplate is one of a theme's page layouts, as the admin's template picker
// lists it.
type PageTemplate struct {
	Name        string `json:"name"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// scanPageTemplates lists a theme's page templates: every layouts/page/*.astro
// file, "default" first, then in the order theme.config.ts declares them, then the
// undeclared ones by name. A declared layout without its file is left out (it
// can't be rendered); a file without a declaration is labelled from its name.
func scanPageTemplates(themePath, configStr string) []PageTemplate {
	entries, err := os.ReadDir(filepath.Join(themePath, "layouts", "page"))
	if err != nil {
		return nil
	}
	files := map[string]bool{}
	for _, entry := range entries {
		name, ok := strings.CutSuffix(entry.Name(), ".astro")
		if entry.IsDir() || !ok || !pageTemplateNameRe.MatchString(name) {
			continue
		}
		files[name] = true
	}

	templates := []PageTemplate{}
	added := map[string]bool{}
	add := func(t PageTemplate) {
		if !files[t.Name] || added[t.Name] {
			return
		}
		added[t.Name] = true
		if t.Label == "" {
			t.Label = humanizeTemplateName(t.Name)
		}
		templates = append(templates, t)
	}

	declared := parseDeclaredPageLayouts(configStr)
	for _, t := range declared {
		if t.Name == defaultPageTemplate {
			add(t)
		}
	}
	add(PageTemplate{Name: defaultPageTemplate})
	for _, t := range declared {
		if !files[t.Name] {
			slog.Warn("theme declares a page layout without its file", "layout", t.Name, "path", themePath)
		}
		add(t)
	}
	rest := []string{}
	for name := range files {
		if !added[name] {
			rest = append(rest, name)
		}
	}
	sort.Strings(rest)
	for _, name := range rest {
		add(PageTemplate{Name: name})
	}
	return templates
}

var (
	pageLayoutsBlockRe = regexp.MustCompile(`\bpage\s*:\s*\{`)
	layoutEntryRe      = regexp.MustCompile(`["']?([A-Za-z0-9_-]+)["']?\s*:\s*\{([^{}]*)\}`)
	layoutLabelRe      = regexp.MustCompile(`\blabel\s*:\s*["']([^"']*)["']`)
	layoutDescRe       = regexp.MustCompile(`\bdescription\s*:\s*["']([^"']*)["']`)
)

// parseDeclaredPageLayouts reads theme.config.ts's page layouts, in order:
//
//	layouts: { page: { default: { file: "...", label: "Default", description: "..." }, ... } }
//
// The first `page: {` block with entries wins (the ThemeConfig interface declares
// `page: Record<...>`, without a brace). The simple form `page: { default:
// "default", variants: [...] }` names no labels: nil, and the files decide.
func parseDeclaredPageLayouts(configStr string) []PageTemplate {
	for _, loc := range pageLayoutsBlockRe.FindAllStringIndex(configStr, -1) {
		block := braceBlock(configStr, loc[1]-1)
		var templates []PageTemplate
		for _, m := range layoutEntryRe.FindAllStringSubmatch(block, -1) {
			t := PageTemplate{Name: m[1]}
			if l := layoutLabelRe.FindStringSubmatch(m[2]); l != nil {
				t.Label = strings.TrimSpace(l[1])
			}
			if d := layoutDescRe.FindStringSubmatch(m[2]); d != nil {
				t.Description = strings.TrimSpace(d[1])
			}
			if pageTemplateNameRe.MatchString(t.Name) {
				templates = append(templates, t)
			}
		}
		if len(templates) > 0 {
			return templates
		}
	}
	return nil
}

// braceBlock is the text inside the braces opening at s[open], or the rest of s
// when they never close.
func braceBlock(s string, open int) string {
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[open+1 : i]
			}
		}
	}
	return s[open+1:]
}

// humanizeTemplateName labels a layout file: "full-width" → "Full width".
func humanizeTemplateName(name string) string {
	words := strings.Fields(strings.NewReplacer("-", " ", "_", " ").Replace(name))
	if len(words) == 0 {
		return name
	}
	label := strings.ToLower(strings.Join(words, " "))
	return strings.ToUpper(label[:1]) + label[1:]
}

// themePageTemplates reads the scan's config.page_templates from a theme row.
func themePageTemplates(config json.RawMessage) []PageTemplate {
	var parsed struct {
		PageTemplates []PageTemplate `json:"page_templates"`
	}
	if len(config) == 0 || json.Unmarshal(config, &parsed) != nil {
		return nil
	}
	return parsed.PageTemplates
}

func hasPageTemplate(templates []PageTemplate, name string) bool {
	for _, t := range templates {
		if t.Name == name {
			return true
		}
	}
	return false
}

// normalizePageTemplate is the stored form of a requested template: "" for the
// default (either spelling), else the trimmed name; ok is false when it is neither a
// template name nor a builder page template (block:<name>, #494).
func normalizePageTemplate(raw string) (name string, ok bool) {
	name = strings.TrimSpace(raw)
	if name == "" || name == defaultPageTemplate {
		return "", true
	}
	return name, pageTemplateNameRe.MatchString(name) || builderPageTemplateName(name) != ""
}

// UpdatePageTemplateRequest is the body of PUT /posts/:id/template.
type UpdatePageTemplateRequest struct {
	// A template of the active theme; "" or "default" for the theme's default;
	// block:<name> for a published Site editor page template (#494).
	PageTemplate string `json:"page_template" binding:"max=70"`
}

// updatePostPageTemplate handles PUT /posts/:id/template (#336): the page's working
// template. Who may: canEditPostDetails, like its other settings (a contributor on
// their own unpublished page). Pages only (400 template_pages_only); the name must
// be one of the active theme's page templates (400 unknown_template).
func (server *Server) updatePostPageTemplate(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	var req UpdatePageTemplateRequest
	if !bindJSON(c, &req) {
		return
	}
	name, ok := normalizePageTemplate(req.PageTemplate)
	if !ok {
		msg := "page_template must be a template name (letters, digits, - and _)"
		c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "invalid_template", "fields": gin.H{"page_template": msg}})
		return
	}

	post, loaded, ok := server.authorizeLoadPost(c, id, canEditPostDetails)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if !loaded {
		// A moderator: the owner rule passed, not the trash (#327).
		post, err = server.store.GetPost(ctx, id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
			return
		}
		if !server.checkLoadedPost(c, post, canEditPostDetails) {
			return
		}
	}
	if post.PostType != "page" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "only pages have templates", "code": "template_pages_only"})
		return
	}

	if name != "" {
		theme, err := server.store.GetActiveTheme(ctx)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the active theme"})
			return
		}
		builder := builderPageTemplateName(name)
		known := false
		if err == nil {
			if builder != "" {
				known, err = server.hasPublishedBuilderPageTemplate(c, theme.Slug, builder)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the template"})
					return
				}
			} else {
				known = hasPageTemplate(themePageTemplates(theme.Config), name)
			}
		}
		if !known {
			msg := "the active theme has no page template with this name"
			if builder != "" {
				msg = "the active theme has no published Site editor template with this name"
			}
			c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "unknown_template", "fields": gin.H{"page_template": msg}})
			return
		}
	}

	updated, err := server.store.UpdatePostPageTemplate(ctx, db.UpdatePostPageTemplateParams{ID: id, PageTemplate: name})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update the template"})
		return
	}
	server.recordPostUpdated(c, updated.ID)
	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(updated)})
}

// hasPublishedBuilderPageTemplate reports whether the theme has a published site
// template custom-<name> (#494): a working copy, a reset one (published as NULL) or a
// deleted one can't be picked.
func (server *Server) hasPublishedBuilderPageTemplate(c *gin.Context, themeSlug, name string) (bool, error) {
	row, err := server.store.GetSiteTemplateBySlug(c.Request.Context(), db.GetSiteTemplateBySlugParams{
		ThemeSlug: themeSlug,
		Kind:      "template",
		Slug:      customPageTemplateSlug + name,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return row.PublishedBlockDoc.Valid, nil
}

// PageTemplatesResponse is GET /posts/page-templates (#336, #494): what a page's
// Template field offers. Theme is the active theme (null with none), Templates its
// page layouts ("default" first), BuilderTemplates its published Site editor page
// templates by title.
type PageTemplatesResponse struct {
	Theme            *PageTemplatesTheme   `json:"theme"`
	Templates        []PageTemplate        `json:"templates"`
	BuilderTemplates []BuilderPageTemplate `json:"builder_templates"`
}

// PageTemplatesTheme names the theme whose templates are listed ("Paper's layouts").
type PageTemplatesTheme struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// listPageTemplates handles GET /posts/page-templates (#494): every content role, like
// the Template field that reads it (a contributor picks the template of their own page).
// It lists only what PUT /posts/:id/template accepts, and nothing of a builder template
// but its name and title: the Site editor's routes stay admins' own.
func (server *Server) listPageTemplates(c *gin.Context) {
	ctx := c.Request.Context()
	resp := PageTemplatesResponse{
		Templates:        []PageTemplate{{Name: defaultPageTemplate, Label: "Default"}},
		BuilderTemplates: []BuilderPageTemplate{},
	}
	theme, err := server.store.GetActiveTheme(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusOK, resp)
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the active theme"})
		return
	}
	resp.Theme = &PageTemplatesTheme{Slug: theme.Slug, Name: theme.Name}
	if templates := themePageTemplates(theme.Config); len(templates) > 0 {
		resp.Templates = templates
	}
	rows, err := server.store.ListPublishedCustomPageTemplates(ctx, theme.Slug)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list the Site editor's page templates"})
		return
	}
	resp.BuilderTemplates = builderPageTemplates(rows)
	c.JSON(http.StatusOK, resp)
}
