package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The value grammar and contrast of global styles (#485, design 6.3), against the cases
// the web's validator also runs (web/src/lib/globalStyleVectors.json).

const (
	globalStyleVectorsPath  = "../web/src/lib/globalStyleVectors.json"
	repoThemeTokenManifest  = "../web/themes/tokens.manifest.json"
	globalStylesFixtureSlug = "vectors"
)

type globalStyleVectors struct {
	Theme struct {
		Tokens      map[string]any `json:"tokens"`
		FontOptions []FontOption   `json:"font_options"`
	} `json:"theme"`
	SystemFonts []string `json:"system_fonts"`
	RawPairs    [][]any  `json:"contrast_pairs"`
	Valid       []struct {
		Name       string          `json:"name"`
		Input      json.RawMessage `json:"input"`
		Normalized json.RawMessage `json:"normalized"`
	} `json:"valid"`
	Invalid []struct {
		Name    string          `json:"name"`
		Input   json.RawMessage `json:"input"`
		Code    string          `json:"code"`
		Path    string          `json:"path"`
		Message string          `json:"message"`
	} `json:"invalid"`
	Contrast []struct {
		Name    string          `json:"name"`
		Styles  json.RawMessage `json:"styles"`
		Failing []string        `json:"failing"`
	} `json:"contrast"`
	Groups []struct {
		Name   string          `json:"name"`
		Before json.RawMessage `json:"before"`
		After  json.RawMessage `json:"after"`
		Groups []string        `json:"groups"`
	} `json:"groups"`
}

func loadGlobalStyleVectors(t *testing.T) (globalStyleVectors, ThemeTokens) {
	t.Helper()
	raw, err := os.ReadFile(globalStyleVectorsPath)
	require.NoError(t, err)
	var vectors globalStyleVectors
	require.NoError(t, json.Unmarshal(raw, &vectors))
	return vectors, ThemeTokens{SupportsGlobalStyles: true, Tokens: vectors.Theme.Tokens, FontOptions: vectors.Theme.FontOptions}
}

// fixtureThemeTokens is the vectors' theme, as a manifest for the given slug.
func fixtureThemeTokens(t *testing.T, slug string) ThemeTokenManifest {
	t.Helper()
	_, theme := loadGlobalStyleVectors(t)
	return ThemeTokenManifest{ManifestVersion: 1, Themes: map[string]ThemeTokens{slug: theme}}
}

func TestGlobalStyleVectors(t *testing.T) {
	vectors, theme := loadGlobalStyleVectors(t)

	t.Run("system fonts and contrast pairs", func(t *testing.T) {
		require.Equal(t, vectors.SystemFonts, systemFontIDs)
		require.Len(t, vectors.RawPairs, len(contrastPairs))
		for i, pair := range vectors.RawPairs {
			require.Equal(t, []any{contrastPairs[i].Foreground, contrastPairs[i].Background, contrastPairs[i].Minimum}, pair, "pair %d", i)
		}
	})

	for _, v := range vectors.Valid {
		t.Run("accepts "+v.Name, func(t *testing.T) {
			normalized, err := ValidateGlobalStyles(v.Input, theme)
			require.Nil(t, err)
			got, _, encodeErr := canonicalStyles(normalized)
			require.NoError(t, encodeErr)
			require.Equal(t, decodeStoredStyles(v.Normalized), got)
		})
	}

	for _, v := range vectors.Invalid {
		t.Run("refuses "+v.Name, func(t *testing.T) {
			_, err := ValidateGlobalStyles(v.Input, theme)
			require.NotNil(t, err)
			require.Equal(t, v.Code, err.Code)
			require.Equal(t, v.Path, err.Path)
			require.Equal(t, v.Message, err.Error())
		})
	}

	for _, v := range vectors.Contrast {
		t.Run("contrast "+v.Name, func(t *testing.T) {
			ids := []string{}
			for _, failure := range globalStyleContrast(theme, decodeStoredStyles(v.Styles)) {
				ids = append(ids, failure.ID())
			}
			require.Equal(t, v.Failing, ids)
		})
	}

	for _, v := range vectors.Groups {
		t.Run("groups "+v.Name, func(t *testing.T) {
			require.Equal(t, v.Groups, changedGlobalStyleGroups(decodeStoredStyles(v.Before), decodeStoredStyles(v.After)))
		})
	}
}

func TestGlobalStyleValidationEdges(t *testing.T) {
	_, theme := loadGlobalStyleVectors(t)

	_, err := ValidateGlobalStyles(json.RawMessage(`{"colors":`), theme)
	require.NotNil(t, err)
	require.Equal(t, globalStyleInvalidValue, err.Code)
	require.Equal(t, "must be a JSON object", err.Error())

	// A theme that declares nothing accepts nothing but the empty override.
	_, err = ValidateGlobalStyles(json.RawMessage(`{"colors":{"light":{"primary":"#000000"}}}`), ThemeTokens{})
	require.NotNil(t, err)
	require.Equal(t, globalStyleUnknownToken, err.Code)
	styles, err := ValidateGlobalStyles(json.RawMessage(`{}`), ThemeTokens{})
	require.Nil(t, err)
	require.Empty(t, styles)

	// A theme declaring a palette value as a group can't be styled there.
	odd := ThemeTokens{Tokens: map[string]any{"colors": map[string]any{"light": map[string]any{"primary": map[string]any{"x": "#000000"}}}}}
	_, err = ValidateGlobalStyles(json.RawMessage(`{"colors":{"light":{"primary":"#000000"}}}`), odd)
	require.NotNil(t, err)
	require.Equal(t, "colors.light.primary", err.Path)

	// Contrast with no colours declared, and a malformed override, is no failure.
	require.Empty(t, globalStyleContrast(ThemeTokens{}, map[string]any{"colors": "x"}))
	require.InDelta(t, 21.0, contrastRatio("#000000", "#ffffff"), 0.001)
	require.InDelta(t, 21.0, contrastRatio("#ffffff", "#000000"), 0.001)
}

func TestLoadThemeTokenManifest(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(path, []byte(body), 0o644))
		return path
	}

	manifest, found, err := LoadThemeTokenManifest(filepath.Join(dir, "missing.json"))
	require.NoError(t, err)
	require.False(t, found)
	require.Empty(t, manifest.Themes)

	for name, body := range map[string]string{
		"garbage.json":  `{`,
		"version.json":  `{"manifest_version": 2, "themes": {}}`,
		"font.json":     `{"manifest_version": 1, "themes": {"a": {"tokens": {"colors": {}}, "font_options": [{"id": "Bad Id", "stack": "x"}]}}}`,
		"nostack.json":  `{"manifest_version": 1, "themes": {"a": {"tokens": {"colors": {}}, "font_options": [{"id": "ok", "stack": ""}]}}}`,
		"nocolors.json": `{"manifest_version": 1, "themes": {"a": {"tokens": {}}}}`,
	} {
		_, found, err := LoadThemeTokenManifest(write(name, body))
		require.True(t, found, name)
		require.Error(t, err, name)
	}

	_, err = os.Stat(dir)
	require.NoError(t, err)
	_, _, err = LoadThemeTokenManifest(dir) // a directory can't be read as a file
	require.Error(t, err)
}

// The committed manifest loads, and the default theme in it accepts its own font
// options and refuses an injection, as the web's copy does.
func TestRepoThemeTokenManifest(t *testing.T) {
	manifest, found, err := LoadThemeTokenManifest(repoThemeTokenManifest)
	require.NoError(t, err)
	require.True(t, found, "web/themes/tokens.manifest.json is missing: run `npm run themes:manifest` in web/")
	theme, ok := manifest.Themes["default"]
	require.True(t, ok)
	require.True(t, theme.SupportsGlobalStyles)

	_, verr := ValidateGlobalStyles(json.RawMessage(`{"typography":{"fontFamily":{"heading":"literata","mono":"jetbrains-mono"}},"colors":{"dark":{"primary":"#3FE0B3"}}}`), theme)
	require.Nil(t, verr)
	_, verr = ValidateGlobalStyles(json.RawMessage(`{"layout":{"container":"1200px;}</style>"}}`), theme)
	require.NotNil(t, verr)
	require.Empty(t, globalStyleContrast(theme, map[string]any{}), "the default theme passes its own contrast pairs")
}
