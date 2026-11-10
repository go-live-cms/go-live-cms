// Package customhtml holds the rules of the custom HTML block (#428): the sanitizer and
// what moves markup in and out of a Block Spec document. The api package (the write
// routes) and the db package (publish, duplicate, templates, restore) both use it, so
// there is one sanitizer and no publish path can leave it out.
//
// This is the one place the public site outputs raw HTML, so the rule is an allowlist:
// only the elements, attributes, URL schemes, CSS properties and CSS functions named here
// survive. What isn't listed is removed, whatever it is called or however it is encoded.
// bluemonday does the HTML (it parses with golang.org/x/net/html and writes back only
// what the policy keeps); nothing here filters HTML by hand. Its CSS hook is given the
// value of each declaration, which safeCSSValue checks.
//
// Left out on purpose:
//   - script, style, iframe, object, embed, form controls, svg and math (with its
//     mXSS vectors): not listed, so they never come back; the content of script, style
//     and the like is dropped with them.
//   - every on* handler: no attribute is allowed by pattern.
//   - id and name: DOM clobbering, and an id could collide with the page's `b-<id>` block
//     anchors.
//   - data-*: the public page's own scripts read them. /gl-embeds.js builds a player from
//     data-embed-provider and data-embed-ref, which would let custom HTML load an embed
//     the site's Allowed embeds refuses.
//   - position and transform in style: a block could cover the page around it.
package customhtml

import (
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
)

// MaxHTMLBytes caps one snippet's markup as the admin sends it (the API's binding).
const MaxHTMLBytes = 100 * 1024

var (
	elements = []string{
		// Sections and text
		"address", "article", "aside", "blockquote", "br", "caption", "center", "cite", "code",
		"col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption",
		"figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "ins", "kbd",
		"li", "main", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp",
		"section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
		"tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr", "abbr", "b", "bdi", "bdo",
		// Links and images, their URLs checked below
		"a", "img",
	}

	cssProperties = []string{
		"color", "opacity",
		"background", "background-color", "background-image", "background-position",
		"background-repeat", "background-size",
		"font", "font-family", "font-size", "font-style", "font-variant", "font-weight",
		"letter-spacing", "line-height", "text-align", "text-decoration", "text-indent",
		"text-transform", "vertical-align", "white-space", "word-break", "word-spacing",
		"overflow-wrap",
		"margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "margin-inline",
		"margin-block", "padding", "padding-top", "padding-right", "padding-bottom",
		"padding-left", "padding-inline", "padding-block",
		"border", "border-top", "border-right", "border-bottom", "border-left", "border-color",
		"border-style", "border-width", "border-radius", "border-collapse", "border-spacing",
		"outline", "box-shadow", "box-sizing",
		"width", "min-width", "max-width", "height", "min-height", "max-height", "aspect-ratio",
		"display", "float", "clear", "overflow", "overflow-x", "overflow-y",
		"flex", "flex-basis", "flex-direction", "flex-flow", "flex-grow", "flex-shrink",
		"flex-wrap", "justify-content", "justify-items", "justify-self", "align-content",
		"align-items", "align-self", "place-items", "place-content", "order",
		"gap", "row-gap", "column-gap",
		"grid", "grid-area", "grid-auto-columns", "grid-auto-flow", "grid-auto-rows",
		"grid-column", "grid-row", "grid-template", "grid-template-areas",
		"grid-template-columns", "grid-template-rows",
		"list-style", "list-style-position", "list-style-type",
		"table-layout", "caption-side", "object-fit", "object-position",
	}

	// The CSS functions a value may call. `expression(` isn't one, and neither is anything
	// a browser adds later that can fetch or run something.
	cssFunctions = map[string]bool{
		"rgb": true, "rgba": true, "hsl": true, "hsla": true, "var": true, "calc": true,
		"min": true, "max": true, "clamp": true, "minmax": true, "repeat": true, "fit-content": true,
		"linear-gradient": true, "radial-gradient": true, "conic-gradient": true,
		"repeating-linear-gradient": true, "repeating-radial-gradient": true,
		"url": true,
	}

	cssFunctionCall = regexp.MustCompile(`[a-z0-9_-]+\(`)
	cssURLTarget    = regexp.MustCompile(`url\(['"]?([^'")]*)`)

	sizeValue   = regexp.MustCompile(`^[0-9]{1,5}%?$`)
	integer     = regexp.MustCompile(`^[0-9]{1,5}$`)
	classValue  = regexp.MustCompile(`^[\p{L}\p{N}_ -]{0,512}$`)
	shortText   = regexp.MustCompile(`^[\p{L}\p{N}\p{P}\p{Zs}+=^$<>|~` + "`" + `]{0,512}$`)
	targetValue = regexp.MustCompile(`^(_blank|_self)$`)
	relValue    = regexp.MustCompile(`^(noopener|noreferrer|nofollow|ugc|sponsored| )+$`)
	dirValue    = regexp.MustCompile(`^(ltr|rtl|auto)$`)
	langValue   = regexp.MustCompile(`^[A-Za-z0-9-]{1,35}$`)
	boolValue   = regexp.MustCompile(`^(|true|false|open)$`)
	scopeValue  = regexp.MustCompile(`^(row|col|rowgroup|colgroup)$`)
	listType    = regexp.MustCompile(`^(1|a|A|i|I|disc|circle|square)$`)
	loadValue   = regexp.MustCompile(`^(lazy|eager)$`)
	decodeValue = regexp.MustCompile(`^(async|sync|auto)$`)
	dateValue   = regexp.MustCompile(`^[0-9TZ:.+ /-]{1,40}$`)
	ariaRole    = regexp.MustCompile(`^[a-z]{1,32}$`)
)

// policy is safe for concurrent use once built (bluemonday's contract).
var policy = newPolicy()

func newPolicy() *bluemonday.Policy {
	p := bluemonday.NewPolicy()

	// URLs (href, src, cite): a scheme from this list, or relative. Anything that doesn't
	// parse is dropped, which covers java\tscript: and control characters.
	p.RequireParseableURLs(true)
	p.AllowRelativeURLs(true)
	p.AllowURLSchemes("http", "https", "mailto", "tel")

	p.AllowElements(elements...)

	p.AllowAttrs("class").Matching(classValue).Globally()
	p.AllowAttrs("title", "aria-label").Matching(shortText).Globally()
	p.AllowAttrs("aria-hidden").Matching(boolValue).Globally()
	p.AllowAttrs("role").Matching(ariaRole).Globally()
	p.AllowAttrs("dir").Matching(dirValue).Globally()
	p.AllowAttrs("lang").Matching(langValue).Globally()

	p.AllowAttrs("href").OnElements("a")
	p.AllowAttrs("target").Matching(targetValue).OnElements("a")
	p.AllowAttrs("rel").Matching(relValue).OnElements("a")

	p.AllowAttrs("src").OnElements("img")
	p.AllowAttrs("alt").Matching(shortText).OnElements("img")
	p.AllowAttrs("width", "height").Matching(sizeValue).OnElements("img", "table", "td", "th", "col")
	p.AllowAttrs("loading").Matching(loadValue).OnElements("img")
	p.AllowAttrs("decoding").Matching(decodeValue).OnElements("img")

	p.AllowAttrs("cite").OnElements("blockquote", "q", "del", "ins")
	p.AllowAttrs("datetime").Matching(dateValue).OnElements("time", "del", "ins")
	p.AllowAttrs("open").Matching(boolValue).OnElements("details")
	p.AllowAttrs("start").Matching(integer).OnElements("ol")
	p.AllowAttrs("reversed").Matching(boolValue).OnElements("ol")
	p.AllowAttrs("type").Matching(listType).OnElements("ol", "ul", "li")
	p.AllowAttrs("value").Matching(integer).OnElements("li")
	p.AllowAttrs("colspan", "rowspan").Matching(integer).OnElements("td", "th")
	p.AllowAttrs("scope").Matching(scopeValue).OnElements("th")
	p.AllowAttrs("span").Matching(integer).OnElements("col", "colgroup")

	// `style` is checked one declaration at a time: a property not listed is removed, and
	// so is any value safeCSSValue refuses.
	p.AllowStyles(cssProperties...).MatchingHandler(safeCSSValue).Globally()

	return p
}

// safeCSSValue is given a declaration's value, lower-cased and with bluemonday having
// decoded the CSS hex escapes. The written value is the original, so a value that needs
// any unescaping or uncommenting to be read is refused rather than decoded here.
func safeCSSValue(value string) bool {
	if strings.ContainsAny(value, "\\<>") || strings.Contains(value, "/*") {
		return false
	}
	// Whitespace is removed first: an old browser accepted `expression (`.
	compact := strings.Join(strings.Fields(value), "")
	if strings.Contains(compact, "javascript:") || strings.Contains(compact, "vbscript:") || strings.Contains(compact, "@import") {
		return false
	}
	for _, call := range cssFunctionCall.FindAllString(compact, -1) {
		if !cssFunctions[strings.TrimSuffix(call, "(")] {
			return false
		}
	}
	for _, match := range cssURLTarget.FindAllStringSubmatch(compact, -1) {
		if !safeCSSURL(match[1]) {
			return false
		}
	}
	return true
}

// safeCSSURL: http(s) or a same-site path. `data:` could carry an SVG, and no other
// scheme has a use in a style attribute.
func safeCSSURL(target string) bool {
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		return true
	}
	return !strings.Contains(target, ":")
}

// Sanitize returns html with everything the allowlist doesn't name removed. It is safe to
// run on its own output (the API sanitizes on write and again on publish).
func Sanitize(html string) string {
	// A NUL byte means nothing in HTML, and Postgres refuses it in text.
	return policy.Sanitize(strings.ReplaceAll(html, "\x00", ""))
}
