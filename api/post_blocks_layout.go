package api

// The layout blocks' sanitizing (#426, docs/design/block-library.md 2.2, 4): columns and
// column (containers, the rows are in post_blocks_nesting.go), buttons and spacer (flow).
// Each is an allowlist like a group's: an attr outside it is deleted, an invalid value is
// dropped and the block renders with its default. The web's rules are
// `blocks-spec/layoutBlocks.ts`.

// How two columns share the row (Block Spec `COLUMNS_LAYOUTS`).
var columnsLayouts = map[string]bool{"50-50": true, "33-67": true, "67-33": true, "equal": true}

// A row of buttons' alignment and a button's style (Block Spec `BUTTONS_ALIGNS`, `BUTTON_VARIANTS`).
var buttonsAligns = map[string]bool{"left": true, "center": true}
var buttonVariants = map[string]bool{"primary": true, "secondary": true}

// spacerSizes are the steps of the theme's spacing scale a spacer may use (Block Spec
// `SPACER_SIZES`), never pixels.
var spacerSizes = map[string]bool{"5": true, "7": true, "8": true, "9": true}

// The longest href and label kept (Block Spec `BUTTON_HREF_MAX_LENGTH`, `BUTTON_LABEL_MAX_LENGTH`).
const (
	buttonHrefMaxLength = 2048
	buttonLabelMaxRunes = 200
)

// sanitizeColumnsAttrs keeps a columns block's `layout` and `align`, each only with a
// valid value. A column has no attrs of its own.
func sanitizeColumnsAttrs(attrs map[string]interface{}) {
	keepOnlyAttrs(attrs, "layout", "align")
	if s, ok := attrs["layout"].(string); !ok || !columnsLayouts[s] {
		delete(attrs, "layout")
	}
	if s, ok := attrs["align"].(string); !ok || !groupAligns[s] {
		delete(attrs, "align")
	}
}

// sanitizeButtonsAttrs (#426): `pm`, `text` and `align` only; `align` left or center; a
// `pm` that isn't a `buttons` node is dropped (the block then renders nothing). The pm is
// reduced to `button` nodes by sanitizeButtonsPM.
func sanitizeButtonsAttrs(attrs map[string]interface{}) {
	keepOnlyAttrs(attrs, "pm", "text", "align")
	if _, ok := attrs["text"].(string); !ok {
		delete(attrs, "text")
	}
	if s, ok := attrs["align"].(string); !ok || !buttonsAligns[s] {
		delete(attrs, "align")
	}
	pm, ok := attrs["pm"].(map[string]interface{})
	if !ok || pm["type"] != "buttons" {
		delete(attrs, "pm")
		return
	}
	sanitizeButtonsPM(pm)
}

// sanitizeButtonsPM makes a buttons node's content `button` nodes only (the row's own attrs
// are the block's, so its pm carries none), each with a safe `href` and a known `variant`
// (sanitizeButtonNode) and at most buttonLabelMaxRunes of plain text as its label.
func sanitizeButtonsPM(pm map[string]interface{}) {
	delete(pm, "attrs")
	content, _ := pm["content"].([]interface{})
	kept := make([]interface{}, 0, len(content))
	for _, raw := range content {
		button, ok := raw.(map[string]interface{})
		if !ok || button["type"] != "button" {
			continue
		}
		sanitizeButtonNode(button)
		delete(button, "marks")
		if label := buttonLabel(button); label != "" {
			button["content"] = []interface{}{map[string]interface{}{"type": "text", "text": label}}
		} else {
			delete(button, "content")
		}
		kept = append(kept, button)
	}
	pm["content"] = kept
}

// buttonLabel is a button's text runs as one plain string, capped (the citation's rules).
func buttonLabel(button map[string]interface{}) string {
	content, _ := button["content"].([]interface{})
	label := ""
	for _, raw := range content {
		if run, ok := raw.(map[string]interface{}); ok && run["type"] == "text" {
			label += stringOf(run["text"])
		}
	}
	attrs := map[string]interface{}{"label": label}
	sanitizePlainText(attrs, "label", buttonLabelMaxRunes)
	return stringOf(attrs["label"])
}

// sanitizeButtonNode is the allowlist for a `button` node's attrs (#426): an `href` that
// passes isSafeURL with safeHrefSchemes, and a known `variant`; an unsafe href costs the
// link, never the button (the public renderer leaves out a button with no link).
//
// A button's href is a node attr, which the link-mark check in sanitizeMarks never sees, so
// without this a `javascript:` href would reach the public page. It runs from sanitizePMNode
// too, for a `button` node in any block's pm.
func sanitizeButtonNode(node map[string]interface{}) {
	attrs, _ := node["attrs"].(map[string]interface{})
	kept := map[string]interface{}{}
	if href, ok := attrs["href"].(string); ok && href != "" && len(href) <= buttonHrefMaxLength && isSafeURL(href, safeHrefSchemes) {
		kept["href"] = href
	}
	if variant, ok := attrs["variant"].(string); ok && buttonVariants[variant] && variant != "primary" {
		kept["variant"] = variant
	}
	if len(kept) == 0 {
		delete(node, "attrs")
		return
	}
	node["attrs"] = kept
}

// sanitizeSpacerAttrs (#426): `size` only, one of the theme's steps; anything else (a pixel
// value) is dropped and the spacer renders at the default step.
func sanitizeSpacerAttrs(attrs map[string]interface{}) {
	keepOnlyAttrs(attrs, "size")
	if s, ok := attrs["size"].(string); !ok || !spacerSizes[s] {
		delete(attrs, "size")
	}
}
