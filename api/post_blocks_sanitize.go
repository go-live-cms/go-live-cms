package api

import (
	"net/url"
	"regexp"
	"strings"
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
}

// sanitizePMNode recursively sanitises a ProseMirror node map in place.
func sanitizePMNode(node map[string]interface{}) {
	if nattrs, ok := node["attrs"].(map[string]interface{}); ok {
		stripOnAttrs(nattrs)
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
