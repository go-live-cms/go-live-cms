package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
)

func writeThemeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

const shippedTemplate = `{"title":"Single post","doc":{"doc_version":1,"blocks_order":["part-header-01","para-0000001"],"blocks":{
  "part-header-01":{"id":"part-header-01","type":"template_part","version":1,"attrs":{"slug":"header","html":"<script>"}},
  "para-0000001":{"id":"para-0000001","type":"paragraph","version":1,"attrs":{"pm":{"type":"paragraph","content":[{"type":"text","text":"Hi"}]},"text":"Hi"}}}}}`

const shippedPart = `{"title":"Header","doc":{"doc_version":1,"blocks_order":["title-000001"],"blocks":{
  "title-000001":{"id":"title-000001","type":"site_title","version":1,"attrs":{"level":1}}}}}`

const partHoldingPart = `{"title":"Nested","doc":{"doc_version":1,"blocks_order":["part-000001"],"blocks":{
  "part-000001":{"id":"part-000001","type":"template_part","version":1,"attrs":{"slug":"footer"}}}}}`

// newShippingTheme is a theme directory that ships block templates and parts (#490, design
// 5.7), next to a code layout for `single` (layouts/post).
func newShippingTheme(t *testing.T) (root, themePath string) {
	t.Helper()
	root = t.TempDir()
	themePath = filepath.Join(root, "shipping")
	writeThemeFile(t, themePath, "theme.config.ts", `export default { name: "Shipping", version: "1.0.0" }`)
	writeThemeFile(t, themePath, "layouts/post/default.astro", "<main />")
	writeThemeFile(t, themePath, "layouts/page/default.astro", "<main />")
	writeThemeFile(t, themePath, "templates/single.json", shippedTemplate)
	writeThemeFile(t, themePath, "templates/single-case_study.json", shippedTemplate)
	writeThemeFile(t, themePath, "templates/broken.json", `{"title":"Broken","doc":{"doc_version":1,"blocks_order":["missing-0001"],"blocks":{}}}`)
	writeThemeFile(t, themePath, "templates/Bad Name.json", shippedTemplate)
	writeThemeFile(t, themePath, "templates/notes.txt", "not a template")
	writeThemeFile(t, themePath, "parts/header.json", shippedPart)
	writeThemeFile(t, themePath, "parts/nested.json", partHoldingPart)
	return root, themePath
}

func TestThemeScanReadsBlockTemplatesAndParts(t *testing.T) {
	root, _ := newShippingTheme(t)
	themes, err := ScanThemesDirectory(root)
	require.NoError(t, err)
	require.Len(t, themes, 1)

	read := map[string]bool{}
	for _, file := range themes[0].BlockTemplateFiles {
		read[file.Kind+"/"+file.Slug] = true
	}
	// Names that aren't slugs and files that aren't JSON aren't read; invalid ones are
	// read, and dropped by the validation.
	require.Equal(t, map[string]bool{
		"template/single": true, "template/single-case_study": true, "template/broken": true,
		"part/header": true, "part/nested": true,
	}, read)

	applyThemeBlockTemplates(themes, ThemeBlockManifest{})
	config, err := json.Marshal(themes[0].Config)
	require.NoError(t, err)

	single, ok := themeBlockTemplateFromConfig(config, sitedesign.KindTemplate, "single")
	require.True(t, ok)
	require.Equal(t, "Single post", single.Title)
	// Stored as the store would keep it: sanitized (a part's content never survives).
	require.NotContains(t, string(single.Doc), "<script>")
	require.Equal(t, sitedesign.Hash(single.Doc), single.Hash)
	_, ok = themeBlockTemplateFromConfig(config, sitedesign.KindTemplate, "single-case_study")
	require.True(t, ok, "a slug with _ is scanned")

	_, ok = themeBlockTemplateFromConfig(config, sitedesign.KindTemplate, "broken")
	require.False(t, ok, "a doc that fails the store's checks is left out")
	header, ok := themeBlockTemplateFromConfig(config, sitedesign.KindPart, "header")
	require.True(t, ok)
	require.Equal(t, "Header", header.Title)
	_, ok = themeBlockTemplateFromConfig(config, sitedesign.KindPart, "nested")
	require.False(t, ok, "a part holding a part fails the part's rules")
	_, ok = themeBlockTemplateFromConfig(config, sitedesign.KindTemplate, "header")
	require.False(t, ok, "parts and templates are separate")
}

func TestApplyThemeBlockTemplatesLeavesThemesWithoutAny(t *testing.T) {
	themes := []DiscoveredTheme{{Slug: "plain"}}
	applyThemeBlockTemplates(themes, ThemeBlockManifest{})
	require.Nil(t, themes[0].Config)

	themes = []DiscoveredTheme{{Slug: "keeps", Config: map[string]interface{}{"menu_locations": []string{"primary"}}}}
	applyThemeBlockTemplates(themes, ThemeBlockManifest{})
	require.Equal(t, map[string]interface{}{"menu_locations": []string{"primary"}}, themes[0].Config)
}

func TestCodeLayoutForSlug(t *testing.T) {
	themePath := t.TempDir()
	for _, rel := range []string{
		"layouts/post/default.astro", "layouts/page/default.astro", "layouts/page/fullwidth.astro",
		"layouts/home/default.astro", "layouts/error/default.astro", "layouts/term/default.astro",
		"layouts/product/default.astro",
	} {
		writeThemeFile(t, themePath, rel, "<main />")
	}
	require.NoError(t, os.MkdirAll(filepath.Join(themePath, "layouts", "search"), 0o755)) // empty: no layout

	for slug, want := range map[string]string{
		"single":            "layouts/post/default.astro",
		"single-product":    "layouts/product/default.astro",
		"page":              "layouts/page/default.astro",
		"page-fullwidth":    "layouts/page/fullwidth.astro",
		"home":              "layouts/home/default.astro",
		"404":               "layouts/error/default.astro",
		"taxonomy-category": "layouts/term/default.astro",
	} {
		got, ok := codeLayoutForSlug(themePath, slug)
		require.True(t, ok, slug)
		require.Equal(t, want, got, slug)
	}
	for _, slug := range []string{"search", "archive", "author", "front-page", "archive-post", "custom-landing", "single-event", "page-wide"} {
		_, ok := codeLayoutForSlug(themePath, slug)
		require.False(t, ok, slug)
	}
}

func TestThemeBlockTemplateFromConfigBadInput(t *testing.T) {
	for _, config := range []string{``, `not json`, `{}`, `{"block_templates":[]}`, `{"block_templates":{"single":{"title":"x"}}}`} {
		_, ok := themeBlockTemplateFromConfig(json.RawMessage(config), sitedesign.KindTemplate, "single")
		require.False(t, ok, config)
	}
}

func TestThemeConfigForResponseDropsShippedDocs(t *testing.T) {
	root, _ := newShippingTheme(t)
	themes, err := ScanThemesDirectory(root)
	require.NoError(t, err)
	applyThemeBlockTemplates(themes, ThemeBlockManifest{})
	themes[0].Config["menu_locations"] = []string{"primary"}
	config, err := json.Marshal(themes[0].Config)
	require.NoError(t, err)

	out := themeConfigForResponse(config)
	require.NotContains(t, string(out), `"doc"`, "the docs stay in the stored config")
	var got struct {
		BlockTemplates map[string]map[string]string `json:"block_templates"`
		BlockParts     map[string]map[string]string `json:"block_parts"`
		MenuLocations  []string                     `json:"menu_locations"`
	}
	require.NoError(t, json.Unmarshal(out, &got))
	shipped, ok := themeBlockTemplateFromConfig(config, sitedesign.KindTemplate, "single")
	require.True(t, ok)
	require.Equal(t, map[string]string{"title": "Single post", "hash": shipped.Hash}, got.BlockTemplates["single"])
	require.Contains(t, got.BlockParts, "header")
	require.Equal(t, []string{"primary"}, got.MenuLocations)

	// Configs without shipped templates, or that don't decode, come back as stored.
	for _, raw := range []string{`{"menu_locations":["primary"]}`, `not json`, ``, `{"block_templates":[]}`} {
		require.Equal(t, raw, string(themeConfigForResponse(json.RawMessage(raw))), raw)
	}
}
