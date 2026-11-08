package api

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// Details (#421): a container whose summary is an attr (runs like a caption's), not a
// child. Its attrs are an allowlist, its children are checked by the nesting table (the
// shared vectors cover the structure), and media inside it is in "Used in".

func TestDetailsNestingRow(t *testing.T) {
	for _, childType := range []string{"paragraph", "image", "table", "bullet_list", "callout", "theme:example/alert"} {
		require.True(t, containerAccepts("details", childType), childType)
	}
	for _, childType := range []string{"details", "group", "list_item", "todo_item"} {
		require.False(t, containerAccepts("details", childType), childType)
	}
	require.True(t, containerAccepts("group", "details"))
	require.Equal(t, 1, blockContainers["details"].min)
}

func detailsDocWith(attrs map[string]interface{}) BlockDocV1 {
	return BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"details-01"},
		Blocks: map[string]interface{}{
			"details-01": map[string]interface{}{
				"id": "details-01", "type": "details", "version": float64(1),
				"attrs":    attrs,
				"children": []interface{}{"para-00001"},
			},
			"para-00001": map[string]interface{}{"id": "para-00001", "type": "paragraph", "version": float64(1), "attrs": map[string]interface{}{"text": "x"}},
		},
	}
}

func detailsAttrsAfterStore(t *testing.T, attrs map[string]interface{}) map[string]interface{} {
	t.Helper()
	doc := detailsDocWith(attrs)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	return doc.Blocks["details-01"].(map[string]interface{})["attrs"].(map[string]interface{})
}

func TestSanitize_DetailsAttrs(t *testing.T) {
	t.Run("the bridge's output passes through unchanged", func(t *testing.T) {
		raw := `{"summary": [{"type": "text", "text": "Can "}, {"type": "text", "text": "contributors", "marks": [{"type": "bold"}]}, {"type": "text", "text": " publish?", "marks": [{"type": "link", "attrs": {"href": "https://example.com/roles"}}]}], "text": "Can contributors publish?", "open": true}`
		var attrs map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &attrs))
		var want map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &want))
		require.Equal(t, want, detailsAttrsAfterStore(t, attrs))
	})

	t.Run("an allowlist: unknown attrs, a pm and on* handlers are deleted", func(t *testing.T) {
		got := detailsAttrsAfterStore(t, map[string]interface{}{
			"open": true, "onclick": "x", "class": "evil", "style": "tinted",
			"pm": map[string]interface{}{"type": "details"},
		})
		require.Equal(t, map[string]interface{}{"open": true}, got)
	})

	t.Run("open is true or absent", func(t *testing.T) {
		for _, value := range []interface{}{false, "true", 1, nil} {
			require.Empty(t, detailsAttrsAfterStore(t, map[string]interface{}{"open": value}), "%v", value)
		}
	})

	t.Run("text is a string or absent", func(t *testing.T) {
		require.Equal(t, map[string]interface{}{"text": "Q"}, detailsAttrsAfterStore(t, map[string]interface{}{"text": "Q"}))
		require.Empty(t, detailsAttrsAfterStore(t, map[string]interface{}{"text": 3}))
	})

	t.Run("the summary keeps text runs with caption marks only, each mark sanitized", func(t *testing.T) {
		got := detailsAttrsAfterStore(t, map[string]interface{}{
			"summary": []interface{}{
				map[string]interface{}{"type": "text", "text": "a", "marks": []interface{}{
					map[string]interface{}{"type": "code"},
					map[string]interface{}{"type": "italic"},
				}},
				map[string]interface{}{"type": "text", "text": "b", "marks": []interface{}{
					map[string]interface{}{"type": "link", "attrs": map[string]interface{}{"href": "javascript:alert(1)"}},
				}},
				map[string]interface{}{"type": "image", "attrs": map[string]interface{}{"src": "/a.png"}},
				map[string]interface{}{"type": "text", "text": ""},
				"not a run",
			},
		})
		summary := got["summary"].([]interface{})
		require.Len(t, summary, 2)
		require.Equal(t, map[string]interface{}{"type": "text", "text": "a", "marks": []interface{}{map[string]interface{}{"type": "italic"}}}, summary[0])
		second := summary[1].(map[string]interface{})
		require.Equal(t, "b", second["text"])
		if marks, ok := second["marks"].([]interface{}); ok {
			for _, m := range marks {
				href := m.(map[string]interface{})["attrs"].(map[string]interface{})["href"]
				require.NotEqual(t, "javascript:alert(1)", href)
			}
		}
	})

	t.Run("the mark allowlist (#418): bold, italic and link survive, other allowed marks don't reach a summary", func(t *testing.T) {
		raw := `{"summary": [
			{"type": "text", "text": "b", "marks": [{"type": "bold"}]},
			{"type": "text", "text": "i", "marks": [{"type": "italic"}]},
			{"type": "text", "text": "l", "marks": [{"type": "link", "attrs": {"href": "https://example.com/a", "target": "_blank", "rel": "noopener", "class": null}}]},
			{"type": "text", "text": "all", "marks": [{"type": "bold"}, {"type": "italic"}, {"type": "link", "attrs": {"href": "/b"}}]}
		]}`
		var attrs, want map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(raw), &attrs))
		require.NoError(t, json.Unmarshal([]byte(raw), &want))
		require.Equal(t, want, detailsAttrsAfterStore(t, attrs))

		// In the allowlist for a pm, but not caption marks; and one nobody allows. The text stays.
		for _, mark := range []string{"highlight", "superscript", "subscript", "code", "strike", "underline", "spoiler"} {
			got := detailsAttrsAfterStore(t, map[string]interface{}{"summary": []interface{}{
				map[string]interface{}{"type": "text", "text": "x", "marks": []interface{}{
					map[string]interface{}{"type": mark, "attrs": map[string]interface{}{"color": "red"}},
				}},
			}})
			require.Equal(t, []interface{}{map[string]interface{}{"type": "text", "text": "x"}}, got["summary"], mark)
		}

		// A link's on* attrs go, its href stays.
		got := detailsAttrsAfterStore(t, map[string]interface{}{"summary": []interface{}{
			map[string]interface{}{"type": "text", "text": "x", "marks": []interface{}{
				map[string]interface{}{"type": "link", "attrs": map[string]interface{}{"href": "/ok", "onclick": "x"}},
			}},
		}})
		run := got["summary"].([]interface{})[0].(map[string]interface{})
		require.Equal(t, []interface{}{map[string]interface{}{"type": "link", "attrs": map[string]interface{}{"href": "/ok"}}}, run["marks"])
	})

	t.Run("a summary that isn't runs, or has none left, is dropped", func(t *testing.T) {
		require.Empty(t, detailsAttrsAfterStore(t, map[string]interface{}{"summary": "Q"}))
		require.Empty(t, detailsAttrsAfterStore(t, map[string]interface{}{"summary": []interface{}{map[string]interface{}{"type": "image"}}}))
	})

	t.Run("a details with no blocks is refused", func(t *testing.T) {
		doc := detailsDocWith(map[string]interface{}{})
		doc.Blocks["details-01"].(map[string]interface{})["children"] = []interface{}{}
		require.Error(t, doc.prepareForStore(ThemeBlockManifest{}))
	})
}

// An image inside a details (in a group) appears in the media's "Used in" (#176), at its
// place in reading order: the issue's acceptance.
func TestContentMediaUsesInDetails(t *testing.T) {
	doc := parseVectorDoc(t, json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["details-01", "group-0001"],
		"blocks": {
			"details-01": {"id": "details-01", "type": "details", "version": 1, "attrs": {"summary": [{"type": "text", "text": "Photos"}], "text": "Photos"}, "children": ["image-0001"]},
			"image-0001": {"id": "image-0001", "type": "image", "version": 2, "attrs": {"mediaId": 1}},
			"group-0001": {"id": "group-0001", "type": "group", "version": 1, "attrs": {}, "children": ["details-02"]},
			"details-02": {"id": "details-02", "type": "details", "version": 1, "attrs": {}, "children": ["para-00001", "image-0002"]},
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {}},
			"image-0002": {"id": "image-0002", "type": "image", "version": 2, "attrs": {"mediaId": 2}}
		}
	}`))
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	uses := doc.contentMediaUses()
	require.Len(t, uses, 2)
	require.Equal(t, int64(1), uses[0].MediaID)
	require.Equal(t, "image-0001", uses[0].BlockID)
	require.Equal(t, int64(2), uses[1].MediaID)
	require.Equal(t, "image-0002", uses[1].BlockID)
	require.Equal(t, "image", uses[1].BlockType)
}

// Duplicate (#354) and templates (#322) give a details' children fresh ids too.
func TestRegenerateBlockIDsInDetails(t *testing.T) {
	src := json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["details-01"],
		"blocks": {
			"details-01": {"id": "details-01", "type": "details", "version": 1, "attrs": {"summary": [{"type": "text", "text": "Q"}], "text": "Q", "open": true}, "children": ["para-00001"]},
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {"text": "A"}}
		}
	}`)
	out, err := regenerateBlockIDs(src, uuid.NewString)
	require.NoError(t, err)
	doc := parseVectorDoc(t, out)
	require.Len(t, doc.BlocksOrder, 1)
	details := doc.Blocks[doc.BlocksOrder[0]].(map[string]interface{})
	require.NotEqual(t, "details-01", details["id"])
	children := details["children"].([]interface{})
	require.Len(t, children, 1)
	require.NotEqual(t, "para-00001", children[0])
	require.Contains(t, doc.Blocks, children[0])
	require.Equal(t, true, details["attrs"].(map[string]interface{})["open"])
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
}
