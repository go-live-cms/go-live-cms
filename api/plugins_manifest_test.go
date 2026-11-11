package api

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The plugin.json cases shared with the admin's validator (manifest.test.ts).
const pluginManifestVectorsPath = "../web/gl-admin/lib/plugins/pluginManifestVectors.json"

// TestPluginManifestVectors runs the shared cases: both validators must accept and
// refuse the same manifests and name the same field, or the web build and the API's
// scan would disagree about what is installed.
func TestPluginManifestVectors(t *testing.T) {
	raw, err := os.ReadFile(pluginManifestVectorsPath)
	require.NoError(t, err)
	var vectors struct {
		Base  map[string]any `json:"base"`
		Cases []struct {
			Name    string          `json:"name"`
			Valid   bool            `json:"valid"`
			Field   string          `json:"field"`
			Dir     string          `json:"dir"`
			Set     map[string]any  `json:"set"`
			Replace json.RawMessage `json:"replace"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors.Cases)
	baseID, _ := vectors.Base["id"].(string)

	for _, tc := range vectors.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			// The case's manifest, built as manifest.test.ts builds it.
			manifest := tc.Replace
			if len(manifest) == 0 {
				merged := map[string]any{}
				for key, value := range vectors.Base {
					merged[key] = value
				}
				for key, value := range tc.Set {
					if value == nil {
						delete(merged, key)
					} else {
						merged[key] = value
					}
				}
				manifest, err = json.Marshal(merged)
				require.NoError(t, err)
			}
			dir := tc.Dir
			if dir == "" {
				dir = baseID
			}

			parsed, normalized, err := ParsePluginManifest(manifest, dir)
			if tc.Valid {
				require.NoError(t, err)
				require.Equal(t, dir, parsed.ID)
				require.True(t, json.Valid(normalized))
				return
			}
			var problem *PluginManifestError
			require.True(t, errors.As(err, &problem), "want a PluginManifestError, got %v", err)
			require.Equal(t, tc.Field, problem.Field, problem.Error())
		})
	}
}

// TestRepositoryPluginsValidate: a plugin in the repository that fails the validator
// fails CI (manifest.test.ts checks the same directory).
func TestRepositoryPluginsValidate(t *testing.T) {
	plugins, err := ScanPluginsDirectory(filepath.Join("..", "web", "plugins"))
	require.NoError(t, err, "web/plugins must exist: the API image copies it")
	for _, plugin := range plugins {
		require.NoError(t, plugin.Err, "web/plugins/%s", plugin.Slug)
		require.NotEmpty(t, plugin.ContentHash, plugin.Slug)
	}
}

func TestParsePluginManifest(t *testing.T) {
	t.Run("not JSON", func(t *testing.T) {
		_, _, err := ParsePluginManifest([]byte(`{"id":`), "x")
		require.EqualError(t, err, "plugin.json is not valid JSON")
	})

	t.Run("typed and normalized", func(t *testing.T) {
		manifest, normalized, err := ParsePluginManifest([]byte(`{
			"manifest_version": 1, "id": "seo-kit", "name": "SEO kit", "version": "0.1.0", "plugin_api": 1,
			"capabilities": ["posts:read", "network"],
			"settings": {"key": {"type": "string", "secret": true, "label": "Key"}, "limit": {"type": "number", "integer": true, "minimum": 1, "default": 3}},
			"server": {"hooks": [{"event": "post.before_publish", "on_error": "deny", "priority": 5}, {"event": "post.saved", "timeout_ms": 2000}]}
		}`), "seo-kit")
		require.NoError(t, err)
		require.Equal(t, "SEO kit", manifest.Name)
		require.Equal(t, []string{"posts:read", "network"}, manifest.Capabilities)
		require.True(t, manifest.Settings["key"].Secret)
		require.Equal(t, "Key", manifest.Settings["key"].Label)
		require.Equal(t, float64(3), manifest.Settings["limit"].Default)
		require.True(t, manifest.Settings["limit"].Integer)
		require.Equal(t, []PluginHook{
			{Event: "post.before_publish", OnError: "deny", Priority: 5},
			{Event: "post.saved", TimeoutMS: 2000},
		}, manifest.Server.Hooks)
		require.NotContains(t, string(normalized), "\n")
	})

	t.Run("error text names the field", func(t *testing.T) {
		_, _, err := ParsePluginManifest([]byte(`{"manifest_version": 2}`), "x")
		require.EqualError(t, err, "plugin.json: manifest_version must be 1")
	})
}

func TestPluginAPICompatible(t *testing.T) {
	require.True(t, pluginAPICompatible(PluginAPIMin))
	require.True(t, pluginAPICompatible(PluginAPIMax))
	require.False(t, pluginAPICompatible(PluginAPIMin-1))
	require.False(t, pluginAPICompatible(PluginAPIMax+1))
}

// writePlugin creates web/plugins/<slug>/ under root with the given plugin.json (none
// when manifest is "") and extra files (relative path → content).
func writePlugin(t *testing.T, root, slug, manifest string, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(root, slug)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	if manifest != "" {
		require.NoError(t, os.WriteFile(filepath.Join(dir, pluginManifestFile), []byte(manifest), 0o644))
	}
	for name, content := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
	}
	return dir
}

func pluginJSON(slug, version string, api int, extra string) string {
	manifest := map[string]any{
		"manifest_version": 1, "id": slug, "name": "Plugin " + slug, "version": version, "plugin_api": api,
		"author": "Tester", "description": "A fixture plugin.",
	}
	raw, _ := json.Marshal(manifest)
	if extra == "" {
		return string(raw)
	}
	return strings.TrimSuffix(string(raw), "}") + "," + extra + "}"
}

func TestPluginContentHash(t *testing.T) {
	root := t.TempDir()
	dir := writePlugin(t, root, "hashed", pluginJSON("hashed", "1.0.0", 1, ""), map[string]string{
		"README.md":                "# Hashed",
		"blocks/Note/block.json":   "{}",
		"server/hooks.go":          "package server",
		"blocks/Note/render.tsx":   "export {}",
		"blocks/Note/nested/a.txt": "a",
	})

	first, err := pluginContentHash(dir)
	require.NoError(t, err)
	require.Regexp(t, `^[0-9a-f]{64}$`, first)
	again, err := pluginContentHash(dir)
	require.NoError(t, err)
	require.Equal(t, first, again, "deterministic")

	// The same files elsewhere hash the same: the path is relative to the plugin.
	copyDir := writePlugin(t, t.TempDir(), "hashed", pluginJSON("hashed", "1.0.0", 1, ""), map[string]string{
		"blocks/Note/nested/a.txt": "a",
		"blocks/Note/render.tsx":   "export {}",
		"server/hooks.go":          "package server",
		"blocks/Note/block.json":   "{}",
		"README.md":                "# Hashed",
	})
	copied, err := pluginContentHash(copyDir)
	require.NoError(t, err)
	require.Equal(t, first, copied)

	// Any change to a file's content, or a new file, or a rename, changes it.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Hashed!"), 0o644))
	edited, err := pluginContentHash(dir)
	require.NoError(t, err)
	require.NotEqual(t, first, edited)

	require.NoError(t, os.WriteFile(filepath.Join(dir, "NOTES"), []byte(""), 0o644))
	added, err := pluginContentHash(dir)
	require.NoError(t, err)
	require.NotEqual(t, edited, added)

	require.NoError(t, os.Rename(filepath.Join(dir, "NOTES"), filepath.Join(dir, "NOTES2")))
	renamed, err := pluginContentHash(dir)
	require.NoError(t, err)
	require.NotEqual(t, added, renamed)

	_, err = pluginContentHash(filepath.Join(root, "absent"))
	require.Error(t, err)
}

func TestScanPluginsDirectory(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "good", pluginJSON("good", "1.0.0", 1, `"blocks":["Note"]`), map[string]string{"blocks/Note/block.json": "{}"})
	writePlugin(t, root, "future", pluginJSON("future", "3.0.0", 99, ""), nil)
	writePlugin(t, root, "wrong-id", pluginJSON("other", "1.0.0", 1, ""), nil)
	writePlugin(t, root, "no-block-dir", pluginJSON("no-block-dir", "1.0.0", 1, `"blocks":["Missing"]`), nil)
	writePlugin(t, root, "huge", `{"name":"`+strings.Repeat("x", pluginManifestMaxBytes)+`"}`, nil)
	writePlugin(t, root, "not-a-plugin", "", map[string]string{"README.md": "no manifest"})
	writePlugin(t, root, ".hidden", pluginJSON(".hidden", "1.0.0", 1, ""), nil)
	require.NoError(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("the directory's readme"), 0o644))
	// A symlinked plugin directory isn't followed (the image has real files only).
	linked := writePlugin(t, t.TempDir(), "linked", pluginJSON("linked", "1.0.0", 1, ""), nil)
	if err := os.Symlink(linked, filepath.Join(root, "linked")); err != nil {
		t.Logf("no symlink support here: %v", err)
	}

	plugins, err := ScanPluginsDirectory(root)
	require.NoError(t, err)
	bySlug := map[string]DiscoveredPlugin{}
	for _, plugin := range plugins {
		bySlug[plugin.Slug] = plugin
	}
	require.Len(t, bySlug, 5, "hidden directories, directories without plugin.json and files are not plugins")

	good := bySlug["good"]
	require.NoError(t, good.Err)
	require.Equal(t, "Plugin good", good.Manifest.Name)
	require.Equal(t, []string{"Note"}, good.Manifest.Blocks)
	require.NotEmpty(t, good.ManifestJSON)
	require.Regexp(t, `^[0-9a-f]{64}$`, good.ContentHash)

	// An incompatible plugin_api is valid; the sync decides its status.
	require.NoError(t, bySlug["future"].Err)
	require.Equal(t, 99, bySlug["future"].Manifest.PluginAPI)

	for slug, field := range map[string]string{"wrong-id": "id", "no-block-dir": "blocks[0]", "huge": ""} {
		var problem *PluginManifestError
		require.True(t, errors.As(bySlug[slug].Err, &problem), "%s: %v", slug, bySlug[slug].Err)
		require.Equal(t, field, problem.Field, slug)
		require.NotEmpty(t, bySlug[slug].ContentHash, "an invalid plugin is still hashed, so it can be marked")
	}

	_, err = ScanPluginsDirectory(filepath.Join(root, "absent"))
	require.Error(t, err)
}
