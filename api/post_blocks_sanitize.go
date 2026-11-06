package api

import (
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

// Server-side sanitization of Block Spec v1 documents (issue #188).
//
// Block content is structured ProseMirror JSON, not an HTML string, so an HTML
// sanitizer (bluemonday) is the wrong tool. We walk the block tree in place and
// neutralise the stored-XSS vectors the public Astro renderer would otherwise
// emit verbatim (link hrefs, image srcs, highlight colors), plus defence-in-depth
// stripping of on* handler attributes and dangerous node types.
//
// Sanitization is best-effort and never rejects the save — the malicious payload
// is simply stripped so it never reaches the database.

// Node types that must never appear in stored block content.
var disallowedNodeTypes = map[string]bool{
	"script": true, "iframe": true, "object": true, "embed": true, "style": true,
}

// URL schemes permitted in link hrefs. Anything else (javascript:, data:,
// vbscript:, file:, …) is rejected.
var safeHrefSchemes = map[string]bool{
	"http": true, "https": true, "mailto": true, "tel": true,
}

// URL schemes permitted in image srcs. Images come from /uploads (relative) or
// http(s); base64/data: is disabled in the editor and rejected here.
var safeImageSchemes = map[string]bool{
	"http": true, "https": true,
}

// Conservative allowlist for a CSS color value: hex, rgb/rgba, hsl/hsla, or a
// plain named color. Rejects anything containing url(), semicolons, etc.
var safeColorRe = regexp.MustCompile(`^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\))$`)

// sanitize walks the block document in place, neutralising stored-XSS vectors.
func (doc *BlockDocV1) sanitize() {
	for id, raw := range doc.Blocks {
		blockMap, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		sanitizeBlock(blockMap)
		doc.Blocks[id] = blockMap
	}
}

func sanitizeBlock(block map[string]interface{}) {
	attrs, ok := block["attrs"].(map[string]interface{})
	if !ok {
		return
	}

	// Defence in depth: no on* handlers at the block-attrs level.
	stripOnAttrs(attrs)

	// Image src: blank anything that isn't a safe scheme / relative URL.
	if src, ok := attrs["src"].(string); ok && !isSafeURL(src, safeImageSchemes) {
		attrs["src"] = ""
	}

	// ProseMirror node tree (paragraph/heading/blockquote/list_item carry it).
	if pm, ok := attrs["pm"].(map[string]interface{}); ok {
		sanitizePMNode(pm)
	}

	// Attrs of the core blocks' v2 (#346) and of the containers (#414, an allowlist).
	// Theme blocks may use the same names for other things, so only these types are
	// touched. `children` is checked by checkBlockNesting (prepareForStore).
	switch block["type"] {
	case "image":
		sanitizeImageAttrs(attrs)
	case "blockquote":
		sanitizeBlockquoteAttrs(attrs)
	case "group":
		sanitizeGroupAttrs(attrs)
	case "table":
		sanitizeTableAttrs(attrs)
	}

	// Block colour (#356): a palette token on the core blocks that take one.
	if colorableBlockTypes[stringOf(block["type"])] {
		sanitizeBlockColor(attrs)
	}
}

// Block colours (Block Spec `BLOCK_COLORS`): a theme token for tinted text, or the same
// token with `-background` for a tinted block. Never a free colour: the public renderer
// turns the value into a class name.
var blockColorTokens = []string{"gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"}

var blockColors = func() map[string]bool {
	m := make(map[string]bool, 2*len(blockColorTokens))
	for _, t := range blockColorTokens {
		m[t] = true
		m[t+"-background"] = true
	}
	return m
}()

// The core block types with a `blockColor` (Block Spec `COLORABLE_BLOCK_TYPES`).
var colorableBlockTypes = map[string]bool{
	"paragraph": true, "heading": true, "blockquote": true, "bullet_list": true, "ordered_list": true,
}

// The ProseMirror node types with a `blockColor` (the editor's BlockColor extension).
var colorablePMTypes = map[string]bool{
	"paragraph": true, "heading": true, "blockquote": true, "bulletList": true, "orderedList": true,
}

// sanitizeBlockColor drops a `blockColor` that isn't in the palette (the block renders
// with the theme's colours), like an unknown image width.
func sanitizeBlockColor(attrs map[string]interface{}) {
	if raw, present := attrs["blockColor"]; present {
		if s, ok := raw.(string); !ok || !blockColors[s] {
			delete(attrs, "blockColor")
		}
	}
}

// Image widths (Block Spec `IMAGE_ALIGNS`). Absent means "inline".
var imageAligns = map[string]bool{"inline": true, "wide": true, "full": true}

// Marks a caption may carry (Block Spec `CAPTION_MARKS`).
var captionMarks = map[string]bool{"bold": true, "italic": true, "link": true}

// citeMaxRunes caps a quote citation (Block Spec `CITE_MAX_LENGTH`, also in code points).
const citeMaxRunes = 300

// sanitizeImageAttrs enforces the align enum (an unknown width is dropped, so the
// image renders inline) and reduces the caption to text runs with caption marks.
func sanitizeImageAttrs(attrs map[string]interface{}) {
	if align, present := attrs["align"]; present {
		if s, ok := align.(string); !ok || !imageAligns[s] {
			delete(attrs, "align")
		}
	}

	sanitizeCaption(attrs)
}

// sanitizeCaption reduces `attrs.caption` (an image's, a table's) to non-empty text runs
// with only the caption marks, each mark sanitized; an empty or malformed one is dropped.
func sanitizeCaption(attrs map[string]interface{}) {
	raw, present := attrs["caption"]
	if !present {
		return
	}
	runs, ok := raw.([]interface{})
	if !ok {
		delete(attrs, "caption")
		return
	}
	kept := make([]interface{}, 0, len(runs))
	for _, r := range runs {
		run, ok := r.(map[string]interface{})
		if !ok || run["type"] != "text" {
			continue
		}
		text, ok := run["text"].(string)
		if !ok || text == "" {
			continue
		}
		clean := map[string]interface{}{"type": "text", "text": text}
		if marks, ok := run["marks"].([]interface{}); ok {
			allowed := make([]interface{}, 0, len(marks))
			for _, m := range marks {
				if mark, ok := m.(map[string]interface{}); ok && captionMarks[stringOf(mark["type"])] {
					allowed = append(allowed, mark)
				}
			}
			if allowed = sanitizeMarks(allowed); len(allowed) > 0 {
				clean["marks"] = allowed
			}
		}
		kept = append(kept, clean)
	}
	if len(kept) == 0 {
		delete(attrs, "caption")
		return
	}
	attrs["caption"] = kept
}

// tableMaxSpan caps a table cell's colspan and rowspan (Block Spec `TABLE_MAX_SPAN`).
const tableMaxSpan = 64

// The ProseMirror node types of a table's grid (#420) and the attrs each may keep: the
// grid and its rows none, a cell its spans only.
var tableGridNodeTypes = map[string]bool{"table": true, "tableRow": true}
var tableCellNodeTypes = map[string]bool{"tableCell": true, "tableHeader": true}

// tableBlockAttrs: the attrs a table block (#420) may have; anything else is deleted.
var tableBlockAttrs = map[string]bool{"pm": true, "text": true, "headerRow": true, "caption": true}

// sanitizeTableAttrs is an allowlist: `headerRow` is `true` or absent, the caption is
// reduced like an image's, `text` is a string, and a `pm` that isn't a table node is
// dropped (the block then renders nothing). The grid's node attrs go through
// sanitizeTableGrid, at any depth of the pm (only a table block's).
func sanitizeTableAttrs(attrs map[string]interface{}) {
	for name := range attrs {
		if !tableBlockAttrs[name] {
			delete(attrs, name)
		}
	}
	if _, ok := attrs["text"].(string); !ok {
		delete(attrs, "text")
	}
	if raw, present := attrs["headerRow"]; present {
		if b, ok := raw.(bool); !ok || !b {
			delete(attrs, "headerRow")
		}
	}
	sanitizeCaption(attrs)
	pm, ok := attrs["pm"].(map[string]interface{})
	if !ok || pm["type"] != "table" {
		delete(attrs, "pm")
		return
	}
	sanitizeTableGrid(pm)
}

// sanitizeTableGrid applies sanitizeTableNodeAttrs to a table block's pm and every node
// under it. Only a table block's: another block's node of the same name keeps its attrs.
func sanitizeTableGrid(node map[string]interface{}) {
	sanitizeTableNodeAttrs(node)
	if content, ok := node["content"].([]interface{}); ok {
		for _, child := range content {
			if childMap, ok := child.(map[string]interface{}); ok {
				sanitizeTableGrid(childMap)
			}
		}
	}
}

// sanitizeTableNodeAttrs is the allowlist for a table's grid nodes (#420): `table` and
// `tableRow` keep no attrs; a cell keeps `colspan` and `rowspan`, each an integer clamped
// to 1..tableMaxSpan and left out when 1 (a non-number is 1). Nothing else survives.
func sanitizeTableNodeAttrs(node map[string]interface{}) {
	t := stringOf(node["type"])
	if tableGridNodeTypes[t] {
		delete(node, "attrs")
		return
	}
	if !tableCellNodeTypes[t] {
		return
	}
	attrs, _ := node["attrs"].(map[string]interface{})
	kept := map[string]interface{}{}
	for _, name := range []string{"colspan", "rowspan"} {
		if span := clampTableSpan(attrs[name]); span != 1 {
			kept[name] = float64(span)
		}
	}
	if len(kept) == 0 {
		delete(node, "attrs")
		return
	}
	node["attrs"] = kept
}

// clampTableSpan reads a span as JSON decodes it (a float64) and clamps it to
// 1..tableMaxSpan; anything that isn't a finite number is 1.
func clampTableSpan(raw interface{}) int {
	f, ok := raw.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 1
	}
	f = math.Floor(f)
	if f < 1 {
		return 1
	}
	if f > tableMaxSpan {
		return tableMaxSpan
	}
	return int(f)
}

// sanitizeBlockquoteAttrs makes `cite` plain text: control characters become
// spaces, it's trimmed and capped at citeMaxRunes, and an empty one is dropped.
// A `cite` inside the stored pm node is removed: the block's own is the only one.
func sanitizeBlockquoteAttrs(attrs map[string]interface{}) {
	if pm, ok := attrs["pm"].(map[string]interface{}); ok {
		if pmAttrs, ok := pm["attrs"].(map[string]interface{}); ok {
			delete(pmAttrs, "cite")
		}
	}

	raw, present := attrs["cite"]
	if !present {
		return
	}
	cite, ok := raw.(string)
	if !ok {
		delete(attrs, "cite")
		return
	}
	cite = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, cite))
	if runes := []rune(cite); len(runes) > citeMaxRunes {
		cite = strings.TrimSpace(string(runes[:citeMaxRunes]))
	}
	if cite == "" {
		delete(attrs, "cite")
		return
	}
	attrs["cite"] = cite
}

func stringOf(v interface{}) string {
	s, _ := v.(string)
	return s
}

// sanitizePMNode recursively sanitises a ProseMirror node map in place.
func sanitizePMNode(node map[string]interface{}) {
	if nattrs, ok := node["attrs"].(map[string]interface{}); ok {
		stripOnAttrs(nattrs)
		// A nested node's colour (a tinted paragraph inside a list item) renders too. Only
		// the node types that carry one: a custom node may use the name for its own attr.
		if colorablePMTypes[stringOf(node["type"])] {
			sanitizeBlockColor(nattrs)
		}
	}

	if marks, ok := node["marks"].([]interface{}); ok {
		node["marks"] = sanitizeMarks(marks)
	}

	// Child content: drop disallowed node types, recurse into the rest.
	if content, ok := node["content"].([]interface{}); ok {
		kept := make([]interface{}, 0, len(content))
		for _, ch := range content {
			childMap, ok := ch.(map[string]interface{})
			if !ok {
				kept = append(kept, ch)
				continue
			}
			if t, _ := childMap["type"].(string); disallowedNodeTypes[t] {
				continue // drop dangerous node entirely
			}
			sanitizePMNode(childMap)
			kept = append(kept, childMap)
		}
		node["content"] = kept
	}
}

// sanitizeMarks strips on* attrs, removes link marks with unsafe hrefs (keeping
// the text), and drops unsafe highlight colors.
func sanitizeMarks(marks []interface{}) []interface{} {
	kept := make([]interface{}, 0, len(marks))
	for _, m := range marks {
		markMap, ok := m.(map[string]interface{})
		if !ok {
			kept = append(kept, m)
			continue
		}

		mType, _ := markMap["type"].(string)
		mAttrs, _ := markMap["attrs"].(map[string]interface{})
		if mAttrs != nil {
			stripOnAttrs(mAttrs)
		}

		switch mType {
		case "link":
			if mAttrs != nil {
				if href, ok := mAttrs["href"].(string); ok && !isSafeURL(href, safeHrefSchemes) {
					continue // drop the whole link mark; the text content remains
				}
			}
		case "highlight":
			if mAttrs != nil {
				if color, ok := mAttrs["color"].(string); ok && !isSafeColor(color) {
					delete(mAttrs, "color")
				}
			}
		}

		kept = append(kept, markMap)
	}
	return kept
}

func stripOnAttrs(attrs map[string]interface{}) {
	for k := range attrs {
		if strings.HasPrefix(strings.ToLower(k), "on") {
			delete(attrs, k)
		}
	}
}

// isSafeURL returns true for an empty string, a relative URL (no scheme), or a
// URL whose scheme is in `allowed`. Control characters (used to smuggle
// "java\tscript:") cause rejection.
func isSafeURL(raw string, allowed map[string]bool) bool {
	s := strings.TrimSpace(raw)
	if s == "" {
		return true
	}
	if strings.ContainsAny(s, "\x00\n\r\t") {
		return false
	}
	u, err := url.Parse(s)
	if err != nil {
		return false
	}
	if u.Scheme == "" {
		return true // relative URL (/uploads/x.png, #anchor, ?q=1, …)
	}
	return allowed[strings.ToLower(u.Scheme)]
}

func isSafeColor(color string) bool {
	c := strings.TrimSpace(color)
	if c == "" {
		return true
	}
	return safeColorRe.MatchString(c)
}
