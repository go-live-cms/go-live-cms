package api

// Site blocks I (#488, docs/design/theme-builder.md 4.1-4.2): site_title, site_tagline,
// site_logo, navigation, search and template_part. Core flow types (flowBlockTypes) that hold
// no text of their own: what they show is the site's, read on the page. In a post they are
// inert, never refused (refusing one would make every later store of that post fail).
//
// Their attrs are allowlists with defaults left out, the same rules as the web's
// normalizeSiteBlockAttrs (web/gl-admin/lib/blocks-spec/siteBlocks.ts);
// siteBlockVectors.json pins that both agree, and where each may sit by the doc's kind.

import (
	"fmt"
	"math"
	"regexp"
	"sort"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
)

// blockDocKind is what a block doc is (design 4.2): a post's body, a block template or a
// template part. The template tables (#490) store the other two.
type blockDocKind string

const (
	blockDocKindPost     blockDocKind = "post"
	blockDocKindTemplate blockDocKind = "template"
	blockDocKindPart     blockDocKind = "part"
)

// siteBlockTypes are the site blocks of #488 (Block Spec SITE_BLOCK_TYPES).
var siteBlockTypes = map[string]bool{
	"site_title": true, "site_tagline": true, "site_logo": true,
	"navigation": true, "search": true, "template_part": true,
}

const (
	siteLogoMinWidth     = 32
	siteLogoMaxWidth     = 600
	siteLogoDefaultWidth = 48

	searchLabelMaxRunes       = 80
	searchPlaceholderMaxRunes = 80
	searchButtonMaxRunes      = 40

	// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER: the largest menu id the web
	// keeps (isMenuId).
	maxSafeInteger = 1<<53 - 1
)

var (
	// A theme menu location's name (`menuLocations`, /public/menus/:location).
	menuLocationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	// A template part's slug, as site_templates.slug's CHECK allows it (one rule for both,
	// #490).
	templatePartSlugPattern = sitedesign.SlugPattern
)

// sanitizeSiteBlockAttrs keeps a site block's own attrs, each valid, defaults left out.
// Nothing else survives: not text, a pm, handlers, a stored link or a part's content.
func sanitizeSiteBlockAttrs(blockType string, attrs map[string]interface{}) {
	switch blockType {
	case "site_title":
		keepOnlyAttrs(attrs, "level", "link")
		if level, ok := attrs["level"].(float64); !ok || (level != 1 && level != 2) {
			delete(attrs, "level")
		}
		keepOnlyFalse(attrs, "link")
	case "site_tagline":
		keepOnlyAttrs(attrs)
	case "site_logo":
		keepOnlyAttrs(attrs, "width", "link")
		if width, ok := attrs["width"].(float64); ok && !math.IsInf(width, 0) && !math.IsNaN(width) {
			clamped := math.Min(siteLogoMaxWidth, math.Max(siteLogoMinWidth, roundHalfUp(width)))
			if clamped == siteLogoDefaultWidth {
				delete(attrs, "width")
			} else {
				attrs["width"] = clamped
			}
		} else {
			delete(attrs, "width")
		}
		keepOnlyFalse(attrs, "link")
	case "navigation":
		keepOnlyAttrs(attrs, "location", "menuId", "layout", "overlay")
		if id, ok := attrs["menuId"].(float64); !ok || id < 1 || id != math.Trunc(id) || id > maxSafeInteger {
			delete(attrs, "menuId")
		}
		if location, ok := attrs["location"].(string); !ok || !menuLocationPattern.MatchString(location) {
			delete(attrs, "location")
		}
		// Exactly one: a menu by id wins over a location (two people picking at once).
		if _, hasMenu := attrs["menuId"]; hasMenu {
			delete(attrs, "location")
		}
		if attrs["layout"] != "column" {
			delete(attrs, "layout")
		}
		if attrs["overlay"] != "never" {
			delete(attrs, "overlay")
		}
	case "search":
		keepOnlyAttrs(attrs, "label", "placeholder", "button")
		sanitizePlainText(attrs, "label", searchLabelMaxRunes)
		sanitizePlainText(attrs, "placeholder", searchPlaceholderMaxRunes)
		sanitizePlainText(attrs, "button", searchButtonMaxRunes)
	case "template_part":
		keepOnlyAttrs(attrs, "slug")
		if slug, ok := attrs["slug"].(string); !ok || !templatePartSlugPattern.MatchString(slug) {
			delete(attrs, "slug")
		}
	}
}

// keepOnlyFalse keeps attrs[name] only when it is the boolean false (its default is true).
func keepOnlyFalse(attrs map[string]interface{}, name string) {
	if value, ok := attrs[name].(bool); !ok || value {
		delete(attrs, name)
	}
}

// roundHalfUp rounds like JavaScript's Math.round (halves towards +Infinity), so the
// width the web stores and the one kept here agree.
func roundHalfUp(v float64) float64 {
	return math.Floor(v + 0.5)
}

// checkSiteBlockPlacement applies the placement rules of design 4.2 that depend on the
// doc's kind (the web's siteBlockKindIssues): a template part never sits in a part, at any
// depth or unreferenced, so parts are never recursive. In a post nothing is refused.
func (doc *BlockDocV1) checkSiteBlockPlacement(kind blockDocKind) error {
	if kind != blockDocKindPart {
		return nil
	}
	ids := make([]string, 0, len(doc.Blocks))
	for id := range doc.Blocks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		block, _ := doc.Blocks[id].(map[string]interface{})
		if block != nil && block["type"] == "template_part" {
			return fmt.Errorf("block %s: a template_part can't be in a part", id)
		}
	}
	return nil
}

// prepareForStoreAs is prepareForStore for a doc of kind: the same checks, then the
// placement rules of that kind. Templates and parts (#490) store through it; posts through
// prepareForStore, which is the post kind.
func (doc *BlockDocV1) prepareForStoreAs(themeBlocks ThemeBlockManifest, kind blockDocKind) error {
	switch kind {
	case blockDocKindPost, blockDocKindTemplate, blockDocKindPart:
	default:
		return fmt.Errorf("unknown block doc kind: %q", kind)
	}
	if err := doc.prepareForStore(themeBlocks); err != nil {
		return err
	}
	return doc.checkSiteBlockPlacement(kind)
}
