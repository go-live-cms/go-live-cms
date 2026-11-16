package api

// Block templates and parts a theme ships (#490, docs/design/theme-builder.md 5.7).
//
// A theme may ship templates/<slug>.json and parts/<slug>.json: Block Spec v1 docs with a
// small header ({"title": "Header", "doc": {…}}, sitedesign.ParseFile). The startup scan
// reads them next to page_templates (ScanThemesDirectory), then, once the block manifests
// are loaded (theme and plugin blocks), validates each with prepareForStoreAs and its
// kind's rules (applyThemeBlockTemplates) and stores the valid ones in the theme's config
// as `block_templates` and `block_parts`: slug → {title, doc, hash}. A shipped block
// template is that theme's default for its slug; "Customize" (POST /site-design/templates
// with from: "theme") copies it. A file that doesn't validate is left out with a warning,
// and so is a theme's whole directory past maxThemeBlockTemplates files.
//
// A theme that ships a block template and a code layout for the same slug gets a scan
// warning: the block template wins (design 3.2, 5.7).

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
)

// maxThemeBlockTemplates caps how many files of one kind a theme's scan reads.
const maxThemeBlockTemplates = 200

// themeBlockTemplateFile is one templates/ or parts/ file as the scan read it, not yet
// validated.
type themeBlockTemplateFile struct {
	Kind string
	Slug string
	Raw  []byte
}

// ThemeBlockTemplate is a validated shipped template or part, as the theme's config holds
// it (config.block_templates / config.block_parts, by slug).
type ThemeBlockTemplate struct {
	Title string          `json:"title"`
	Doc   json.RawMessage `json:"doc"`
	// Hash is sitedesign.Hash of Doc: a customized row keeps it as source_hash.
	Hash string `json:"hash"`
}

// readThemeBlockTemplates reads a theme's templates/*.json and parts/*.json. Names that
// aren't slugs, directories, symlinks and unreadable files are skipped with a warning.
func readThemeBlockTemplates(themeSlug, themePath string) []themeBlockTemplateFile {
	var files []themeBlockTemplateFile
	for _, dir := range []struct{ kind, name string }{{sitedesign.KindTemplate, "templates"}, {sitedesign.KindPart, "parts"}} {
		entries, err := os.ReadDir(filepath.Join(themePath, dir.name))
		if err != nil {
			continue // a theme without the directory ships none
		}
		count := 0
		for _, entry := range entries {
			slug, ok := strings.CutSuffix(entry.Name(), ".json")
			if !ok || entry.IsDir() {
				continue
			}
			if !entry.Type().IsRegular() || !sitedesign.SlugPattern.MatchString(slug) {
				slog.Warn("skipping theme block template: not a slug or not a file", "theme", themeSlug, "kind", dir.kind, "file", entry.Name())
				continue
			}
			if count++; count > maxThemeBlockTemplates {
				slog.Warn("skipping theme block templates: too many files", "theme", themeSlug, "kind", dir.kind, "max", maxThemeBlockTemplates)
				break
			}
			path := filepath.Join(themePath, dir.name, entry.Name())
			if info, err := os.Stat(path); err != nil || info.Size() > sitedesign.MaxFileBytes {
				slog.Warn("skipping theme block template: unreadable or too large", "theme", themeSlug, "kind", dir.kind, "slug", slug)
				continue
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				slog.Warn("skipping theme block template: unreadable", "theme", themeSlug, "kind", dir.kind, "slug", slug, "error", err)
				continue
			}
			files = append(files, themeBlockTemplateFile{Kind: dir.kind, Slug: slug, Raw: raw})
		}
	}
	return files
}

// validateThemeBlockTemplate parses one shipped file and runs the store's checks for its
// kind on the doc, returning the doc as it would be stored.
func validateThemeBlockTemplate(file themeBlockTemplateFile, themeBlocks ThemeBlockManifest) (ThemeBlockTemplate, error) {
	parsed, err := sitedesign.ParseFile(file.Raw)
	if err != nil {
		return ThemeBlockTemplate{}, err
	}
	var doc BlockDocV1
	if err := json.Unmarshal(parsed.Doc, &doc); err != nil {
		return ThemeBlockTemplate{}, err
	}
	if err := doc.prepareForStoreAs(themeBlocks, blockDocKind(file.Kind)); err != nil {
		return ThemeBlockTemplate{}, err
	}
	normalized, err := json.Marshal(doc)
	if err != nil {
		return ThemeBlockTemplate{}, err
	}
	return ThemeBlockTemplate{Title: parsed.Title, Doc: normalized, Hash: sitedesign.Hash(normalized)}, nil
}

// applyThemeBlockTemplates validates each theme's scanned files against themeBlocks and
// puts the valid ones in its config (block_templates, block_parts). Call it after the
// theme and plugin block manifests are loaded, before SyncThemesToDatabase.
func applyThemeBlockTemplates(themes []DiscoveredTheme, themeBlocks ThemeBlockManifest) {
	for i := range themes {
		theme := &themes[i]
		templates := map[string]ThemeBlockTemplate{}
		parts := map[string]ThemeBlockTemplate{}
		for _, file := range theme.BlockTemplateFiles {
			valid, err := validateThemeBlockTemplate(file, themeBlocks)
			if err != nil {
				slog.Warn("skipping theme block template: invalid", "theme", theme.Slug, "kind", file.Kind, "slug", file.Slug, "error", err)
				continue
			}
			if file.Kind == sitedesign.KindPart {
				parts[file.Slug] = valid
				continue
			}
			templates[file.Slug] = valid
			if layout, ok := codeLayoutForSlug(theme.Path, file.Slug); ok {
				slog.Warn("theme ships a block template and a code layout for one slug; the block template wins",
					"theme", theme.Slug, "slug", file.Slug, "layout", layout)
			}
		}
		if len(templates) == 0 && len(parts) == 0 {
			continue
		}
		if theme.Config == nil {
			theme.Config = map[string]interface{}{}
		}
		if len(templates) > 0 {
			theme.Config["block_templates"] = templates
		}
		if len(parts) > 0 {
			theme.Config["block_parts"] = parts
		}
	}
}

// codeLayoutForSlug is the theme's own code layout at the same rank as a template slug
// (design 3.2's table), when the theme has that file: the layout a shipped block template
// replaces. Slugs with no code layout at their rank (front-page, archive-{type},
// custom-{name}) have none.
func codeLayoutForSlug(themePath, slug string) (string, bool) {
	var candidates []string
	switch {
	case slug == "home", slug == "archive", slug == "author", slug == "search":
		candidates = []string{filepath.Join("layouts", slug)}
	case slug == "404":
		candidates = []string{filepath.Join("layouts", "error")}
	case slug == "single":
		candidates = []string{filepath.Join("layouts", "post")}
	case strings.HasPrefix(slug, "single-"):
		candidates = []string{filepath.Join("layouts", strings.TrimPrefix(slug, "single-"))}
	case slug == "page":
		candidates = []string{filepath.Join("layouts", "page", "default.astro")}
	case strings.HasPrefix(slug, "page-"):
		candidates = []string{filepath.Join("layouts", "page", strings.TrimPrefix(slug, "page-")+".astro")}
	case strings.HasPrefix(slug, "taxonomy-"):
		candidates = []string{filepath.Join("layouts", "term")}
	}
	for _, candidate := range candidates {
		info, err := os.Stat(filepath.Join(themePath, candidate))
		if err != nil {
			continue
		}
		if !info.IsDir() {
			return filepath.ToSlash(candidate), true
		}
		// A layout directory counts when it holds an .astro file.
		entries, _ := os.ReadDir(filepath.Join(themePath, candidate))
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".astro") {
				names = append(names, entry.Name())
			}
		}
		if len(names) > 0 {
			sort.Strings(names)
			return filepath.ToSlash(filepath.Join(candidate, names[0])), true
		}
	}
	return "", false
}

// themeBlockTemplateFromConfig reads a shipped template or part out of a theme's stored
// config (what applyThemeBlockTemplates put there), for "Customize" from the theme
// default. ok is false when the theme ships none for the slug or the config can't be read.
func themeBlockTemplateFromConfig(config json.RawMessage, kind, slug string) (ThemeBlockTemplate, bool) {
	key := "block_templates"
	if kind == sitedesign.KindPart {
		key = "block_parts"
	}
	template, ok := shippedBlockTemplates(config, key)[slug]

	if !ok || len(template.Doc) == 0 {
		return ThemeBlockTemplate{}, false
	}
	return template, true
}
