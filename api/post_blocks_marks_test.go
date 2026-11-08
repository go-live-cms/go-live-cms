package api

import (
	"encoding/json"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"
)

// #418: the mark types are an allowlist (allowedMarkTypes). The web's
// blocks-spec/markAllowlist.test.ts checks that the list is exactly the editor schema's
// marks, so a mark the editor writes is never stripped and nothing else gets through.

func TestAllowedMarkTypes(t *testing.T) {
	names := make([]string, 0, len(allowedMarkTypes))
	for name := range allowedMarkTypes {
		names = append(names, name)
	}
	sort.Strings(names)
	require.Equal(t, []string{"bold", "code", "highlight", "italic", "link", "strike", "subscript", "superscript", "underline"}, names)
	for name, keepsAttrs := range allowedMarkTypes {
		require.Equal(t, name == "link", keepsAttrs, "%s: only a link keeps attrs", name)
	}
}

// marksOf returns the marks of the first text run of the doc's paragraph b1 (nil when it
// has none).
func marksOf(t *testing.T, doc *BlockDocV1) []interface{} {
	t.Helper()
	node := firstTextNode(t, doc)
	if _, present := node["marks"]; !present {
		return nil
	}
	marks, ok := node["marks"].([]interface{})
	require.True(t, ok, "marks must stay a list: %v", node["marks"])
	return marks
}

func TestSanitize_MarkAllowlist(t *testing.T) {
	t.Run("keeps every mark the editor writes, as the bridge writes it", func(t *testing.T) {
		for _, m := range []map[string]interface{}{
			{"type": "bold"}, {"type": "italic"}, {"type": "underline"}, {"type": "strike"}, {"type": "code"},
			{"type": "highlight"}, {"type": "superscript"}, {"type": "subscript"},
			{"type": "link", "attrs": map[string]interface{}{"href": "https://example.com", "target": "_blank", "rel": "noopener noreferrer nofollow", "class": "editor-link"}},
		} {
			want, err := json.Marshal(m)
			require.NoError(t, err)
			doc := paragraphWithText("x", []interface{}{m}, nil)
			doc.sanitize()
			got, err := json.Marshal(marksOf(t, doc))
			require.NoError(t, err)
			require.JSONEq(t, "["+string(want)+"]", string(got), "%s passes unchanged", m["type"])
		}
	})

	t.Run("drops a mark of any other type, keeping the text", func(t *testing.T) {
		for _, markType := range []string{"spoiler", "textStyle", "comment", "Bold", "script", "theme:example/glow", ""} {
			doc := paragraphWithText("kept", []interface{}{map[string]interface{}{"type": markType}}, nil)
			doc.sanitize()
			node := firstTextNode(t, doc)
			require.Equal(t, "kept", node["text"])
			require.NotContains(t, node, "marks", "%q is dropped, and no empty list is left", markType)
		}
	})

	t.Run("drops only the unknown ones among known marks, in their order", func(t *testing.T) {
		doc := paragraphWithText("x", []interface{}{
			map[string]interface{}{"type": "bold"},
			map[string]interface{}{"type": "spoiler", "attrs": map[string]interface{}{"level": 3}},
			map[string]interface{}{"type": "highlight"},
			map[string]interface{}{"attrs": map[string]interface{}{"href": "https://example.com"}}, // no type
			"bold", // not an object
			nil,
			map[string]interface{}{"type": "superscript"},
		}, nil)
		doc.sanitize()
		require.Equal(t, []interface{}{
			map[string]interface{}{"type": "bold"},
			map[string]interface{}{"type": "highlight"},
			map[string]interface{}{"type": "superscript"},
		}, marksOf(t, doc))
	})

	t.Run("a highlight keeps no attrs: no colour, safe or not", func(t *testing.T) {
		for _, attrs := range []map[string]interface{}{
			{"color": "#ffeb3b"},
			{"color": "red; background:url(data:image/svg+xml,<svg onload=alert(1)>)"},
			{"color": "yellow", "onclick": "alert(1)", "class": "x"},
			{},
		} {
			doc := paragraphWithText("x", []interface{}{map[string]interface{}{"type": "highlight", "attrs": attrs}}, nil)
			doc.sanitize()
			require.Equal(t, []interface{}{map[string]interface{}{"type": "highlight"}}, marksOf(t, doc), "attrs %v", attrs)
		}
	})

	t.Run("superscript, subscript and the other attr-less marks keep no attrs", func(t *testing.T) {
		for _, markType := range []string{"superscript", "subscript", "bold", "italic", "underline", "strike", "code"} {
			doc := paragraphWithText("x", []interface{}{map[string]interface{}{"type": markType, "attrs": map[string]interface{}{"style": "x", "onload": "y"}}}, nil)
			doc.sanitize()
			require.Equal(t, []interface{}{map[string]interface{}{"type": markType}}, marksOf(t, doc))
		}
	})

	t.Run("marks that aren't a list are removed", func(t *testing.T) {
		for _, marks := range []interface{}{"bold", map[string]interface{}{"type": "bold"}, 3, nil} {
			doc := paragraphWithText("x", nil, nil)
			firstTextNode(t, doc)["marks"] = marks
			doc.sanitize()
			require.NotContains(t, firstTextNode(t, doc), "marks", "marks %v", marks)
		}
	})

	t.Run("at any depth: a list item's paragraph, a table cell, a theme block", func(t *testing.T) {
		run := func() map[string]interface{} {
			return map[string]interface{}{"type": "text", "text": "x", "marks": []interface{}{
				map[string]interface{}{"type": "subscript"},
				map[string]interface{}{"type": "spoiler"},
			}}
		}
		para := func() map[string]interface{} {
			return map[string]interface{}{"type": "paragraph", "content": []interface{}{run()}}
		}
		doc := &BlockDocV1{
			DocVersion:  1,
			BlocksOrder: []string{"li", "tbl", "th"},
			Blocks: map[string]interface{}{
				"li": map[string]interface{}{"id": "li", "type": "list_item", "version": 1, "attrs": map[string]interface{}{
					"pm": map[string]interface{}{"type": "listItem", "content": []interface{}{para()}},
				}},
				"tbl": map[string]interface{}{"id": "tbl", "type": "table", "version": 1, "attrs": map[string]interface{}{
					"pm": map[string]interface{}{"type": "table", "content": []interface{}{
						map[string]interface{}{"type": "tableRow", "content": []interface{}{
							map[string]interface{}{"type": "tableCell", "content": []interface{}{para()}},
						}},
					}},
				}},
				"th": map[string]interface{}{"id": "th", "type": "theme:example/alert", "version": 1, "attrs": map[string]interface{}{
					"pm": map[string]interface{}{"type": "theme:example/alert", "content": []interface{}{run()}},
				}},
			},
		}
		doc.sanitize()
		want := []interface{}{map[string]interface{}{"type": "subscript"}}
		li := doc.Blocks["li"].(map[string]interface{})["attrs"].(map[string]interface{})["pm"].(map[string]interface{})
		require.Equal(t, want, li["content"].([]interface{})[0].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})["marks"])
		tbl := doc.Blocks["tbl"].(map[string]interface{})["attrs"].(map[string]interface{})["pm"].(map[string]interface{})
		cell := tbl["content"].([]interface{})[0].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})
		require.Equal(t, want, cell["content"].([]interface{})[0].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})["marks"])
		th := doc.Blocks["th"].(map[string]interface{})["attrs"].(map[string]interface{})["pm"].(map[string]interface{})
		require.Equal(t, want, th["content"].([]interface{})[0].(map[string]interface{})["marks"])
	})

	t.Run("a caption keeps only its own marks: no highlight, superscript or subscript", func(t *testing.T) {
		caption := []interface{}{
			captionRun("a", mark("highlight", nil), mark("bold", nil)),
			captionRun("b", mark("superscript", nil), mark("subscript", nil)),
		}
		doc := singleBlock("image", map[string]interface{}{"src": "/uploads/a.png", "caption": caption})
		doc.sanitize()
		require.Equal(t, []interface{}{
			map[string]interface{}{"type": "text", "text": "a", "marks": []interface{}{map[string]interface{}{"type": "bold"}}},
			map[string]interface{}{"type": "text", "text": "b"},
		}, attrsOf(doc)["caption"])
	})
}

// The whole store path (prepareForStore, as the collab server's PUT and POST /posts run
// it): a doc with the three new marks is stored as the bridge wrote it, and an unknown
// mark in the same doc is dropped.
func TestPrepareForStore_InlineMarks(t *testing.T) {
	raw := `{
		"doc_version": 1,
		"blocks_order": ["b1"],
		"blocks": {"b1": {"id": "b1", "type": "paragraph", "version": 1, "attrs": {
			"text": "H2O and x2, highlighted",
			"pm": {"type": "paragraph", "attrs": {"textAlign": null, "data-block-id": "b1"}, "content": [
				{"type": "text", "text": "H"},
				{"type": "text", "text": "2", "marks": [{"type": "subscript"}]},
				{"type": "text", "text": "O and x"},
				{"type": "text", "text": "2", "marks": [{"type": "superscript"}]},
				{"type": "text", "text": ", "},
				{"type": "text", "text": "highlighted", "marks": [{"type": "bold"}, {"type": "highlight"}, {"type": "spoiler"}]}
			]}
		}}}
	}`
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal([]byte(raw), &doc))
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))

	content := doc.Blocks["b1"].(map[string]interface{})["attrs"].(map[string]interface{})["pm"].(map[string]interface{})["content"].([]interface{})
	got, err := json.Marshal(content)
	require.NoError(t, err)
	require.JSONEq(t, `[
		{"type": "text", "text": "H"},
		{"type": "text", "text": "2", "marks": [{"type": "subscript"}]},
		{"type": "text", "text": "O and x"},
		{"type": "text", "text": "2", "marks": [{"type": "superscript"}]},
		{"type": "text", "text": ", "},
		{"type": "text", "text": "highlighted", "marks": [{"type": "bold"}, {"type": "highlight"}]}
	]`, string(got))
}
