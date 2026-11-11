package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestFootnotesNestingTable(t *testing.T) {
	require.True(t, containerAccepts("footnotes", "footnote"))
	for _, childType := range []string{"paragraph", "image", "footnotes", "group", "list_item", "theme:example/alert"} {
		require.False(t, containerAccepts("footnotes", childType), childType)
	}
	require.False(t, containerAccepts("group", "footnotes"))
	require.False(t, containerAccepts("group", "footnote"))
	require.True(t, isCoreBlockType("footnote"))
	require.False(t, isFlowBlockType("footnote"))
}

func footnotesDoc(t *testing.T, noteAttrs string) BlockDocV1 {
	t.Helper()
	return parseVectorDoc(t, json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["para-00001", "notes-0001"],
		"blocks": {
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {"text": "Claim", "pm": {"type": "paragraph", "content": [
				{"type": "text", "text": "Claim"},
				{"type": "footnoteRef", "attrs": {"footnoteId": "note-00001", "number": 7, "onclick": "x"}, "content": [{"type": "text", "text": "smuggled"}]}
			]}}},
			"notes-0001": {"id": "notes-0001", "type": "footnotes", "version": 1, "attrs": {"style": "x"}, "children": ["note-00001"]},
			"note-00001": {"id": "note-00001", "type": "footnote", "version": 1, "attrs": `+noteAttrs+`}
		}
	}`))
}

func blockAttrs(doc BlockDocV1, id string) map[string]interface{} {
	return doc.Blocks[id].(map[string]interface{})["attrs"].(map[string]interface{})
}

func TestSanitize_Footnotes(t *testing.T) {
	t.Run("a reference keeps its target and nothing else", func(t *testing.T) {
		doc := footnotesDoc(t, `{"text": "Note"}`)
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		content := blockAttrs(doc, "para-00001")["pm"].(map[string]interface{})["content"].([]interface{})
		require.Equal(t, map[string]interface{}{"type": "footnoteRef", "attrs": map[string]interface{}{"footnoteId": "note-00001"}}, content[1])
	})

	t.Run("a reference with no valid target is dropped, even with a label", func(t *testing.T) {
		doc := parseVectorDoc(t, json.RawMessage(`{"doc_version": 1, "blocks_order": ["para-00001"], "blocks": {
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {"pm": {"type": "paragraph", "content": [
				{"type": "text", "text": "a"},
				{"type": "footnoteRef", "attrs": {"footnoteId": "<script>", "label": "visible"}}
			]}}}
		}}`))
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		content := blockAttrs(doc, "para-00001")["pm"].(map[string]interface{})["content"].([]interface{})
		require.Len(t, content, 1)
	})

	t.Run("the list has no attrs", func(t *testing.T) {
		doc := footnotesDoc(t, `{"text": "Note"}`)
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		require.Empty(t, blockAttrs(doc, "notes-0001"))
	})

	t.Run("a note is an allowlist", func(t *testing.T) {
		doc := footnotesDoc(t, `{"text": "Note", "onclick": "x", "number": 3, "pm": {"type": "footnote", "content": [
			{"type": "text", "text": "Note", "marks": [{"type": "bold"}, {"type": "spoiler"}]}
		]}}`)
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		attrs := blockAttrs(doc, "note-00001")
		require.ElementsMatch(t, []string{"pm", "text"}, keysOfMap(attrs))
		text := attrs["pm"].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})
		require.Equal(t, []interface{}{map[string]interface{}{"type": "bold"}}, text["marks"])
	})

	t.Run("a note can't hold a reference", func(t *testing.T) {
		doc := footnotesDoc(t, `{"pm": {"type": "footnote", "content": [
			{"type": "text", "text": "x"},
			{"type": "footnoteRef", "attrs": {"footnoteId": "note-00001"}}
		]}}`)
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		content := blockAttrs(doc, "note-00001")["pm"].(map[string]interface{})["content"].([]interface{})
		require.Len(t, content, 1)
	})

	t.Run("a pm that isn't a note is dropped, and a non-string text", func(t *testing.T) {
		doc := footnotesDoc(t, `{"text": 3, "pm": {"type": "paragraph"}}`)
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		require.Empty(t, blockAttrs(doc, "note-00001"))
	})

	t.Run("a note nothing refers to is kept", func(t *testing.T) {
		doc := parseVectorDoc(t, json.RawMessage(`{"doc_version": 1, "blocks_order": ["para-00001", "notes-0001"], "blocks": {
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {"text": "No refs"}},
			"notes-0001": {"id": "notes-0001", "type": "footnotes", "version": 1, "attrs": {}, "children": ["note-00001"]},
			"note-00001": {"id": "note-00001", "type": "footnote", "version": 1, "attrs": {"text": "Orphan"}}
		}}`))
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		require.Contains(t, doc.Blocks, "note-00001")
		require.Equal(t, "Orphan", blockAttrs(doc, "note-00001")["text"])
	})
}

func keysOfMap(m map[string]interface{}) []string {
	out := make([]string, 0, len(m))
	for key := range m {
		out = append(out, key)
	}
	return out
}

// Duplicating a post (#354) and using a template (#322) give every block a new id, so the
// references have to follow their notes or every footnote of the copy would be stale.
func TestRegenerateBlockIDsFootnotes(t *testing.T) {
	raw := json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["para-00001", "notes-0001"],
		"blocks": {
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {"pm": {"type": "paragraph", "attrs": {"data-block-id": "para-00001"}, "content": [
				{"type": "footnoteRef", "attrs": {"footnoteId": "note-00001"}},
				{"type": "footnoteRef", "attrs": {"footnoteId": "note-00001"}},
				{"type": "footnoteRef", "attrs": {"footnoteId": "note-stale1"}}
			]}}},
			"notes-0001": {"id": "notes-0001", "type": "footnotes", "version": 1, "attrs": {}, "children": ["note-00001"]},
			"note-00001": {"id": "note-00001", "type": "footnote", "version": 1, "attrs": {"pm": {"type": "footnote", "attrs": {"data-block-id": "note-00001"}}, "text": "N"}}
		}
	}`)
	out, err := regenerateBlockIDs(raw, uuid.NewString)
	require.NoError(t, err)
	require.False(t, strings.Contains(string(out), "note-00001"), "no old note id is left: %s", out)

	var doc BlockDocV1
	require.NoError(t, json.Unmarshal(out, &doc))
	list := doc.Blocks[doc.BlocksOrder[1]].(map[string]interface{})
	noteID := list["children"].([]interface{})[0].(string)
	require.Equal(t, "footnote", doc.Blocks[noteID].(map[string]interface{})["type"])

	content := blockAttrs(doc, doc.BlocksOrder[0])["pm"].(map[string]interface{})["content"].([]interface{})
	target := func(i int) string {
		return content[i].(map[string]interface{})["attrs"].(map[string]interface{})["footnoteId"].(string)
	}
	require.Equal(t, noteID, target(0), "a reference follows its note")
	require.Equal(t, noteID, target(1), "both references do")
	require.NotEqual(t, noteID, target(2), "a stale reference stays stale")
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
}
