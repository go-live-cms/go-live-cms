package api

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

// The #419 blocks: callout, pull quote, to-do list. Their attrs are allowlists (like a
// group's), each value checked; the web's validator and bridge apply the same rules, so a
// valid edit is never changed here.

func TestSanitize_CalloutAttrs(t *testing.T) {
	t.Run("keeps every tone, and only pm, text and tone", func(t *testing.T) {
		for _, tone := range []string{"info", "success", "warning", "danger"} {
			doc := singleBlock("callout", map[string]interface{}{"tone": tone, "text": "Mind the gap", "class": "evil", "onclick": "x", "blockColor": "red"})
			doc.sanitize()
			require.Equal(t, map[string]interface{}{"tone": tone, "text": "Mind the gap"}, attrsOf(doc), tone)
		}
	})

	t.Run("drops a tone outside the enum (it renders as info)", func(t *testing.T) {
		for _, tone := range []interface{}{"error", "INFO", "", 3, true, nil, map[string]interface{}{"x": 1}} {
			doc := singleBlock("callout", map[string]interface{}{"tone": tone, "text": "x"})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "tone", "tone %v", tone)
		}
	})

	t.Run("removes a tone from the stored pm and sanitizes its content", func(t *testing.T) {
		doc := singleBlock("callout", map[string]interface{}{
			"tone": "warning",
			"pm": map[string]interface{}{
				"type":  "callout",
				"attrs": map[string]interface{}{"tone": "danger", "data-block-id": "b1"},
				"content": []interface{}{map[string]interface{}{
					"type": "paragraph",
					"content": []interface{}{map[string]interface{}{
						"type": "text", "text": "click",
						"marks": []interface{}{map[string]interface{}{"type": "link", "attrs": map[string]interface{}{"href": "javascript:alert(1)"}}},
					}},
				}},
			},
		})
		doc.sanitize()
		pm := attrsOf(doc)["pm"].(map[string]interface{})
		require.Equal(t, map[string]interface{}{"data-block-id": "b1"}, pm["attrs"])
		text := pm["content"].([]interface{})[0].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})
		require.Empty(t, text["marks"], "the unsafe link is dropped, the text kept")
		require.Equal(t, "warning", attrsOf(doc)["tone"])
	})
}

func TestSanitize_PullQuoteAttrs(t *testing.T) {
	pull := func(cite interface{}) *BlockDocV1 {
		return singleBlock("pull_quote", map[string]interface{}{"text": "Set large", "cite": cite, "align": "wide"})
	}

	t.Run("cite by the quote's rules", func(t *testing.T) {
		doc := pull("  Ana\tCosta, editor\n")
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"text": "Set large", "cite": "Ana Costa, editor"}, attrsOf(doc))

		doc = pull(strings.Repeat("é", citeMaxRunes+10))
		doc.sanitize()
		require.Equal(t, citeMaxRunes, utf8.RuneCountInString(attrsOf(doc)["cite"].(string)))

		for _, cite := range []interface{}{"", "  ", 7, []interface{}{"x"}} {
			doc = pull(cite)
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "cite", "cite %v", cite)
		}
	})

	t.Run("removes a cite from the stored pm", func(t *testing.T) {
		doc := singleBlock("pull_quote", map[string]interface{}{
			"cite": "Ana",
			"pm":   map[string]interface{}{"type": "pullQuote", "attrs": map[string]interface{}{"cite": "other", "data-block-id": "b1"}},
		})
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"data-block-id": "b1"}, attrsOf(doc)["pm"].(map[string]interface{})["attrs"])
		require.Equal(t, "Ana", attrsOf(doc)["cite"])
	})
}

func TestSanitize_TodoAttrs(t *testing.T) {
	t.Run("a to-do list has no attrs of its own", func(t *testing.T) {
		doc := singleBlock("todo_list", map[string]interface{}{"blockColor": "red", "start": 3, "onclick": "x"})
		doc.sanitize()
		require.Empty(t, attrsOf(doc))
	})

	t.Run("an item keeps pm, text and a boolean checked", func(t *testing.T) {
		for _, checked := range []bool{true, false} {
			doc := singleBlock("todo_item", map[string]interface{}{"checked": checked, "text": "Ship it", "class": "x"})
			doc.sanitize()
			require.Equal(t, map[string]interface{}{"checked": checked, "text": "Ship it"}, attrsOf(doc))
		}
	})

	t.Run("drops a checked that isn't a boolean (unchecked)", func(t *testing.T) {
		for _, checked := range []interface{}{"true", 1, nil, map[string]interface{}{}} {
			doc := singleBlock("todo_item", map[string]interface{}{"checked": checked})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "checked", "checked %v", checked)
		}
	})

	t.Run("removes checked from the stored pm", func(t *testing.T) {
		doc := singleBlock("todo_item", map[string]interface{}{
			"checked": true,
			"pm":      map[string]interface{}{"type": "taskItem", "attrs": map[string]interface{}{"checked": false, "data-block-id": "b1"}},
		})
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"data-block-id": "b1"}, attrsOf(doc)["pm"].(map[string]interface{})["attrs"])
		require.Equal(t, true, attrsOf(doc)["checked"])
	})
}

func TestTextBlocksNesting(t *testing.T) {
	block := func(id, typ string, attrs map[string]interface{}, children ...string) map[string]interface{} {
		b := map[string]interface{}{"id": id, "type": typ, "version": float64(1), "attrs": attrs}
		if children != nil {
			list := make([]interface{}, len(children))
			for i, c := range children {
				list[i] = c
			}
			b["children"] = list
		}
		return b
	}

	t.Run("a doc with all three stores, to-do items as the list's children", func(t *testing.T) {
		doc := BlockDocV1{
			DocVersion:  1,
			BlocksOrder: []string{"callout-01", "pullquote1", "todo-00001"},
			Blocks: map[string]interface{}{
				"callout-01": block("callout-01", "callout", map[string]interface{}{"tone": "danger", "text": "x"}),
				"pullquote1": block("pullquote1", "pull_quote", map[string]interface{}{"text": "y", "cite": "Ana"}),
				"todo-00001": block("todo-00001", "todo_list", map[string]interface{}{}, "task-00001", "task-00002"),
				"task-00001": block("task-00001", "todo_item", map[string]interface{}{"checked": true, "text": "one"}),
				"task-00002": block("task-00002", "todo_item", map[string]interface{}{"checked": false, "text": "two"}),
			},
		}
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	})

	t.Run("callout, pull quote and to-do list are flow; a to-do item isn't", func(t *testing.T) {
		for _, childType := range []string{"callout", "pull_quote", "todo_list"} {
			require.True(t, containerAccepts("group", childType), childType)
			require.True(t, isCoreBlockType(childType), childType)
		}
		require.False(t, containerAccepts("group", "todo_item"))
		require.True(t, isCoreBlockType("todo_item"))
	})

	t.Run("a callout or a to-do item has no children", func(t *testing.T) {
		for _, typ := range []string{"callout", "pull_quote", "todo_item"} {
			doc := BlockDocV1{
				DocVersion:  1,
				BlocksOrder: []string{"parent-001"},
				Blocks: map[string]interface{}{
					"parent-001": block("parent-001", typ, map[string]interface{}{}, "para-00001"),
					"para-00001": block("para-00001", "paragraph", map[string]interface{}{"text": "x"}),
				},
			}
			require.ErrorContains(t, doc.checkBlockNesting(), "has no children", typ)
		}
	})
}
