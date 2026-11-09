package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Columns, buttons and the spacer (#426): allowlists for every attr, and a button's href,
// a node attr the link-mark check never saw, checked with isSafeURL. The nesting vectors
// (post_blocks_nesting_test.go) cover the structure; buttonHrefVectors.json is the web's too.

func TestLayoutNestingRows(t *testing.T) {
	require.True(t, containerAccepts("columns", "column"))
	require.False(t, containerAccepts("columns", "paragraph"))
	require.True(t, containerAccepts("group", "columns"))
	for _, childType := range []string{"paragraph", "image", "buttons", "spacer", "details", "theme:example/alert"} {
		require.True(t, containerAccepts("column", childType), childType)
	}
	for _, childType := range []string{"group", "column", "columns", "list_item"} {
		require.False(t, containerAccepts("column", childType), childType)
	}
	require.False(t, containerAccepts("group", "column"))
	require.False(t, containerAccepts("details", "columns"))
	require.Equal(t, 2, blockContainers["columns"].min)
	require.Equal(t, 4, blockContainers["columns"].max)
	require.True(t, blockContainers["column"].nestedOnly)
	for _, flow := range []string{"buttons", "spacer"} {
		require.True(t, isFlowBlockType(flow), flow)
	}
}

func TestButtonHrefVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "web", "gl-admin", "lib", "blocks-spec", "buttonHrefVectors.json"))
	require.NoError(t, err)
	var vectors struct {
		Allowed []string `json:"allowed"`
		Refused []string `json:"refused"`
	}
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors.Allowed)
	require.NotEmpty(t, vectors.Refused)
	for _, href := range vectors.Allowed {
		require.True(t, isSafeURL(href, safeHrefSchemes), href)
		attrs := buttonNodeAttrsAfter(t, map[string]interface{}{"href": href})
		require.Equal(t, href, attrs["href"], href)
	}
	for _, href := range vectors.Refused {
		require.False(t, isSafeURL(href, safeHrefSchemes), href)
		attrs := buttonNodeAttrsAfter(t, map[string]interface{}{"href": href})
		require.NotContains(t, attrs, "href", href)
	}
}

func buttonNodeAttrsAfter(t *testing.T, attrs map[string]interface{}) map[string]interface{} {
	t.Helper()
	node := map[string]interface{}{"type": "button", "attrs": attrs}
	sanitizeButtonNode(node)
	kept, _ := node["attrs"].(map[string]interface{})
	if kept == nil {
		return map[string]interface{}{}
	}
	return kept
}

func layoutDocWith(blockType string, attrs map[string]interface{}) BlockDocV1 {
	return BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"block-0001"},
		Blocks: map[string]interface{}{
			"block-0001": map[string]interface{}{"id": "block-0001", "type": blockType, "version": float64(1), "attrs": attrs},
		},
	}
}

func layoutAttrsAfterStore(t *testing.T, blockType string, attrs map[string]interface{}) map[string]interface{} {
	t.Helper()
	doc := layoutDocWith(blockType, attrs)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	return doc.Blocks["block-0001"].(map[string]interface{})["attrs"].(map[string]interface{})
}

func buttonsPM(buttons ...interface{}) map[string]interface{} {
	return map[string]interface{}{"type": "buttons", "content": buttons}
}

func button(attrs map[string]interface{}, text string) map[string]interface{} {
	node := map[string]interface{}{"type": "button"}
	if attrs != nil {
		node["attrs"] = attrs
	}
	if text != "" {
		node["content"] = []interface{}{map[string]interface{}{"type": "text", "text": text}}
	}
	return node
}

func TestSanitize_ButtonsAttrs(t *testing.T) {
	t.Run("the bridge's output passes through unchanged", func(t *testing.T) {
		raw := `{"align": "center", "text": "Read Log", "pm": {"type": "buttons", "content": [
			{"type": "button", "attrs": {"href": "/guide"}, "content": [{"type": "text", "text": "Read"}]},
			{"type": "button", "attrs": {"href": "https://example.com", "variant": "secondary"}, "content": [{"type": "text", "text": "Log"}]},
			{"type": "button"}
		]}}`
		var attrs, want map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &attrs))
		require.NoError(t, json.Unmarshal([]byte(raw), &want))
		require.Equal(t, want, layoutAttrsAfterStore(t, "buttons", attrs))
	})

	t.Run("an unsafe href costs the link, never the button", func(t *testing.T) {
		for _, href := range []string{"javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd"} {
			got := layoutAttrsAfterStore(t, "buttons", map[string]interface{}{"pm": buttonsPM(button(map[string]interface{}{"href": href, "variant": "secondary"}, "Go"))})
			out, err := json.Marshal(got)
			require.NoError(t, err)
			require.NotContains(t, strings.ToLower(string(out)), "script:", href)
			require.NotContains(t, string(out), "data:text", href)
			content := got["pm"].(map[string]interface{})["content"].([]interface{})
			require.Len(t, content, 1)
			node := content[0].(map[string]interface{})
			require.Equal(t, map[string]interface{}{"variant": "secondary"}, node["attrs"])
			require.Equal(t, "Go", node["content"].([]interface{})[0].(map[string]interface{})["text"])
		}
	})

	t.Run("an href on a button in another block's pm is checked too", func(t *testing.T) {
		doc := layoutDocWith("paragraph", map[string]interface{}{"pm": map[string]interface{}{
			"type": "paragraph", "content": []interface{}{button(map[string]interface{}{"href": "javascript:alert(1)"}, "x")},
		}})
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		out, err := json.Marshal(doc.Blocks["block-0001"])
		require.NoError(t, err)
		require.NotContains(t, string(out), "javascript")
	})

	t.Run("an allowlist: unknown attrs, on* handlers and bad values are deleted", func(t *testing.T) {
		got := layoutAttrsAfterStore(t, "buttons", map[string]interface{}{
			"align": "right", "onclick": "x", "class": "evil", "href": "javascript:alert(1)", "text": float64(1),
			"pm": buttonsPM(button(map[string]interface{}{"href": "/ok", "variant": "huge", "target": "_blank", "onmouseover": "x", "style": "color:red"}, "Go")),
		})
		require.NotContains(t, got, "align")
		require.NotContains(t, got, "onclick")
		require.NotContains(t, got, "class")
		require.NotContains(t, got, "href")
		require.NotContains(t, got, "text")
		node := got["pm"].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})
		require.Equal(t, map[string]interface{}{"href": "/ok"}, node["attrs"])
	})

	t.Run("the pm: only button nodes, a label of plain text, capped", func(t *testing.T) {
		long := strings.Repeat("a", 500)
		marked := button(map[string]interface{}{"href": "/ok"}, "")
		marked["content"] = []interface{}{
			map[string]interface{}{"type": "text", "text": "Bo", "marks": []interface{}{map[string]interface{}{"type": "bold"}}},
			map[string]interface{}{"type": "text", "text": "ld"},
			map[string]interface{}{"type": "mention", "attrs": map[string]interface{}{"userId": float64(1)}},
		}
		marked["marks"] = []interface{}{map[string]interface{}{"type": "bold"}}
		got := layoutAttrsAfterStore(t, "buttons", map[string]interface{}{
			"pm": buttonsPM(map[string]interface{}{"type": "paragraph"}, "not a node", marked, button(nil, long), map[string]interface{}{"type": "script"}),
		})
		content := got["pm"].(map[string]interface{})["content"].([]interface{})
		require.Len(t, content, 2)
		first := content[0].(map[string]interface{})
		require.Equal(t, []interface{}{map[string]interface{}{"type": "text", "text": "Bold"}}, first["content"])
		require.NotContains(t, first, "marks")
		label := content[1].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})["text"].(string)
		require.Equal(t, 200, len([]rune(label)))
	})

	t.Run("an over-long href is dropped", func(t *testing.T) {
		attrs := buttonNodeAttrsAfter(t, map[string]interface{}{"href": "/" + strings.Repeat("a", buttonHrefMaxLength)})
		require.NotContains(t, attrs, "href")
	})

	t.Run("a pm that isn't a buttons node is dropped", func(t *testing.T) {
		for _, pm := range []interface{}{"x", float64(1), map[string]interface{}{"type": "paragraph"}} {
			require.NotContains(t, layoutAttrsAfterStore(t, "buttons", map[string]interface{}{"pm": pm}), "pm")
		}
	})
}

func TestSanitize_ColumnsAttrs(t *testing.T) {
	doc := BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"columns-01"},
		Blocks: map[string]interface{}{
			"columns-01": map[string]interface{}{"id": "columns-01", "type": "columns", "version": float64(1), "children": []interface{}{"column-001", "column-002"},
				"attrs": map[string]interface{}{"layout": "33-67", "align": "wide", "onclick": "x", "style": "evil"}},
			"column-001": map[string]interface{}{"id": "column-001", "type": "column", "version": float64(1), "children": []interface{}{"para-00001"}, "attrs": map[string]interface{}{"width": "100%", "class": "x"}},
			"column-002": map[string]interface{}{"id": "column-002", "type": "column", "version": float64(1), "children": []interface{}{"para-00002"}, "attrs": map[string]interface{}{}},
			"para-00001": map[string]interface{}{"id": "para-00001", "type": "paragraph", "version": float64(1), "attrs": map[string]interface{}{"text": "x"}},
			"para-00002": map[string]interface{}{"id": "para-00002", "type": "paragraph", "version": float64(1), "attrs": map[string]interface{}{"text": "y"}},
		},
	}
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	require.Equal(t, map[string]interface{}{"layout": "33-67", "align": "wide"}, doc.Blocks["columns-01"].(map[string]interface{})["attrs"])
	require.Empty(t, doc.Blocks["column-001"].(map[string]interface{})["attrs"])

	for _, bad := range []map[string]interface{}{{"layout": "10-90"}, {"layout": float64(1)}, {"align": "huge"}, {"align": true}} {
		attrs := map[string]interface{}{}
		for key, value := range bad {
			attrs[key] = value
		}
		sanitizeColumnsAttrs(attrs)
		require.Empty(t, attrs, "%v", bad)
	}
}

func TestSanitize_SpacerAttrs(t *testing.T) {
	require.Equal(t, map[string]interface{}{"size": "9"}, layoutAttrsAfterStore(t, "spacer", map[string]interface{}{"size": "9", "onclick": "x", "height": "400px"}))
	for _, bad := range []interface{}{"48px", "13", float64(7), true, nil} {
		require.Empty(t, layoutAttrsAfterStore(t, "spacer", map[string]interface{}{"size": bad}), "%v", bad)
	}
}

func TestColumnsWalkAndRegenerate(t *testing.T) {
	raw := `{
		"doc_version": 1,
		"blocks_order": ["group-0001"],
		"blocks": {
			"group-0001": {"id": "group-0001", "type": "group", "version": 1, "attrs": {}, "children": ["columns-01"]},
			"columns-01": {"id": "columns-01", "type": "columns", "version": 1, "attrs": {}, "children": ["column-001", "column-002"]},
			"column-001": {"id": "column-001", "type": "column", "version": 1, "attrs": {}, "children": ["image-0001"]},
			"column-002": {"id": "column-002", "type": "column", "version": 1, "attrs": {}, "children": ["para-00001"]},
			"image-0001": {"id": "image-0001", "type": "image", "version": 2, "attrs": {"mediaId": 12, "src": "/uploads/a.jpg"}},
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {"text": "x"}}
		}
	}`
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal([]byte(raw), &doc))
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))

	// An image in a column is recorded in "Used in", in reading order.
	var visited []string
	doc.walkBlocks(func(id string, _ map[string]interface{}) { visited = append(visited, id) })
	require.Equal(t, []string{"group-0001", "columns-01", "column-001", "image-0001", "column-002", "para-00001"}, visited)
	uses := doc.contentMediaUses()
	require.Len(t, uses, 1)
	require.Equal(t, int64(12), uses[0].MediaID)
	require.Equal(t, "image-0001", uses[0].BlockID)
}
