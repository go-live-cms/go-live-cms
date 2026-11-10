package customhtml

import (
	"bytes"
	"encoding/json"
	"regexp"
)

// BlockType is the Block Spec type of a custom HTML block.
const BlockType = "html"

var snippetIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ValidSnippetID reports whether id has the form the API gives snippet ids (a lower-case
// UUID). The table's CHECK and the web's `isSnippetId` say the same.
func ValidSnippetID(id string) bool {
	return snippetIDPattern.MatchString(id)
}

// Snippet is one row's worth of markup, sanitized.
type Snippet struct {
	ID   string
	HTML string
}

// decodeDoc parses a stored document keeping numbers as written. ok is false for anything
// without a blocks object (a stored `{}`, for one): such a document has no html blocks.
func decodeDoc(raw json.RawMessage) (doc map[string]interface{}, blocks map[string]interface{}, ok bool) {
	// Most posts have none, and this runs on every publish.
	if !bytes.Contains(raw, []byte(`"`+BlockType+`"`)) {
		return nil, nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil {
		return nil, nil, false
	}
	blocks, ok = doc["blocks"].(map[string]interface{})
	return doc, blocks, ok
}

// eachHTMLBlock calls fn with the attrs of every html block that has any.
func eachHTMLBlock(blocks map[string]interface{}, fn func(attrs map[string]interface{})) {
	for _, raw := range blocks {
		block, ok := raw.(map[string]interface{})
		if !ok || block["type"] != BlockType {
			continue
		}
		if attrs, ok := block["attrs"].(map[string]interface{}); ok {
			fn(attrs)
		}
	}
}

// Materialize returns the document a publish stores: every html block's `attrs.html` set
// from markup (by the block's snippetId, sanitized) and removed when the block has no
// entry, so a snippetId that doesn't belong to this post renders nothing. markup holds
// only the post's own snippets. A document with no html block comes back unchanged.
func Materialize(raw json.RawMessage, markup map[string]string) (json.RawMessage, error) {
	doc, blocks, ok := decodeDoc(raw)
	if !ok {
		return raw, nil
	}
	found := false
	eachHTMLBlock(blocks, func(attrs map[string]interface{}) {
		found = true
		delete(attrs, "html")
		id, _ := attrs["snippetId"].(string)
		if html, ok := markup[id]; ok && id != "" {
			if clean := Sanitize(html); clean != "" {
				attrs["html"] = clean
			}
		}
	})
	if !found {
		return raw, nil
	}
	return json.Marshal(doc)
}

// SnippetIDs lists the snippet ids a document's html blocks use, each once.
func SnippetIDs(raw json.RawMessage) []string {
	_, blocks, ok := decodeDoc(raw)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	ids := []string{}
	eachHTMLBlock(blocks, func(attrs map[string]interface{}) {
		if id, _ := attrs["snippetId"].(string); id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	})
	return ids
}

// Markup returns a published document's markup by snippet id, sanitized again: what a
// version or a template holds. Blocks without markup are left out.
func Markup(raw json.RawMessage) map[string]string {
	_, blocks, ok := decodeDoc(raw)
	if !ok {
		return nil
	}
	markup := map[string]string{}
	eachHTMLBlock(blocks, func(attrs map[string]interface{}) {
		id, _ := attrs["snippetId"].(string)
		html, _ := attrs["html"].(string)
		if id != "" && html != "" {
			markup[id] = Sanitize(html)
		}
	})
	return markup
}

// EmptySnippetIDs lists the snippets a published document uses with no markup.
func EmptySnippetIDs(raw json.RawMessage) []string {
	markup := Markup(raw)
	var empty []string
	for _, id := range SnippetIDs(raw) {
		if _, has := markup[id]; !has {
			empty = append(empty, id)
		}
	}
	return empty
}

// Rekey prepares a copy's document (a duplicate, or a post made from a template): every
// html block whose snippetId is in source gets a new id from newID (a repeated id maps to
// one new id), blocks with any other id lose it and render nothing, and no block keeps
// inline markup. It returns the document and the new post's snippets, sanitized.
func Rekey(raw json.RawMessage, source map[string]string, newID func() string) (json.RawMessage, []Snippet, error) {
	doc, blocks, ok := decodeDoc(raw)
	if !ok {
		return raw, nil, nil
	}
	found := false
	ids := map[string]string{}
	snippets := []Snippet{}
	eachHTMLBlock(blocks, func(attrs map[string]interface{}) {
		found = true
		delete(attrs, "html")
		old, _ := attrs["snippetId"].(string)
		html, belongs := source[old]
		if old == "" || !belongs {
			delete(attrs, "snippetId")
			return
		}
		id, seen := ids[old]
		if !seen {
			id = newID()
			ids[old] = id
			snippets = append(snippets, Snippet{ID: id, HTML: Sanitize(html)})
		}
		attrs["snippetId"] = id
	})
	if !found {
		return raw, nil, nil
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return nil, nil, err
	}
	return out, snippets, nil
}
