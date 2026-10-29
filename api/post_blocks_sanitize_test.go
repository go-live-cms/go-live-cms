package api

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

// paragraphWithText builds a one-block doc whose paragraph carries a single text
// node with the given marks + node attrs, mirroring how pmToBlockDoc stores content.
func paragraphWithText(text string, marks []interface{}, nodeAttrs map[string]interface{}) *BlockDocV1 {
	textNode := map[string]interface{}{"type": "text", "text": text}
	if marks != nil {
		textNode["marks"] = marks
	}
	pm := map[string]interface{}{
		"type":    "paragraph",
		"content": []interface{}{textNode},
	}
	if nodeAttrs != nil {
		pm["attrs"] = nodeAttrs
	}
	return &BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"b1"},
		Blocks: map[string]interface{}{
			"b1": map[string]interface{}{
				"id": "b1", "type": "paragraph", "version": 1,
				"attrs": map[string]interface{}{"pm": pm},
			},
		},
	}
}

func firstTextNode(t *testing.T, doc *BlockDocV1) map[string]interface{} {
	t.Helper()
	b := doc.Blocks["b1"].(map[string]interface{})
	pm := b["attrs"].(map[string]interface{})["pm"].(map[string]interface{})
	content := pm["content"].([]interface{})
	require.NotEmpty(t, content)
	return content[0].(map[string]interface{})
}

func linkMark(href string) []interface{} {
	return []interface{}{
		map[string]interface{}{"type": "link", "attrs": map[string]interface{}{"href": href}},
	}
}

func TestSanitize_LinkHref(t *testing.T) {
	t.Run("removes a javascript: link mark but keeps the text", func(t *testing.T) {
		doc := paragraphWithText("click me", linkMark("javascript:alert(1)"), nil)
		doc.sanitize()
		node := firstTextNode(t, doc)
		require.Equal(t, "click me", node["text"])
		marks, _ := node["marks"].([]interface{})
		require.Empty(t, marks, "javascript: link mark must be stripped")
	})

	t.Run("rejects data: and vbscript: hrefs", func(t *testing.T) {
		for _, href := range []string{"data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "java\tscript:alert(1)"} {
			doc := paragraphWithText("x", linkMark(href), nil)
			doc.sanitize()
			marks, _ := firstTextNode(t, doc)["marks"].([]interface{})
			require.Empty(t, marks, "unsafe href %q must be stripped", href)
		}
	})

	t.Run("preserves safe hrefs (https, mailto, relative)", func(t *testing.T) {
		for _, href := range []string{"https://example.com", "http://example.com/x?y=1", "mailto:a@b.com", "/internal/page", "#anchor"} {
			doc := paragraphWithText("x", linkMark(href), nil)
			doc.sanitize()
			marks, _ := firstTextNode(t, doc)["marks"].([]interface{})
			require.Len(t, marks, 1, "safe href %q must be preserved", href)
		}
	})
}

func TestSanitize_ImageSrc(t *testing.T) {
	imageDoc := func(src string) *BlockDocV1 {
		return &BlockDocV1{
			DocVersion:  1,
			BlocksOrder: []string{"img"},
			Blocks: map[string]interface{}{
				"img": map[string]interface{}{
					"id": "img", "type": "image", "version": 1,
					"attrs": map[string]interface{}{"src": src, "alt": "x"},
				},
			},
		}
	}
	srcOf := func(doc *BlockDocV1) string {
		return doc.Blocks["img"].(map[string]interface{})["attrs"].(map[string]interface{})["src"].(string)
	}

	t.Run("blanks javascript: and data: srcs", func(t *testing.T) {
		for _, src := range []string{"javascript:alert(1)", "data:text/html,<script>alert(1)</script>"} {
			doc := imageDoc(src)
			doc.sanitize()
			require.Equal(t, "", srcOf(doc), "unsafe src %q must be blanked", src)
		}
	})

	t.Run("preserves http(s) and relative /uploads srcs", func(t *testing.T) {
		for _, src := range []string{"https://cdn.example.com/a.png", "/uploads/media/a.png"} {
			doc := imageDoc(src)
			doc.sanitize()
			require.Equal(t, src, srcOf(doc), "safe src %q must be preserved", src)
		}
	})
}

func TestSanitize_DangerousNodesAndAttrs(t *testing.T) {
	t.Run("drops script/iframe child nodes", func(t *testing.T) {
		doc := &BlockDocV1{
			DocVersion:  1,
			BlocksOrder: []string{"b1"},
			Blocks: map[string]interface{}{
				"b1": map[string]interface{}{
					"id": "b1", "type": "paragraph", "version": 1,
					"attrs": map[string]interface{}{
						"pm": map[string]interface{}{
							"type": "paragraph",
							"content": []interface{}{
								map[string]interface{}{"type": "text", "text": "ok"},
								map[string]interface{}{"type": "script", "content": []interface{}{map[string]interface{}{"type": "text", "text": "alert(1)"}}},
								map[string]interface{}{"type": "iframe"},
							},
						},
					},
				},
			},
		}
		doc.sanitize()
		b := doc.Blocks["b1"].(map[string]interface{})
		content := b["attrs"].(map[string]interface{})["pm"].(map[string]interface{})["content"].([]interface{})
		require.Len(t, content, 1, "script and iframe nodes must be dropped")
		require.Equal(t, "text", content[0].(map[string]interface{})["type"])
	})

	t.Run("strips on* handler attributes from node and mark attrs", func(t *testing.T) {
		marks := []interface{}{
			map[string]interface{}{"type": "bold", "attrs": map[string]interface{}{"onmouseover": "alert(1)"}},
		}
		nodeAttrs := map[string]interface{}{"textAlign": "left", "onclick": "alert(1)", "ONLOAD": "x"}
		doc := paragraphWithText("hi", marks, nodeAttrs)
		doc.sanitize()

		node := firstTextNode(t, doc)
		pm := doc.Blocks["b1"].(map[string]interface{})["attrs"].(map[string]interface{})["pm"].(map[string]interface{})
		gotNodeAttrs := pm["attrs"].(map[string]interface{})
		require.Equal(t, "left", gotNodeAttrs["textAlign"], "legit attrs preserved")
		require.NotContains(t, gotNodeAttrs, "onclick")
		require.NotContains(t, gotNodeAttrs, "ONLOAD")

		markAttrs := node["marks"].([]interface{})[0].(map[string]interface{})["attrs"].(map[string]interface{})
		require.NotContains(t, markAttrs, "onmouseover")
	})
}

func TestSanitize_HighlightColor(t *testing.T) {
	highlight := func(color string) []interface{} {
		return []interface{}{map[string]interface{}{"type": "highlight", "attrs": map[string]interface{}{"color": color}}}
	}
	colorOf := func(doc *BlockDocV1) (string, bool) {
		attrs := firstTextNode(t, doc)["marks"].([]interface{})[0].(map[string]interface{})["attrs"].(map[string]interface{})
		c, ok := attrs["color"].(string)
		return c, ok
	}

	t.Run("drops unsafe color values", func(t *testing.T) {
		doc := paragraphWithText("x", highlight("red; background:url(data:image/svg+xml,<svg onload=alert(1)>)"), nil)
		doc.sanitize()
		_, ok := colorOf(doc)
		require.False(t, ok, "unsafe color must be removed")
	})

	t.Run("keeps safe color values", func(t *testing.T) {
		for _, c := range []string{"#ffeb3b", "rgb(255, 235, 59)", "yellow"} {
			doc := paragraphWithText("x", highlight(c), nil)
			doc.sanitize()
			got, ok := colorOf(doc)
			require.True(t, ok, "safe color %q must be kept", c)
			require.Equal(t, c, got)
		}
	})
}

func TestSanitize_SafeContentUnchanged(t *testing.T) {
	doc := paragraphWithText("hello world", linkMark("https://example.com"), map[string]interface{}{"textAlign": "center"})
	doc.sanitize()
	node := firstTextNode(t, doc)
	require.Equal(t, "hello world", node["text"])
	require.Len(t, node["marks"].([]interface{}), 1)
}

func TestIsSafeURL(t *testing.T) {
	require.True(t, isSafeURL("", safeHrefSchemes))
	require.True(t, isSafeURL("/uploads/x.png", safeImageSchemes))
	require.True(t, isSafeURL("https://x.com", safeImageSchemes))
	require.False(t, isSafeURL("javascript:alert(1)", safeHrefSchemes))
	require.False(t, isSafeURL("data:text/html,x", safeImageSchemes))
	require.False(t, isSafeURL("JavaScript:alert(1)", safeHrefSchemes), "scheme check is case-insensitive")
}

func TestIsSafeColor(t *testing.T) {
	require.True(t, isSafeColor("#fff"))
	require.True(t, isSafeColor("rgba(0,0,0,.5)"))
	require.True(t, isSafeColor("transparent"))
	require.False(t, isSafeColor("red;url(x)"))
	require.False(t, isSafeColor("url(javascript:alert(1))"))
}

// singleBlock builds a one-block doc of the given type and attrs.
func singleBlock(blockType string, attrs map[string]interface{}) *BlockDocV1 {
	return &BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"b1"},
		Blocks: map[string]interface{}{
			"b1": map[string]interface{}{"id": "b1", "type": blockType, "version": 2, "attrs": attrs},
		},
	}
}

func attrsOf(doc *BlockDocV1) map[string]interface{} {
	return doc.Blocks["b1"].(map[string]interface{})["attrs"].(map[string]interface{})
}

func captionRun(text string, marks ...interface{}) map[string]interface{} {
	run := map[string]interface{}{"type": "text", "text": text}
	if len(marks) > 0 {
		run["marks"] = marks
	}
	return run
}

func mark(markType string, attrs map[string]interface{}) map[string]interface{} {
	m := map[string]interface{}{"type": markType}
	if attrs != nil {
		m["attrs"] = attrs
	}
	return m
}

// #346: image caption and width.
func TestSanitize_ImageCaption(t *testing.T) {
	t.Run("keeps bold, italic and safe links", func(t *testing.T) {
		caption := []interface{}{
			captionRun("Photo by "),
			captionRun("Ada", mark("bold", nil), mark("link", map[string]interface{}{"href": "https://example.com"})),
			captionRun(" 2026", mark("italic", nil)),
		}
		doc := singleBlock("image", map[string]interface{}{"src": "/uploads/a.png", "caption": caption})
		doc.sanitize()
		got := attrsOf(doc)["caption"].([]interface{})
		require.Len(t, got, 3)
		require.Len(t, got[1].(map[string]interface{})["marks"], 2)
		require.Len(t, got[2].(map[string]interface{})["marks"], 1)
	})

	t.Run("strips marks a caption can't carry, unsafe links and on* attrs", func(t *testing.T) {
		caption := []interface{}{
			captionRun("a", mark("underline", nil), mark("code", nil), mark("italic", map[string]interface{}{"onclick": "x"})),
			captionRun("b", mark("highlight", map[string]interface{}{"color": "red"}), mark("link", map[string]interface{}{"href": "javascript:alert(1)"})),
		}
		doc := singleBlock("image", map[string]interface{}{"caption": caption})
		doc.sanitize()
		got := attrsOf(doc)["caption"].([]interface{})
		require.Len(t, got, 2)
		a := got[0].(map[string]interface{})
		require.Equal(t, "a", a["text"])
		marks := a["marks"].([]interface{})
		require.Len(t, marks, 1)
		require.Equal(t, "italic", marks[0].(map[string]interface{})["type"])
		require.NotContains(t, marks[0].(map[string]interface{})["attrs"], "onclick")
		b := got[1].(map[string]interface{})
		require.Equal(t, "b", b["text"])
		require.NotContains(t, b, "marks", "no allowed mark left")
	})

	t.Run("drops runs that aren't text, and extra keys on runs", func(t *testing.T) {
		caption := []interface{}{
			map[string]interface{}{"type": "hardBreak"},
			map[string]interface{}{"type": "script", "text": "alert(1)"},
			map[string]interface{}{"type": "text", "text": ""},
			map[string]interface{}{"type": "text", "text": 5},
			"loose string",
			map[string]interface{}{"type": "text", "text": "kept", "attrs": map[string]interface{}{"onload": "x"}},
		}
		doc := singleBlock("image", map[string]interface{}{"caption": caption})
		doc.sanitize()
		got := attrsOf(doc)["caption"].([]interface{})
		require.Equal(t, []interface{}{map[string]interface{}{"type": "text", "text": "kept"}}, got)
	})

	t.Run("removes a caption that isn't a list, or ends up empty", func(t *testing.T) {
		for _, caption := range []interface{}{"<b>html</b>", map[string]interface{}{"type": "text"}, []interface{}{}, []interface{}{map[string]interface{}{"type": "hardBreak"}}} {
			doc := singleBlock("image", map[string]interface{}{"caption": caption})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "caption", "caption %v", caption)
		}
	})
}

func TestSanitize_ImageAlign(t *testing.T) {
	t.Run("keeps the widths", func(t *testing.T) {
		for _, align := range []string{"inline", "wide", "full"} {
			doc := singleBlock("image", map[string]interface{}{"align": align})
			doc.sanitize()
			require.Equal(t, align, attrsOf(doc)["align"])
		}
	})

	t.Run("drops anything else, so the image renders inline", func(t *testing.T) {
		for _, align := range []interface{}{"huge", "WIDE", "left", "", 1, nil, []interface{}{"wide"}} {
			doc := singleBlock("image", map[string]interface{}{"align": align})
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "align", "align %v", align)
		}
	})

	t.Run("leaves other block types' attrs of the same name alone", func(t *testing.T) {
		doc := singleBlock("callout", map[string]interface{}{"align": "left", "caption": "theme text", "cite": 7})
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"align": "left", "caption": "theme text", "cite": 7}, attrsOf(doc))
	})
}

// #346: quote citation.
func TestSanitize_BlockquoteCite(t *testing.T) {
	quote := func(cite interface{}) *BlockDocV1 {
		return singleBlock("blockquote", map[string]interface{}{"text": "q", "cite": cite})
	}

	t.Run("keeps plain text, trimmed, with control characters as spaces", func(t *testing.T) {
		doc := quote("  Ada\tLovelace\n ")
		doc.sanitize()
		require.Equal(t, "Ada Lovelace", attrsOf(doc)["cite"])

		doc = quote("<b>not html</b>")
		doc.sanitize()
		require.Equal(t, "<b>not html</b>", attrsOf(doc)["cite"], "stays text; the renderer escapes it")
	})

	t.Run("caps an overlong cite at citeMaxRunes runes", func(t *testing.T) {
		doc := quote(strings.Repeat("é", citeMaxRunes+50))
		doc.sanitize()
		require.Equal(t, citeMaxRunes, utf8.RuneCountInString(attrsOf(doc)["cite"].(string)))

		doc = quote(strings.Repeat("x", citeMaxRunes))
		doc.sanitize()
		require.Len(t, attrsOf(doc)["cite"], citeMaxRunes, "exactly the cap is kept")
	})

	t.Run("removes a blank or non-string cite", func(t *testing.T) {
		for _, cite := range []interface{}{"", "   \n", 42, map[string]interface{}{"text": "x"}, []interface{}{"x"}} {
			doc := quote(cite)
			doc.sanitize()
			require.NotContains(t, attrsOf(doc), "cite", "cite %v", cite)
		}
	})

	t.Run("removes a cite from the stored pm node", func(t *testing.T) {
		doc := singleBlock("blockquote", map[string]interface{}{
			"cite": "Ada",
			"pm":   map[string]interface{}{"type": "blockquote", "attrs": map[string]interface{}{"cite": "other", "data-block-id": "b1"}},
		})
		doc.sanitize()
		pmAttrs := attrsOf(doc)["pm"].(map[string]interface{})["attrs"].(map[string]interface{})
		require.Equal(t, map[string]interface{}{"data-block-id": "b1"}, pmAttrs)
		require.Equal(t, "Ada", attrsOf(doc)["cite"])
	})

	t.Run("an old quote without cite is unchanged", func(t *testing.T) {
		doc := singleBlock("blockquote", map[string]interface{}{"text": "q"})
		doc.sanitize()
		require.Equal(t, map[string]interface{}{"text": "q"}, attrsOf(doc))
	})
}
