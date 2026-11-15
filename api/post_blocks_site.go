package api

// Site blocks (docs/design/theme-builder.md 4.1-4.2). Site blocks I (#488): site_title,
// site_tagline, site_logo, navigation, search and template_part. Site blocks II (#489): the
// query loop (query, post_template and query_no_results, rows of blockContainers, and
// query_pagination, an atom that lives only in a query), query_title, term_description and
// the post_* blocks. They hold no text of their own: what they show is the site's, read on
// the page. In a post they are inert, never refused (refusing one would make every later
// store of that post fail).
//
// Their attrs are allowlists with defaults left out, the same rules as the web's
// normalizeSiteBlockAttrs (web/gl-admin/lib/blocks-spec/siteBlocks.ts);
// siteBlockVectors.json pins that both agree, and where each may sit by the doc's kind.

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// blockDocKind is what a block doc is (design 4.2): a post's body, a block template or a
// template part. The template tables (#490) store the other two.
type blockDocKind string

const (
	blockDocKindPost     blockDocKind = "post"
	blockDocKindTemplate blockDocKind = "template"
	blockDocKindPart     blockDocKind = "part"
)

// siteBlockTypes are the site blocks (Block Spec SITE_BLOCK_TYPES).
var siteBlockTypes = map[string]bool{
	"site_title": true, "site_tagline": true, "site_logo": true,
	"navigation": true, "search": true, "template_part": true,
	// #489
	"query_title": true, "term_description": true, "post_title": true, "post_content": true,
	"post_excerpt": true, "post_featured_image": true, "post_date": true, "post_byline": true,
	"post_terms": true, "post_navigation": true, queryPaginationBlockType: true,
	"query": true, "post_template": true, "query_no_results": true,
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

	// #489: a query's page size (the /public/posts per_page cap) and terms, an excerpt's words.
	queryMinPerPage     = 1
	queryMaxPerPage     = 24
	queryDefaultPerPage = 10
	queryMaxTerms       = 10
	queryDefaultType    = "post"

	postExcerptMinWords     = 5
	postExcerptMaxWords     = 100
	postExcerptDefaultWords = 35

	postTermsDefaultTaxonomy = "category"
)

var (
	// A theme menu location's name (`menuLocations`, /public/menus/:location).
	menuLocationPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	// A template part's slug, as site_templates.slug's CHECK allows it.
	templatePartSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,79}$`)
	// A post type's or a taxonomy's name (identifierRe, at most 64): the web's isContentName.
	contentNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	// One id of a query's comma list of terms (the editor node's form).
	termIDPattern = regexp.MustCompile(`^\s*[0-9]+\s*$`)
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
	case "query":
		sanitizeQueryAttrs(attrs)
	case "query_title":
		keepOnlyAttrs(attrs, "level")
		if level, ok := attrs["level"].(float64); !ok || level != 2 {
			delete(attrs, "level")
		}
	case "post_title":
		keepOnlyAttrs(attrs, "level", "link")
		if level, ok := attrs["level"].(float64); !ok || level < 1 || level > 4 || level != math.Trunc(level) {
			delete(attrs, "level")
		}
		if _, ok := attrs["link"].(bool); !ok {
			delete(attrs, "link")
		}
	case "post_excerpt":
		keepOnlyAttrs(attrs, "length")
		keepClampedInt(attrs, "length", postExcerptMinWords, postExcerptMaxWords, postExcerptDefaultWords)
	case "post_featured_image":
		keepOnlyAttrs(attrs, "aspect", "link")
		if aspect := attrs["aspect"]; aspect != "16-9" && aspect != "3-2" && aspect != "1-1" {
			delete(attrs, "aspect")
		}
		keepOnlyTrue(attrs, "link")
	case "post_date":
		keepOnlyAttrs(attrs, "which", "format")
		if attrs["which"] != "modified" {
			delete(attrs, "which")
		}
		if attrs["format"] != "short" {
			delete(attrs, "format")
		}
	case "post_byline":
		keepOnlyAttrs(attrs, "avatars")
		keepOnlyFalse(attrs, "avatars")
	case "post_terms":
		keepOnlyAttrs(attrs, "taxonomy")
		if name, ok := attrs["taxonomy"].(string); !ok || !contentNamePattern.MatchString(name) || name == postTermsDefaultTaxonomy {
			delete(attrs, "taxonomy")
		}
	case "term_description", "post_content", "post_navigation", queryPaginationBlockType, "post_template", "query_no_results":
		keepOnlyAttrs(attrs)
	}
}

// sanitizeQueryAttrs keeps a query's closed vocabulary (design 4.3), each attr one /public
// list parameter: never a query string, a status or SQL. inherit only true; postType a name
// ("post" left out); perPage rounded and clamped to 1-24 (10 left out); orderBy "title";
// order "asc"; taxonomy and termIds both or neither (termIds: ids, distinct, ascending, at
// most 10; the editor node's comma list is read too); authorId a user id.
func sanitizeQueryAttrs(attrs map[string]interface{}) {
	keepOnlyAttrs(attrs, "inherit", "postType", "perPage", "orderBy", "order", "taxonomy", "termIds", "authorId")
	keepOnlyTrue(attrs, "inherit")
	if name, ok := attrs["postType"].(string); !ok || !contentNamePattern.MatchString(name) || name == queryDefaultType {
		delete(attrs, "postType")
	}
	keepClampedInt(attrs, "perPage", queryMinPerPage, queryMaxPerPage, queryDefaultPerPage)
	if attrs["orderBy"] != "title" {
		delete(attrs, "orderBy")
	}
	if attrs["order"] != "asc" {
		delete(attrs, "order")
	}
	termIDs := normalizeQueryTermIDs(attrs["termIds"])
	taxonomy, ok := attrs["taxonomy"].(string)
	if len(termIDs) == 0 || !ok || !contentNamePattern.MatchString(taxonomy) {
		delete(attrs, "taxonomy")
		delete(attrs, "termIds")
	} else {
		ids := make([]interface{}, len(termIDs))
		for i, id := range termIDs {
			ids[i] = float64(id)
		}
		attrs["termIds"] = ids
	}
	if !isPositiveID(attrs["authorId"]) {
		delete(attrs, "authorId")
	}
}

// normalizeQueryTermIDs is the web's normalizeTermIds: valid ids from an array or a comma
// list, each once, ascending, at most queryMaxTerms.
func normalizeQueryTermIDs(value interface{}) []int64 {
	var raw []interface{}
	switch v := value.(type) {
	case []interface{}:
		raw = v
	case string:
		for _, part := range strings.Split(v, ",") {
			if !termIDPattern.MatchString(part) {
				continue
			}
			if n, err := strconv.ParseFloat(strings.TrimSpace(part), 64); err == nil {
				raw = append(raw, n)
			}
		}
	}
	seen := map[int64]bool{}
	ids := []int64{}
	for _, item := range raw {
		if !isPositiveID(item) {
			continue
		}
		id := int64(item.(float64))
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	if len(ids) > queryMaxTerms {
		ids = ids[:queryMaxTerms]
	}
	return ids
}

// isPositiveID: a positive whole JSON number the web keeps exactly (isPositiveId).
func isPositiveID(value interface{}) bool {
	n, ok := value.(float64)
	return ok && n >= 1 && n == math.Trunc(n) && n <= maxSafeInteger
}

// keepClampedInt keeps attrs[name] as a number rounded like Math.round and clamped to
// minValue..maxValue, left out when that is def (the default) or it isn't a number.
func keepClampedInt(attrs map[string]interface{}, name string, minValue, maxValue, def float64) {
	n, ok := attrs[name].(float64)
	if !ok || math.IsInf(n, 0) || math.IsNaN(n) {
		delete(attrs, name)
		return
	}
	clamped := math.Min(maxValue, math.Max(minValue, roundHalfUp(n)))
	if clamped == def {
		delete(attrs, name)
		return
	}
	attrs[name] = clamped
}

// keepOnlyTrue keeps attrs[name] only when it is the boolean true (its default is false).
func keepOnlyTrue(attrs map[string]interface{}, name string) {
	if value, ok := attrs[name].(bool); !ok || !value {
		delete(attrs, name)
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
// doc's kind (the web's siteBlockKindIssues), first problem in key order. In a post nothing
// is refused. In a part, a template part never sits (at any depth or unreferenced, so parts
// are never recursive), nor a post_content (#489: a header holding the post would render it
// twice). In a template, a post_content never sits inside a query's post_template at any
// depth (it would render the route's post once per item), and there is at most one.
func (doc *BlockDocV1) checkSiteBlockPlacement(kind blockDocKind) error {
	if kind == blockDocKindPost {
		return nil
	}
	ids := make([]string, 0, len(doc.Blocks))
	for id := range doc.Blocks {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	typeOf := func(id string) string {
		block, _ := doc.Blocks[id].(map[string]interface{})
		return stringOf(block["type"])
	}
	// Each block's parent: the first block, in key order, whose children name it.
	parent := map[string]string{}
	for _, id := range ids {
		block, _ := doc.Blocks[id].(map[string]interface{})
		children, _ := block["children"].([]interface{})
		for _, child := range children {
			if childID, ok := child.(string); ok {
				if _, seen := parent[childID]; !seen {
					parent[childID] = id
				}
			}
		}
	}
	inPostTemplate := func(id string) bool {
		seen := map[string]bool{id: true}
		for at, ok := parent[id]; ok && !seen[at]; at, ok = parent[at] {
			if typeOf(at) == "post_template" {
				return true
			}
			seen[at] = true
		}
		return false
	}
	contents := 0
	for _, id := range ids {
		switch typeOf(id) {
		case "template_part":
			if kind == blockDocKindPart {
				return fmt.Errorf("block %s: a template_part can't be in a part", id)
			}
		case "post_content":
			contents++
			if kind == blockDocKindPart {
				return fmt.Errorf("block %s: a post_content can't be in a part", id)
			}
			if inPostTemplate(id) {
				return fmt.Errorf("block %s: a post_content can't be in a post_template", id)
			}
			if contents > 1 {
				return fmt.Errorf("block %s: a template holds at most one post_content", id)
			}
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
