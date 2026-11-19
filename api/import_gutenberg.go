package api

import (
	"encoding/json"
	"regexp"
	"strings"
)

// The block editor's serialization (WordPress's parse_blocks): blocks are HTML comments
// around their saved HTML, `<!-- wp:name {json} -->…<!-- /wp:name -->` or self-closing
// `<!-- wp:name {json} /-->`. A name without a namespace is core's. Anything between
// top-level blocks is freeform (classic) HTML.

// wpBlock is one parsed block. content holds the block's own HTML pieces with a nil entry
// where each inner block sits (WordPress's innerContent), so its full HTML can be rebuilt.
type wpBlock struct {
	name    string // "core/paragraph"; "" for freeform HTML
	attrs   map[string]any
	inner   []*wpBlock
	content []*string
}

var wpBlockComment = regexp.MustCompile(`<!--\s+(/)?wp:([a-z][a-z0-9_-]*/)?([a-z][a-z0-9_-]*)\s+(\{.*?\}\s+)?(/)?-->`)

// maxWPBlockDepth caps nesting while parsing (a real post nests a few levels).
const maxWPBlockDepth = 32

// parseWPBlocks parses a post's content into its top-level blocks.
func parseWPBlocks(content string) []*wpBlock {
	var top []*wpBlock
	var stack []*wpBlock
	addText := func(s string) {
		if s == "" {
			return
		}
		if len(stack) == 0 {
			if strings.TrimSpace(s) != "" {
				top = append(top, &wpBlock{content: []*string{&s}})
			}
			return
		}
		cur := stack[len(stack)-1]
		cur.content = append(cur.content, &s)
	}
	addBlock := func(b *wpBlock) {
		if len(stack) == 0 {
			top = append(top, b)
			return
		}
		cur := stack[len(stack)-1]
		cur.inner = append(cur.inner, b)
		cur.content = append(cur.content, nil)
	}
	pos := 0
	for _, m := range wpBlockComment.FindAllStringSubmatchIndex(content, -1) {
		addText(content[pos:m[0]])
		pos = m[1]
		closing := m[2] >= 0
		ns := "core/"
		if m[4] >= 0 {
			ns = content[m[4]:m[5]]
		}
		name := ns + content[m[6]:m[7]]
		selfClosing := m[10] >= 0
		if closing {
			// Close the matching block (and any left open inside it).
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].name == name {
					for len(stack) > i {
						b := stack[len(stack)-1]
						stack = stack[:len(stack)-1]
						addBlock(b)
					}
					break
				}
			}
			continue
		}
		b := &wpBlock{name: name, attrs: map[string]any{}}
		if m[8] >= 0 {
			_ = json.Unmarshal([]byte(strings.TrimSpace(content[m[8]:m[9]])), &b.attrs)
			if b.attrs == nil {
				b.attrs = map[string]any{}
			}
		}
		if selfClosing || len(stack) >= maxWPBlockDepth {
			addBlock(b)
			continue
		}
		stack = append(stack, b)
	}
	addText(content[pos:])
	// Blocks never closed: close them in order.
	for len(stack) > 0 {
		b := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		addBlock(b)
	}
	return top
}

// html is the block's whole saved HTML: its own pieces with each inner block's HTML in
// place (comments left out).
func (b *wpBlock) html() string {
	var out strings.Builder
	inner := 0
	for _, piece := range b.content {
		if piece == nil {
			if inner < len(b.inner) {
				out.WriteString(b.inner[inner].html())
			}
			inner++
			continue
		}
		out.WriteString(*piece)
	}
	return out.String()
}

// ownHTML is the block's HTML without its inner blocks (a group's wrapper, a cover's).
func (b *wpBlock) ownHTML() string {
	var out strings.Builder
	for _, piece := range b.content {
		if piece != nil {
			out.WriteString(*piece)
		}
	}
	return out.String()
}

func (b *wpBlock) attrString(key string) string {
	s, _ := b.attrs[key].(string)
	return s
}

func (b *wpBlock) attrNumber(key string) (float64, bool) {
	switch v := b.attrs[key].(type) {
	case float64:
		return v, true
	case string:
		var f float64
		if err := json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimSpace(v), "px")), &f); err == nil {
			return f, true
		}
	}
	return 0, false
}

func (b *wpBlock) attrBool(key string) bool {
	v, _ := b.attrs[key].(bool)
	return v
}

// wpBlockLabel names a block for the report: "Latest posts block", "Contact form block
// (jetpack)".
func wpBlockLabel(name string) string {
	ns, local, found := strings.Cut(name, "/")
	if !found {
		local, ns = ns, "core"
	}
	label := strings.ReplaceAll(local, "-", " ")
	if label != "" {
		label = strings.ToUpper(label[:1]) + label[1:]
	}
	if ns == "core" || ns == "core-embed" {
		return label + " block"
	}
	return label + " block (" + ns + ")"
}
