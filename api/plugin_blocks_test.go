package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Plugin content blocks (#456): block.json, the scan, the specs the store validates with,
// and GET /plugins/:slug/usage.

const pluginBlockVectorsPath = "../web/gl-admin/lib/plugins/pluginBlockVectors.json"

// TestPluginBlockVectors runs the shared cases: both validators must accept and refuse the
// same block.json files and name the same field, or the web build and the API would
// disagree about which blocks are installed.
func TestPluginBlockVectors(t *testing.T) {
	raw, err := os.ReadFile(pluginBlockVectorsPath)
	require.NoError(t, err)
	var vectors struct {
		Slug  string         `json:"slug"`
		Dir   string         `json:"dir"`
		Base  map[string]any `json:"base"`
		Cases []struct {
			Name    string          `json:"name"`
			Valid   bool            `json:"valid"`
			Field   string          `json:"field"`
			Dir     string          `json:"dir"`
			Set     map[string]any  `json:"set"`
			NullSet []string        `json:"null_set"`
			Replace json.RawMessage `json:"replace"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors.Cases)

	for _, tc := range vectors.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			// The case's block.json, built as blockJson.test.ts builds it.
			var value any
			if len(tc.Replace) > 0 {
				require.NoError(t, json.Unmarshal(tc.Replace, &value))
			} else {
				merged := map[string]any{}
				for key, v := range vectors.Base {
					merged[key] = v
				}
				for key, v := range tc.Set {
					if v == nil {
						delete(merged, key)
					} else {
						merged[key] = v
					}
				}
				for _, key := range tc.NullSet {
					merged[key] = nil
				}
				// Through JSON, as the scan reads it (numbers as float64).
				encoded, err := json.Marshal(merged)
				require.NoError(t, err)
				require.NoError(t, json.Unmarshal(encoded, &value))
			}
			dir := tc.Dir
			if dir == "" {
				dir = vectors.Dir
			}

			blockType, spec, problem := ValidatePluginBlockJSON(value, vectors.Slug, dir)
			if tc.Valid {
				require.Nil(t, problem, "%v", problem)
				require.Equal(t, pluginBlockTypeFor(vectors.Slug, dir), blockType)
				require.GreaterOrEqual(t, spec.Version, 1)
				return
			}
			require.NotNil(t, problem)
			require.Equal(t, tc.Field, problem.Field, problem.Error())
		})
	}
}

func TestValidatePluginBlockJSONSpec(t *testing.T) {
	var value any
	require.NoError(t, json.Unmarshal([]byte(`{
		"type": "plugin:p/note", "version": 2, "title": "Note",
		"attrs": {
			"label": {"type": "string", "default": "a", "enum": ["a", "b"], "maxLength": 5},
			"count": {"type": "number", "default": 2, "integer": true, "minimum": 1, "maximum": 3}
		}
	}`), &value))
	blockType, spec, problem := ValidatePluginBlockJSON(value, "p", "Note")
	require.Nil(t, problem)
	require.Equal(t, "plugin:p/note", blockType)
	require.Equal(t, 2, spec.Version)
	require.Equal(t, "a", spec.Attrs["label"].Default)
	require.Equal(t, []any{"a", "b"}, spec.Attrs["label"].Enum)
	require.Equal(t, 5, *spec.Attrs["label"].MaxLength)
	require.True(t, spec.Attrs["count"].Integer)
	require.Equal(t, 1.0, *spec.Attrs["count"].Minimum)
	require.Equal(t, 3.0, *spec.Attrs["count"].Maximum)

	problem = &PluginBlockError{Block: "Note", Field: "title", Message: "is required"}
	require.Equal(t, "blocks/Note/block.json: title is required", problem.Error())
	problem = &PluginBlockError{Block: "Note", Message: "is missing"}
	require.Equal(t, "blocks/Note/block.json is missing", problem.Error())
}

const testBlockJSON = `{"type": "plugin:%s/note", "version": 1, "title": "Note", "content": "inline*", "attrs": {"tone": {"type": "string", "default": "info", "enum": ["info", "warn"]}}}`

func noteBlockJSON(slug string) string {
	return fmt.Sprintf(testBlockJSON, slug)
}

func TestScanPluginBlocks(t *testing.T) {
	root := t.TempDir()
	writePlugin(t, root, "good", pluginJSON("good", "1.0.0", 1, `"blocks":["Note"]`), map[string]string{
		"blocks/Note/block.json": noteBlockJSON("good"),
		// The editor and renderer halves are the web build's; the scan never reads them.
		"blocks/Note/editor.ts":  "export default 1",
		"blocks/Note/render.tsx": "export default 1",
	})
	writePlugin(t, root, "nojson", pluginJSON("nojson", "1.0.0", 1, `"blocks":["Note"]`), map[string]string{"blocks/Note/editor.ts": ""})
	writePlugin(t, root, "badjson", pluginJSON("badjson", "1.0.0", 1, `"blocks":["Note"]`), map[string]string{"blocks/Note/block.json": `{"type":`})
	writePlugin(t, root, "badblock", pluginJSON("badblock", "1.0.0", 1, `"blocks":["Note"]`), map[string]string{"blocks/Note/block.json": `{"type": "plugin:badblock/note", "version": 1, "title": "Note", "content": "block+"}`})
	writePlugin(t, root, "undeclared", pluginJSON("undeclared", "1.0.0", 1, ""), map[string]string{"blocks/Note/block.json": noteBlockJSON("undeclared")})
	// Another plugin_api: its block.json isn't read (it may be in a newer format).
	writePlugin(t, root, "future", pluginJSON("future", "1.0.0", PluginAPIMax+1, `"blocks":["Note"]`), map[string]string{"blocks/Note/block.json": `{"format": 2}`})

	plugins, err := ScanPluginsDirectory(root)
	require.NoError(t, err)
	bySlug := map[string]DiscoveredPlugin{}
	for _, plugin := range plugins {
		bySlug[plugin.Slug] = plugin
	}

	require.NoError(t, bySlug["good"].Err)
	require.Equal(t, map[string]ThemeBlockSpec{"plugin:good/note": {Version: 1, Attrs: map[string]ThemeAttrSpec{
		"tone": {Type: "string", Default: "info", Enum: []any{"info", "warn"}},
	}}}, bySlug["good"].BlockSpecs)

	var problem *PluginBlockError
	require.True(t, errors.As(bySlug["nojson"].Err, &problem))
	require.Equal(t, "blocks/Note/block.json is missing", problem.Error())
	require.ErrorContains(t, bySlug["badjson"].Err, "is not valid JSON")
	require.True(t, errors.As(bySlug["badblock"].Err, &problem))
	require.Equal(t, "content", problem.Field)
	require.ErrorContains(t, bySlug["undeclared"].Err, `is not listed in plugin.json's "blocks"`)
	require.NoError(t, bySlug["future"].Err)
	require.Nil(t, bySlug["future"].BlockSpecs)

	// The specs merged into what the store validates with: installed plugins only, theme
	// blocks kept, whatever is enabled.
	themes := ThemeBlockManifest{ManifestVersion: 1, Blocks: map[string]ThemeBlockSpec{"theme:example/alert": {Version: 1}}}
	merged, added := mergePluginBlockSpecs(themes, plugins)
	require.Equal(t, []string{"plugin:good/note"}, added)
	require.Len(t, merged.Blocks, 2)
	require.Contains(t, merged.Blocks, "theme:example/alert")
	require.Len(t, themes.Blocks, 1, "the theme manifest isn't changed in place")

	// And they validate a stored block exactly as a theme block's spec does.
	doc := themeBlockDoc(map[string]interface{}{"blk-note-00001": roundTrip(t, map[string]interface{}{
		"id": "blk-note-00001", "type": "plugin:good/note", "version": 1, "attrs": map[string]interface{}{"tone": "loud"},
	})})
	require.ErrorContains(t, doc.prepareForStore(merged), "attr tone")

	// No manifest at all (the theme manifest file missing): still a usable manifest.
	merged, _ = mergePluginBlockSpecs(ThemeBlockManifest{}, plugins)
	require.Equal(t, 1, merged.ManifestVersion)
	require.Contains(t, merged.Blocks, "plugin:good/note")
}

// TestRepositoryPluginBlocks: the repository's plugins' blocks load (the web's
// themeBlocks.loadable.test.ts checks the same directories), and the example plugin has one.
func TestRepositoryPluginBlocks(t *testing.T) {
	plugins, err := ScanPluginsDirectory(filepath.Join("..", "web", "plugins"))
	require.NoError(t, err)
	merged, added := mergePluginBlockSpecs(ThemeBlockManifest{}, plugins)
	require.Contains(t, added, "plugin:reading-time/estimate")
	estimate := merged.Blocks["plugin:reading-time/estimate"]
	require.Equal(t, 1, estimate.Version)
	require.Equal(t, "min read", estimate.Attrs["label"].Default)
	require.Equal(t, 40, *estimate.Attrs["label"].MaxLength)
}

func TestGetPluginUsage(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	changed := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)

	store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusMissing, false), nil)
	store.EXPECT().ListPostsUsingPluginBlocks(gomock.Any(), db.ListPostsUsingPluginBlocksParams{TypePrefix: "plugin:alpha/", RowLimit: pluginUsageListMax}).
		Return([]db.ListPostsUsingPluginBlocksRow{
			{ID: 4, Title: "Live", PostType: "post", PostStatus: "published", ChangedAt: changed, InWorkingCopy: true, InPublished: true, Total: 120},
			{ID: 3, Title: "Draft", PostType: "page", PostStatus: "draft", ChangedAt: changed, InWorkingCopy: true, Total: 120},
		}, nil)
	recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/alpha/usage")
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{
		"slug": "alpha", "count": 120, "truncated": true,
		"posts": [
			{"id": 4, "title": "Live", "post_type": "post", "post_status": "published", "in_working_copy": true, "in_published": true, "changed_at": "2026-11-01T09:00:00Z"},
			{"id": 3, "title": "Draft", "post_type": "page", "post_status": "draft", "in_working_copy": true, "in_published": false, "changed_at": "2026-11-01T09:00:00Z"}
		]
	}`, recorder.Body.String())

	t.Run("no post holds one", func(t *testing.T) {
		store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, true), nil)
		store.EXPECT().ListPostsUsingPluginBlocks(gomock.Any(), gomock.Any()).Return([]db.ListPostsUsingPluginBlocksRow{}, nil)
		recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/alpha/usage")
		requireStatus(t, recorder, http.StatusOK)
		require.JSONEq(t, `{"slug": "alpha", "count": 0, "truncated": false, "posts": []}`, recorder.Body.String())
	})

	t.Run("an unknown plugin is a 404, a store failure a 500", func(t *testing.T) {
		store.EXPECT().GetPluginBySlug(gomock.Any(), "nope").Return(db.Plugin{}, sql.ErrNoRows)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/nope/usage"), http.StatusNotFound)
		store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, true), nil)
		store.EXPECT().ListPostsUsingPluginBlocks(gomock.Any(), gomock.Any()).Return(nil, errors.New("down"))
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/alpha/usage"), http.StatusInternalServerError)
	})
}

// TestPluginUsageCounts runs the usage query against the test database (skipped without
// one): working copies and published snapshots, a block nested in another's pm, another
// plugin's blocks and a prefix that only looks alike.
func TestPluginUsageCounts(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	ctx := context.Background()
	admin := scheduleUser(t, store, RoleAdmin)

	slug := pluginDBSlug("usage")
	root := t.TempDir()
	writePlugin(t, root, slug, pluginJSON(slug, "1.0.0", 1, ""), nil)
	syncPluginsFrom(t, server, root, slug)

	docWith := func(block map[string]any) json.RawMessage {
		raw, err := json.Marshal(map[string]any{
			"doc_version": 1, "blocks_order": []string{"b1", "b2"},
			"blocks": map[string]any{
				"b1": map[string]any{"id": "b1", "type": "paragraph", "version": 1, "attrs": map[string]any{"text": "Intro"}},
				"b2": block,
			},
		})
		require.NoError(t, err)
		return raw
	}
	pluginBlock := func(blockType string) map[string]any {
		return map[string]any{"id": "b2", "type": blockType, "version": 1, "attrs": map[string]any{}}
	}
	// A plugin block inside a quote's pm (it is in the `block` group).
	quoted := map[string]any{"id": "b2", "type": "blockquote", "version": 2, "attrs": map[string]any{
		"pm": map[string]any{"type": "blockquote", "content": []any{map[string]any{"type": "plugin:" + slug + "/note", "attrs": map[string]any{}}}},
	}}
	post := func(working, published json.RawMessage, status string) int64 {
		created := scheduleDraft(t, store, admin, scheduleWord())
		var publishedDoc any
		if published != nil {
			publishedDoc = []byte(published)
		}
		// A trashed post carries when and from what (000037's CHECK).
		_, err := conn.ExecContext(ctx, `UPDATE posts SET block_doc = $1, published_block_doc = $2, post_status = $3::text,
			deleted_at = CASE WHEN $3::text = 'trash' THEN now() END, trashed_from_status = CASE WHEN $3::text = 'trash' THEN 'draft' END
			WHERE id = $4`, []byte(working), publishedDoc, status, created.ID)
		require.NoError(t, err)
		return created.ID
	}
	plain := docWith(map[string]any{"id": "b2", "type": "paragraph", "version": 1, "attrs": map[string]any{"text": "plain"}})

	workingOnly := post(docWith(pluginBlock("plugin:"+slug+"/note")), nil, "draft")
	publishedOnly := post(plain, docWith(pluginBlock("plugin:"+slug+"/other")), "published")
	both := post(docWith(pluginBlock("plugin:"+slug+"/note")), docWith(pluginBlock("plugin:"+slug+"/note")), "published")
	nested := post(docWith(quoted), nil, "trash")
	post(docWith(pluginBlock("plugin:"+slug+"-lookalike/note")), nil, "draft")
	post(docWith(pluginBlock("theme:"+slug+"/note")), nil, "draft")
	post(plain, plain, "published")

	recorder := as(t, server, admin, http.MethodGet, "/api/v1/plugins/"+slug+"/usage", nil)
	requireStatus(t, recorder, http.StatusOK)
	var rsp struct {
		Count     int64             `json:"count"`
		Truncated bool              `json:"truncated"`
		Posts     []PluginUsagePost `json:"posts"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.EqualValues(t, 4, rsp.Count)
	require.False(t, rsp.Truncated)
	found := map[int64]PluginUsagePost{}
	for _, p := range rsp.Posts {
		found[p.ID] = p
	}
	require.Len(t, found, 4)
	require.True(t, found[workingOnly].InWorkingCopy)
	require.False(t, found[workingOnly].InPublished)
	require.False(t, found[publishedOnly].InWorkingCopy)
	require.True(t, found[publishedOnly].InPublished)
	require.True(t, found[both].InWorkingCopy && found[both].InPublished)
	require.True(t, found[nested].InWorkingCopy)
	require.Equal(t, "trash", found[nested].PostStatus)

	// Admins only.
	editor := scheduleUser(t, store, RoleEditor)
	requireStatus(t, as(t, server, editor, http.MethodGet, "/api/v1/plugins/"+slug+"/usage", nil), http.StatusForbidden)
}
