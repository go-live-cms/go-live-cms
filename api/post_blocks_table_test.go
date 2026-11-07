package api

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// #420: the table block. Its rows are in its pm; the sanitizer is an allowlist for the
// block's attrs and for the grid's node attrs (colspan and rowspan clamped, nothing else).

// bridgeTableDoc is a table exactly as the collab server's bridge writes it
// (web/gl-admin/lib/collaboration/blockBridge.ts): every cell a tableCell, spans only when
// not 1, the header row in `headerRow`, the caption as runs.
const bridgeTableDoc = `{
  "doc_version": 1,
  "blocks_order": ["blk-0420-table-000001"],
  "blocks": {
    "blk-0420-table-000001": {
      "id": "blk-0420-table-000001", "type": "table", "version": 1,
      "attrs": {
        "pm": {"type": "table", "content": [
          {"type": "tableRow", "content": [
            {"type": "tableCell", "content": [{"type": "paragraph", "attrs": {"textAlign": null, "data-block-id": null}, "content": [{"type": "text", "text": "Role"}]}]},
            {"type": "tableCell", "content": [{"type": "paragraph", "attrs": {"textAlign": null, "data-block-id": null}, "content": [{"type": "text", "text": "Publish"}]}]}
          ]},
          {"type": "tableRow", "content": [
            {"type": "tableCell", "attrs": {"colspan": 2}, "content": [{"type": "paragraph", "attrs": {"textAlign": null, "data-block-id": null}, "content": [{"type": "text", "text": "Everyone", "marks": [{"type": "link", "attrs": {"href": "https://example.com", "target": "_blank", "rel": "noopener noreferrer nofollow", "class": null}}]}]}]}
          ]}
        ]},
        "text": "Role Publish\nEveryone",
        "headerRow": true,
        "caption": [{"type": "text", "text": "Who can "}, {"type": "text", "text": "publish", "marks": [{"type": "italic"}]}]
      }
    }
  }
}`

func parseDoc(t *testing.T, raw string) *BlockDocV1 {
	t.Helper()
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal([]byte(raw), &doc))
	return &doc
}

func tableBlockOf(doc *BlockDocV1) map[string]interface{} {
	return doc.Blocks["blk-0420-table-000001"].(map[string]interface{})
}

// cellAt returns the cell node at row r, cell c of the table block's pm.
func cellAt(doc *BlockDocV1, r, c int) map[string]interface{} {
	pm := tableBlockOf(doc)["attrs"].(map[string]interface{})["pm"].(map[string]interface{})
	row := pm["content"].([]interface{})[r].(map[string]interface{})
	return row["content"].([]interface{})[c].(map[string]interface{})
}

func TestSanitize_TableKeepsTheBridgesOutput(t *testing.T) {
	// The API must store what the collab server validated, unchanged: anything it
	// rewrote would differ from the server's previous doc on every store.
	doc := parseDoc(t, bridgeTableDoc)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	want := parseDoc(t, bridgeTableDoc)
	require.Equal(t, want.Blocks, doc.Blocks)
}

func TestSanitize_TableAttrs(t *testing.T) {
	t.Run("keeps pm, text, headerRow and the caption; deletes everything else", func(t *testing.T) {
		doc := parseDoc(t, bridgeTableDoc)
		attrs := tableBlockOf(doc)["attrs"].(map[string]interface{})
		attrs["onclick"] = "x()"
		attrs["style"] = "color:red"
		attrs["align"] = "wide"
		attrs["children"] = []interface{}{"x"}
		doc.sanitize()
		got := tableBlockOf(doc)["attrs"].(map[string]interface{})
		keys := make([]string, 0, len(got))
		for k := range got {
			keys = append(keys, k)
		}
		require.ElementsMatch(t, []string{"pm", "text", "headerRow", "caption"}, keys)
	})

	t.Run("headerRow is true or absent", func(t *testing.T) {
		for _, raw := range []interface{}{false, "true", 1.0, nil} {
			doc := singleBlock("table", map[string]interface{}{"headerRow": raw, "pm": map[string]interface{}{"type": "table"}})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "headerRow", "%v", raw)
		}
		doc := singleBlock("table", map[string]interface{}{"headerRow": true})
		doc.sanitize()
		require.Equal(t, true, attrsOf(doc)["headerRow"])
	})

	t.Run("a pm that isn't a table node and a text that isn't a string are dropped", func(t *testing.T) {
		doc := singleBlock("table", map[string]interface{}{"pm": map[string]interface{}{"type": "paragraph"}, "text": 3.0})
		doc.sanitize()
		require.NotContains(t, attrsOf(doc), "pm")
		require.NotContains(t, attrsOf(doc), "text")
	})

	t.Run("the caption is reduced like an image's", func(t *testing.T) {
		caption := []interface{}{
			captionRun("ok", mark("bold", nil)),
			captionRun("x", mark("code", nil), mark("link", map[string]interface{}{"href": "javascript:alert(1)"})),
			captionRun(""),
			"not a run",
		}
		doc := singleBlock("table", map[string]interface{}{"caption": caption})
		doc.sanitize()
		got := attrsOf(doc)["caption"].([]interface{})
		require.Len(t, got, 2)
		require.Len(t, got[0].(map[string]interface{})["marks"], 1)
		require.NotContains(t, got[1], "marks")
	})
}

func TestSanitize_TableGridAttrs(t *testing.T) {
	doc := parseDoc(t, bridgeTableDoc)
	pm := tableBlockOf(doc)["attrs"].(map[string]interface{})["pm"].(map[string]interface{})
	pm["attrs"] = map[string]interface{}{"style": "width:9999px", "onmouseover": "x"}
	pm["content"].([]interface{})[0].(map[string]interface{})["attrs"] = map[string]interface{}{"class": "x"}
	spans := []map[string]interface{}{
		{"colspan": 0.0, "rowspan": 999.0, "colwidth": []interface{}{120.0}, "onclick": "x"},
		{"colspan": 2.7, "rowspan": "3", "style": "background:url(x)"},
	}
	cellAt(doc, 0, 0)["attrs"] = spans[0]
	cellAt(doc, 0, 1)["attrs"] = spans[1]
	cellAt(doc, 0, 1)["type"] = "tableHeader"
	doc.sanitize()

	require.NotContains(t, pm, "attrs", "the table node keeps no attrs")
	require.NotContains(t, pm["content"].([]interface{})[0], "attrs", "a row keeps no attrs")
	require.Equal(t, map[string]interface{}{"rowspan": float64(tableMaxSpan)}, cellAt(doc, 0, 0)["attrs"])
	require.Equal(t, map[string]interface{}{"colspan": 2.0}, cellAt(doc, 0, 1)["attrs"])
	require.Equal(t, map[string]interface{}{"colspan": 2.0}, cellAt(doc, 1, 0)["attrs"])

	// The cells' content gets the generic rules: an unsafe link mark goes, its text stays.
	link := cellAt(doc, 1, 0)["content"].([]interface{})[0].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})
	link["marks"].([]interface{})[0].(map[string]interface{})["attrs"].(map[string]interface{})["href"] = "javascript:alert(1)"
	doc.sanitize()
	require.Empty(t, link["marks"])
	require.Equal(t, "Everyone", link["text"])
}

func TestClampTableSpan(t *testing.T) {
	for _, tc := range []struct {
		in   interface{}
		want int
	}{
		{2.0, 2}, {1.0, 1}, {0.0, 1}, {-4.0, 1}, {2.9, 2}, {64.0, 64}, {65.0, 64}, {1e12, 64}, {"2", 1}, {nil, 1}, {true, 1},
	} {
		require.Equal(t, tc.want, clampTableSpan(tc.in), "%v", tc.in)
	}
}

func TestTableNesting(t *testing.T) {
	t.Run("a table is flow: a group holds one", func(t *testing.T) {
		require.True(t, flowBlockTypes["table"])
		require.True(t, containerAccepts("group", "table"))
		doc := parseDoc(t, bridgeTableDoc)
		doc.Blocks["blk-0420-group-000001"] = map[string]interface{}{
			"id": "blk-0420-group-000001", "type": "group", "version": 1.0, "attrs": map[string]interface{}{},
			"children": []interface{}{"blk-0420-table-000001"},
		}
		doc.BlocksOrder = []string{"blk-0420-group-000001"}
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	})

	t.Run("a table has no children: its rows are in its pm", func(t *testing.T) {
		doc := parseDoc(t, bridgeTableDoc)
		doc.Blocks["blk-0420-para-0000001"] = map[string]interface{}{"id": "blk-0420-para-0000001", "type": "paragraph", "version": 1.0, "attrs": map[string]interface{}{}}
		tableBlockOf(doc)["children"] = []interface{}{"blk-0420-para-0000001"}
		require.Error(t, doc.prepareForStore(ThemeBlockManifest{}))
	})
}

func TestSanitize_TableGridOnlyInTableBlocks(t *testing.T) {
	// A node of the same name in another block's pm (a pre-#376 custom block) keeps its
	// attrs: the allowlist is the table block's.
	pm := map[string]interface{}{"type": "callout", "content": []interface{}{
		map[string]interface{}{"type": "tableCell", "attrs": map[string]interface{}{"align": "right"}},
	}}
	doc := singleBlock("callout", map[string]interface{}{"pm": pm})
	doc.sanitize()
	cell := attrsOf(doc)["pm"].(map[string]interface{})["content"].([]interface{})[0].(map[string]interface{})
	require.Equal(t, map[string]interface{}{"align": "right"}, cell["attrs"])
}
