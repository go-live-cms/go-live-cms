package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/go-live-cms/go-live-cms/customhtml"
)

// The importer's converter (#150): an imported post's HTML (WordPress's block editor,
// its classic editor, or Markdown rendered to HTML) becomes a Block Spec v1 doc. It builds
// exactly the shapes the editor's bridge stores (blockBridge.ts pmNodeToBlock), so the
// collab server seeds the doc without dropping anything; web/gl-admin/lib/importer/
// importVectors.test.ts seeds the converter's outputs (testdata/import/*.json) with the
// real bridge and schema and fails on any drop. The doc then goes through prepareForStore
// like every other stored doc: the sanitizer, the mark allowlist (#418) and the nesting
// checks (#414).
//
// What has no GoLive equivalent is dropped and reported (importDropped: a label, the
// block it followed, the original markup for "Copy the original as text"); what can be
// made into something close is converted (an embed from an unknown provider becomes a
// link). Unknown inline markup keeps its text. Galleries are gallery blocks (#424); custom
// HTML blocks (wp:html) are custom HTML blocks (#428), their markup through the same
// sanitizer as an admin's (customhtml.Sanitize): only admins import.

// Media kinds a converter asks for.
const (
	importMediaImage = "image"
	importMediaVideo = "video"
	importMediaAudio = "audio"
	importMediaFile  = "file"
)

// importMediaRef is a file the post uses: its URL (or path in a zip) and, in WordPress, its
// attachment id.
type importMediaRef struct {
	Kind         string
	URL          string
	AttachmentID int64
	Alt          string
}

// importedMediaItem is the library item a reference became.
type importedMediaItem struct {
	ID   int64
	Path string // the public path (/uploads/…)
	Alt  string
}

// importMediaFailure is a file that couldn't be added: listed in the report, never fatal.
type importMediaFailure struct {
	URL    string `json:"url"`
	Code   string `json:"code"`
	Reason string `json:"reason"`
	After  string `json:"after,omitempty"`
}

// importMediaResolver downloads (or finds again) the files a post uses.
type importMediaResolver interface {
	resolve(ref importMediaRef) (importedMediaItem, *importMediaFailure)
}

// importDropped is a block the import left out.
type importDropped struct {
	Label    string `json:"label"`
	After    string `json:"after,omitempty"`
	Original string `json:"original"`
}

// importConversion is a converted body.
type importConversion struct {
	Doc         BlockDocV1
	Snippets    map[string]string
	Dropped     []importDropped
	Notes       []string
	MediaFailed []importMediaFailure
}

// importConvertOptions are the converter's inputs besides the HTML.
type importConvertOptions struct {
	// Autop: classic editor content, where blank lines are paragraphs (wpautop).
	Autop bool
	Media importMediaResolver
	// Reusable are the export's reusable blocks (wp_block) by id.
	Reusable map[int64]string
}

// Limits of what the converter keeps.
const (
	importOriginalMaxBytes = 8000
	importAfterMaxRunes    = 60
	importReusableDepth    = 4
)

// ob is a block being built; children are blocks too until the doc is flattened.
type ob struct {
	id       string
	typ      string
	version  int
	attrs    map[string]any
	children []*ob
}

type importConverter struct {
	opts        importConvertOptions
	dropped     []importDropped
	notes       []string
	noted       map[string]bool
	mediaFailed []importMediaFailure
	snippets    map[string]string
	lastText    string
	depth       int
}

// convertImportedContent converts one post's body.
func convertImportedContent(content string, opts importConvertOptions) importConversion {
	c := &importConverter{opts: opts, noted: map[string]bool{}, snippets: map[string]string{}}
	var blocks []*ob
	if strings.Contains(content, "<!-- wp:") {
		blocks = c.wpBlocks(parseWPBlocks(content))
	} else {
		blocks = c.fromHTML(content, opts.Autop)
	}
	blocks = c.fit("", blocks)
	return importConversion{
		Doc:         flattenImportBlocks(blocks),
		Snippets:    c.snippets,
		Dropped:     c.dropped,
		Notes:       c.notes,
		MediaFailed: c.mediaFailed,
	}
}

// newImportBlockID and newImportSnippetID make the ids a converted doc uses (tests make them
// predictable). A block id is "imp-" and 16 hex digits: the bridge keeps ids of 10 or more.
var (
	newImportBlockID = func() string {
		var b [8]byte
		_, _ = rand.Read(b[:])
		return "imp-" + hex.EncodeToString(b[:])
	}
	newImportSnippetID = uuid.NewString
)

func newOB(typ string, version int, attrs map[string]any, children ...*ob) *ob {
	if attrs == nil {
		attrs = map[string]any{}
	}
	return &ob{id: newImportBlockID(), typ: typ, version: version, attrs: attrs, children: children}
}

func (c *importConverter) note(code string) {
	if !c.noted[code] {
		c.noted[code] = true
		c.notes = append(c.notes, code)
	}
}

func (c *importConverter) drop(label, original string) {
	c.dropped = append(c.dropped, importDropped{Label: label, After: c.lastText, Original: capBytes(strings.TrimSpace(original), importOriginalMaxBytes)})
}

func (c *importConverter) setLast(text string) {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return
	}
	if r := []rune(text); len(r) > importAfterMaxRunes {
		text = strings.TrimSpace(string(r[:importAfterMaxRunes])) + "…"
	}
	c.lastText = text
}

func capBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// ---------------------------------------------------------------------------
// Block editor content

func (c *importConverter) wpBlocks(bs []*wpBlock) []*ob {
	var out []*ob
	for _, b := range bs {
		out = append(out, c.wpBlock(b)...)
	}
	return out
}

// wpDroppedCore are core blocks that show the site's data (lists of posts, menus,
// widgets): nothing to bring over.
var wpDroppedCore = map[string]bool{
	"latest-posts": true, "latest-comments": true, "archives": true, "calendar": true, "categories": true,
	"rss": true, "search": true, "tag-cloud": true, "social-links": true, "social-link": true,
	"page-list": true, "navigation": true, "query": true, "loginout": true, "legacy-widget": true,
	"widget-group": true, "template-part": true, "avatar": true, "read-more": true, "comments": true,
	"post-comments-form": true, "home-link": true, "footnotes": true,
}

func (c *importConverter) wpBlock(b *wpBlock) []*ob {
	if b.name == "" {
		return c.fromHTML(b.html(), true)
	}
	ns, local, _ := strings.Cut(b.name, "/")
	if ns == "core-embed" {
		return c.embedFromURL(b.attrString("url"), c.captionOf(b.html()))
	}
	if ns == "core" {
		switch local {
		case "paragraph", "heading", "list", "list-item", "quote", "code", "preformatted", "table",
			"separator", "verse", "image", "pullquote", "video", "audio":
			return c.fromHTML(b.html(), false)
		case "freeform":
			return c.fromHTML(b.html(), true)
		case "shortcode":
			return c.fromHTML(b.html(), true)
		case "gallery":
			return c.wpGallery(b)
		case "embed":
			return c.embedFromURL(b.attrString("url"), c.captionOf(b.html()))
		case "file":
			return c.wpFile(b)
		case "html":
			return c.htmlSnippet(b.html())
		case "buttons", "button":
			return c.wpButtons(b)
		case "spacer":
			return c.wpSpacer(b)
		case "columns":
			return c.wpColumns(b)
		case "column":
			return c.wpBlocks(b.inner)
		case "group", "row", "stack":
			return c.wpGroup(b)
		case "details":
			return c.wpDetails(b)
		case "cover":
			return c.wpCover(b)
		case "media-text":
			return c.wpMediaText(b)
		case "more":
			return nil
		case "nextpage":
			c.note("page_breaks")
			return nil
		case "block":
			return c.wpReusable(b)
		case "missing":
			label := wpBlockLabel(b.attrString("originalName"))
			c.drop(label, b.attrString("originalContent"))
			return nil
		}
		if wpDroppedCore[local] || strings.HasPrefix(local, "post-") || strings.HasPrefix(local, "site-") ||
			strings.HasPrefix(local, "comment") || strings.HasPrefix(local, "query-") {
			c.drop(wpBlockLabel(b.name), serializeWPBlock(b))
			return nil
		}
	}
	// A plugin's block (or a core one this importer doesn't know): its saved HTML, when it
	// has any, is converted like classic content; a block that saves none renders on the
	// server and has nothing to bring over.
	if strings.TrimSpace(plainTextOfHTML(b.html())) != "" || strings.Contains(b.html(), "<img") {
		c.note("converted_blocks")
		return c.fromHTML(b.html(), false)
	}
	c.drop(wpBlockLabel(b.name), serializeWPBlock(b))
	return nil
}

// serializeWPBlock is the block as WordPress stores it, for "Copy the original".
func serializeWPBlock(b *wpBlock) string {
	name := strings.TrimPrefix(b.name, "core/")
	attrs := ""
	if len(b.attrs) > 0 {
		if raw, err := json.Marshal(b.attrs); err == nil {
			attrs = " " + string(raw)
		}
	}
	inner := b.html()
	if strings.TrimSpace(inner) == "" {
		return "<!-- wp:" + name + attrs + " /-->"
	}
	return "<!-- wp:" + name + attrs + " -->" + inner + "<!-- /wp:" + name + " -->"
}

// plainTextOfHTML is HTML's text (for deciding whether a block has content).
func plainTextOfHTML(s string) string {
	nodes, err := html.ParseFragment(strings.NewReader(s), &html.Node{Type: html.ElementNode, DataAtom: atom.Body, Data: "body"})
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, n := range nodes {
		b.WriteString(textOf(n))
	}
	return b.String()
}

func (c *importConverter) wpGallery(b *wpBlock) []*ob {
	var images []*ob
	if len(b.inner) > 0 {
		for _, inner := range b.inner {
			for _, block := range c.wpBlock(inner) {
				if block.typ == "image" {
					images = append(images, block)
				}
			}
		}
	} else {
		// The pre-5.9 gallery: its images are in its own HTML.
		for _, img := range findAll(parseFragment(b.html()), atom.Img) {
			if block := c.image(img, nil, ""); block != nil {
				images = append(images, block)
			}
		}
	}
	if len(images) == 0 {
		return nil
	}
	columns := 3.0
	if n, ok := b.attrNumber("columns"); ok {
		columns = math.Max(2, math.Min(4, math.Trunc(n)))
	}
	attrs := map[string]any{"columns": columns}
	if caption := c.galleryCaption(b.ownHTML()); len(caption) > 0 {
		attrs["caption"] = caption
	}
	return []*ob{newOB("gallery", 1, attrs, images...)}
}

// captionOf is the runs of a block's <figcaption> (an embed's).
func (c *importConverter) captionOf(s string) []any {
	return c.galleryCaption(s)
}

func (c *importConverter) galleryCaption(s string) []any {
	for _, fc := range findAll(parseFragment(s), atom.Figcaption) {
		return c.captionRuns(fc)
	}
	return nil
}

func (c *importConverter) wpFile(b *wpBlock) []*ob {
	nodes := parseFragment(b.html())
	href := b.attrString("href")
	label := ""
	for _, a := range findAll(nodes, atom.A) {
		if hasClass(a, "wp-block-file__button") {
			continue
		}
		if href == "" {
			href = attr(a, "href")
		}
		label = strings.TrimSpace(textOf(a))
		break
	}
	id, _ := b.attrNumber("id")
	media, failure := c.opts.Media.resolve(importMediaRef{Kind: importMediaFile, URL: href, AttachmentID: int64(id)})
	if failure != nil {
		c.mediaFail(failure)
		return nil
	}
	attrs := map[string]any{"mediaId": float64(media.ID)}
	if label != "" {
		attrs["label"] = label
	}
	c.setLast(label)
	return []*ob{newOB("file", 1, attrs)}
}

func (c *importConverter) htmlSnippet(raw string) []*ob {
	clean := strings.TrimSpace(customhtml.Sanitize(raw))
	if clean == "" || len(clean) > customhtml.MaxHTMLBytes {
		c.drop("Custom HTML", raw)
		return nil
	}
	id := newImportSnippetID()
	c.snippets[id] = clean
	c.setLast(plainTextOfHTML(clean))
	return []*ob{newOB("html", 1, map[string]any{"snippetId": id})}
}

func (c *importConverter) wpButtons(b *wpBlock) []*ob {
	var buttons []any
	var labels []string
	for _, a := range findAll(parseFragment(b.html()), atom.A) {
		label := strings.Join(strings.Fields(textOf(a)), " ")
		if r := []rune(label); len(r) > buttonLabelMaxRunes {
			label = string(r[:buttonLabelMaxRunes])
		}
		button := map[string]any{"type": "button"}
		battrs := map[string]any{}
		if href := strings.TrimSpace(attr(a, "href")); href != "" && len(href) <= buttonHrefMaxLength && isSafeURL(href, safeHrefSchemes) {
			battrs["href"] = href
		}
		if a.Parent != nil && hasClass(a.Parent, "is-style-outline") {
			battrs["variant"] = "secondary"
		}
		if len(battrs) > 0 {
			button["attrs"] = battrs
		}
		if label != "" {
			button["content"] = []any{map[string]any{"type": "text", "text": label}}
			labels = append(labels, label)
		}
		buttons = append(buttons, button)
	}
	if len(buttons) == 0 {
		return nil
	}
	attrs := map[string]any{"pm": map[string]any{"type": "buttons", "content": buttons}}
	if text := strings.Join(labels, " "); text != "" {
		attrs["text"] = text
		c.setLast(text)
	}
	if layout, ok := b.attrs["layout"].(map[string]any); ok && layout["justifyContent"] == "center" {
		attrs["align"] = "center"
	}
	return []*ob{newOB("buttons", 1, attrs)}
}

func (c *importConverter) wpSpacer(b *wpBlock) []*ob {
	px, ok := b.attrNumber("height")
	if !ok {
		px = 100
	}
	size, best := "7", math.Inf(1)
	for _, step := range []struct {
		size string
		px   float64
	}{{"5", 24}, {"7", 48}, {"8", 64}, {"9", 96}} {
		if d := math.Abs(step.px - px); d < best {
			size, best = step.size, d
		}
	}
	return []*ob{newOB("spacer", 1, map[string]any{"size": size})}
}

func (c *importConverter) wpColumns(b *wpBlock) []*ob {
	var columns []*ob
	var widths []float64
	for _, col := range b.inner {
		if col.name != "core/column" {
			continue
		}
		columns = append(columns, newOB("column", 1, nil, c.wpBlocks(col.inner)...))
		w, _ := col.attrNumber("width")
		if s := col.attrString("width"); strings.HasSuffix(s, "%") {
			w, _ = strconv.ParseFloat(strings.TrimSuffix(s, "%"), 64)
		}
		widths = append(widths, w)
	}
	attrs := map[string]any{}
	if len(columns) == 2 && widths[0] > 0 {
		switch {
		case widths[0] < 42:
			attrs["layout"] = "33-67"
		case widths[0] > 58:
			attrs["layout"] = "67-33"
		}
	}
	if align := b.attrString("align"); align == "wide" || align == "full" {
		attrs["align"] = align
	}
	return []*ob{newOB("columns", 1, attrs, columns...)}
}

func (c *importConverter) wpGroup(b *wpBlock) []*ob {
	attrs := map[string]any{}
	if align := b.attrString("align"); align == "wide" || align == "full" {
		attrs["align"] = align
	}
	if b.attrString("backgroundColor") != "" || b.attrString("gradient") != "" {
		attrs["style"] = "tinted"
	} else if style, ok := b.attrs["style"].(map[string]any); ok {
		if color, ok := style["color"].(map[string]any); ok && (color["background"] != nil || color["gradient"] != nil) {
			attrs["style"] = "tinted"
		}
	}
	return []*ob{newOB("group", 1, attrs, c.wpBlocks(b.inner)...)}
}

func (c *importConverter) wpDetails(b *wpBlock) []*ob {
	attrs := map[string]any{}
	if s := findFirst(parseFragment(b.ownHTML()), atom.Summary); s != nil {
		if runs := c.captionRuns(s); len(runs) > 0 {
			attrs["summary"] = runs
			attrs["text"] = runsText(runs)
			c.setLast(runsText(runs))
		}
	}
	if b.attrBool("showContent") {
		attrs["open"] = true
	}
	return []*ob{newOB("details", 1, attrs, c.wpBlocks(b.inner)...)}
}

func (c *importConverter) wpCover(b *wpBlock) []*ob {
	children := c.wpBlocks(b.inner)
	id, _ := b.attrNumber("id")
	mediaURL := b.attrString("url")
	if mediaURL == "" && id == 0 {
		return children
	}
	if bg := b.attrString("backgroundType"); bg == "video" {
		c.note("cover_video")
		return children
	}
	media, failure := c.opts.Media.resolve(importMediaRef{Kind: importMediaImage, URL: mediaURL, AttachmentID: int64(id), Alt: b.attrString("alt")})
	if failure != nil {
		c.mediaFail(failure)
		return children
	}
	attrs := map[string]any{"mediaId": float64(media.ID)}
	if alt := firstNonEmptyString(b.attrString("alt"), media.Alt); alt != "" {
		attrs["alt"] = alt
	}
	if dim, ok := b.attrNumber("dimRatio"); ok {
		attrs["overlay"] = math.Min(80, math.Round(dim/5)*5)
	}
	if align := b.attrString("align"); align == "wide" || align == "full" {
		attrs["align"] = align
	}
	if len(children) == 0 {
		// A cover with nothing on it is a picture.
		return []*ob{newOB("image", 2, imageAttrs(media, attrs["alt"], nil, stringAttr(attrs["align"])))}
	}
	return []*ob{newOB("cover", 1, attrs, children...)}
}

func (c *importConverter) wpMediaText(b *wpBlock) []*ob {
	children := c.wpBlocks(b.inner)
	if b.attrString("mediaType") != "" && b.attrString("mediaType") != "image" {
		c.note("media_text_video")
		return children
	}
	id, _ := b.attrNumber("mediaId")
	mediaURL := b.attrString("mediaUrl")
	if mediaURL == "" {
		for _, img := range findAll(parseFragment(b.ownHTML()), atom.Img) {
			mediaURL = attr(img, "src")
			break
		}
	}
	if mediaURL == "" && id == 0 {
		return children
	}
	media, failure := c.opts.Media.resolve(importMediaRef{Kind: importMediaImage, URL: mediaURL, AttachmentID: int64(id), Alt: b.attrString("mediaAlt")})
	if failure != nil {
		c.mediaFail(failure)
		return children
	}
	attrs := map[string]any{"mediaId": float64(media.ID)}
	if alt := firstNonEmptyString(b.attrString("mediaAlt"), media.Alt); alt != "" {
		attrs["alt"] = alt
	}
	if b.attrString("mediaPosition") == "right" {
		attrs["position"] = "right"
	}
	if len(children) == 0 {
		return []*ob{newOB("image", 2, imageAttrs(media, attrs["alt"], nil, ""))}
	}
	return []*ob{newOB("media_text", 1, attrs, children...)}
}

func (c *importConverter) wpReusable(b *wpBlock) []*ob {
	ref, _ := b.attrNumber("ref")
	content, ok := c.opts.Reusable[int64(ref)]
	if !ok || c.depth >= importReusableDepth {
		c.drop("Reusable block", serializeWPBlock(b))
		return nil
	}
	c.depth++
	defer func() { c.depth-- }()
	if strings.Contains(content, "<!-- wp:") {
		return c.wpBlocks(parseWPBlocks(content))
	}
	return c.fromHTML(content, true)
}

// ---------------------------------------------------------------------------
// HTML

func parseFragment(s string) []*html.Node {
	nodes, err := html.ParseFragment(strings.NewReader(s), &html.Node{Type: html.ElementNode, DataAtom: atom.Body, Data: "body"})
	if err != nil {
		return nil
	}
	return nodes
}

// fromHTML converts a run of HTML (classic content, or one block's saved HTML).
func (c *importConverter) fromHTML(s string, autop bool) []*ob {
	s = c.shortcodes(s, autop)
	return c.blocks(parseFragment(s), autop)
}

// blockTags are the elements that are blocks of their own (or hold blocks).
var blockTags = map[atom.Atom]bool{
	atom.P: true, atom.H1: true, atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true,
	atom.Ul: true, atom.Ol: true, atom.Blockquote: true, atom.Pre: true, atom.Hr: true, atom.Figure: true,
	atom.Table: true, atom.Div: true, atom.Section: true, atom.Article: true, atom.Header: true, atom.Footer: true,
	atom.Main: true, atom.Aside: true, atom.Nav: true, atom.Dl: true, atom.Details: true, atom.Address: true,
	atom.Center: true, atom.Form: true, atom.Iframe: true, atom.Script: true, atom.Style: true, atom.Noscript: true,
	atom.Video: true, atom.Audio: true, atom.Object: true, atom.Embed: true, atom.Svg: true, atom.Canvas: true,
	atom.Template: true, atom.Hgroup: true, atom.Fieldset: true, atom.Menu: true, atom.Img: true, atom.Li: true,
	atom.Figcaption: true, atom.Select: true, atom.Textarea: true, atom.Input: true, atom.Button: true,
	atom.Map: true, atom.Applet: true, atom.Math: false,
}

// placeholder elements the shortcode pass writes.
const (
	glEmbedTag     = "gl-embed"
	glGalleryTag   = "gl-gallery"
	glShortcodeTag = "gl-shortcode"
)

func isBlockNode(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	switch n.Data {
	case glEmbedTag, glGalleryTag, glShortcodeTag:
		return true
	}
	return blockTags[n.DataAtom]
}

func (c *importConverter) blocks(nodes []*html.Node, autop bool) []*ob {
	var out []*ob
	var run []*html.Node
	flush := func() {
		if len(run) > 0 {
			out = append(out, c.paragraphs(run, autop)...)
			run = nil
		}
	}
	for _, n := range nodes {
		switch {
		case n.Type == html.CommentNode, n.Type == html.DoctypeNode:
			continue
		case isBlockNode(n):
			flush()
			out = append(out, c.block(n, autop)...)
		default:
			run = append(run, n)
		}
	}
	flush()
	return out
}

func htmlChildren(n *html.Node) []*html.Node {
	var out []*html.Node
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		out = append(out, ch)
	}
	return out
}

func (c *importConverter) block(n *html.Node, autop bool) []*ob {
	switch n.Data {
	case glEmbedTag:
		return c.embedFromURL(attr(n, "data-url"), nil)
	case glGalleryTag:
		return c.shortcodeGallery(n)
	case glShortcodeTag:
		c.drop("Shortcode ["+attr(n, "data-name")+"]", attr(n, "data-raw"))
		return nil
	}
	switch n.DataAtom {
	case atom.P, atom.Address, atom.Center:
		return c.paragraphs(htmlChildren(n), autop)
	case atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6:
		return c.heading(n)
	case atom.Ul, atom.Ol, atom.Menu:
		return c.list(n)
	case atom.Li:
		// A list item without its list: its content.
		return c.blocks(htmlChildren(n), autop)
	case atom.Blockquote:
		if hasClass(n, "wp-block-pullquote") {
			return c.pullQuote(n)
		}
		return c.quote(n)
	case atom.Pre:
		return c.pre(n)
	case atom.Hr:
		return []*ob{newOB("divider", 1, nil)}
	case atom.Figure:
		return c.figure(n)
	case atom.Img:
		if b := c.image(n, nil, alignOf(n)); b != nil {
			return []*ob{b}
		}
		return nil
	case atom.Table:
		return c.table(n, nil)
	case atom.Iframe:
		return c.iframe(n)
	case atom.Video, atom.Audio:
		return c.playable(n, nil)
	case atom.Details:
		return c.details(n)
	case atom.Dl:
		return c.definitionList(n)
	case atom.Figcaption:
		return c.paragraphs(htmlChildren(n), false)
	case atom.Script:
		c.drop("Script", renderNode(n))
		return nil
	case atom.Style:
		c.drop("Style sheet", renderNode(n))
		return nil
	case atom.Noscript, atom.Template:
		return nil
	case atom.Form, atom.Fieldset, atom.Input, atom.Select, atom.Textarea, atom.Button:
		c.drop("Form", renderNode(n))
		return nil
	case atom.Object, atom.Embed, atom.Applet:
		c.drop("Embedded object", renderNode(n))
		return nil
	case atom.Svg:
		c.drop("SVG image", renderNode(n))
		return nil
	case atom.Canvas, atom.Map:
		c.drop(strings.ToUpper(n.Data[:1])+n.Data[1:], renderNode(n))
		return nil
	}
	if n.DataAtom == atom.Div && (hasClass(n, "wp-caption") || hasClass(n, "wp-block-image")) {
		return c.figure(n)
	}
	// div, section, article, … : their content.
	return c.blocks(htmlChildren(n), autop)
}

func renderNode(n *html.Node) string {
	var b strings.Builder
	_ = html.Render(&b, n)
	return b.String()
}

// ---------------------------------------------------------------------------
// Inline content

// seg is a piece of inline content: a ProseMirror inline node, a paragraph break (autop's
// blank line), or blocks that break the paragraph (an image in the text).
type importSeg struct {
	node   map[string]any
	brk    bool
	blocks []*ob
}

func markOf(t string) map[string]any { return map[string]any{"type": t} }

// inlineMarks are the marks an element adds (#418's allowlist only).
func inlineMarks(n *html.Node) []map[string]any {
	switch n.DataAtom {
	case atom.Strong, atom.B:
		return []map[string]any{markOf("bold")}
	case atom.Em, atom.I, atom.Cite, atom.Dfn, atom.Var:
		return []map[string]any{markOf("italic")}
	case atom.U, atom.Ins:
		return []map[string]any{markOf("underline")}
	case atom.S, atom.Strike, atom.Del:
		return []map[string]any{markOf("strike")}
	case atom.Code, atom.Kbd, atom.Samp, atom.Tt:
		return []map[string]any{markOf("code")}
	case atom.Mark:
		return []map[string]any{markOf("highlight")}
	case atom.Sup:
		return []map[string]any{markOf("superscript")}
	case atom.Sub:
		return []map[string]any{markOf("subscript")}
	case atom.A:
		href := strings.TrimSpace(attr(n, "href"))
		if href == "" || !isSafeURL(href, safeHrefSchemes) {
			return nil
		}
		return []map[string]any{{"type": "link", "attrs": map[string]any{"href": href}}}
	case atom.Span:
		style := strings.ToLower(strings.ReplaceAll(attr(n, "style"), " ", ""))
		var marks []map[string]any
		if strings.Contains(style, "font-weight:bold") || strings.Contains(style, "font-weight:700") || strings.Contains(style, "font-weight:600") {
			marks = append(marks, markOf("bold"))
		}
		if strings.Contains(style, "font-style:italic") {
			marks = append(marks, markOf("italic"))
		}
		if strings.Contains(style, "text-decoration:underline") {
			marks = append(marks, markOf("underline"))
		}
		if strings.Contains(style, "line-through") {
			marks = append(marks, markOf("strike"))
		}
		return marks
	}
	return nil
}

func withMarks(marks []map[string]any, add []map[string]any) []map[string]any {
	if len(add) == 0 {
		return marks
	}
	out := append([]map[string]any{}, marks...)
	for _, m := range add {
		dup := false
		for i, have := range out {
			if have["type"] == m["type"] {
				out[i] = m // the inner link wins
				dup = true
			}
		}
		if !dup {
			out = append(out, m)
		}
	}
	return out
}

var (
	blankLines = regexp.MustCompile(`\n[ \t\r\f]*\n\s*`)
	spaceRun   = regexp.MustCompile(`[ \t\n\r\f]+`)
)

func importTextNode(text string, marks []map[string]any) map[string]any {
	n := map[string]any{"type": "text", "text": text}
	if len(marks) == 0 {
		return n
	}
	// The code mark excludes every other (TipTap's Code: excludes "_").
	for _, m := range marks {
		if m["type"] == "code" {
			n["marks"] = []any{markOf("code")}
			return n
		}
	}
	list := make([]any, len(marks))
	for i, m := range marks {
		list[i] = m
	}
	n["marks"] = list
	return n
}

// inlineSegs flattens inline nodes into segments.
func (c *importConverter) inlineSegs(nodes []*html.Node, marks []map[string]any, autop bool) []importSeg {
	var out []importSeg
	for _, n := range nodes {
		switch n.Type {
		case html.TextNode:
			text := n.Data
			if !autop {
				if t := spaceRun.ReplaceAllString(text, " "); t != "" {
					out = append(out, importSeg{node: importTextNode(t, marks)})
				}
				continue
			}
			for i, para := range blankLines.Split(text, -1) {
				if i > 0 {
					out = append(out, importSeg{brk: true})
				}
				for j, line := range strings.Split(para, "\n") {
					if j > 0 {
						out = append(out, importSeg{node: map[string]any{"type": "hardBreak"}})
					}
					if t := spaceRun.ReplaceAllString(line, " "); t != "" {
						out = append(out, importSeg{node: importTextNode(t, marks)})
					}
				}
			}
		case html.ElementNode:
			switch {
			case n.DataAtom == atom.Br:
				out = append(out, importSeg{node: map[string]any{"type": "hardBreak"}})
			case n.DataAtom == atom.Img:
				if b := c.image(n, nil, alignOf(n)); b != nil {
					out = append(out, importSeg{blocks: []*ob{b}})
				}
			case n.DataAtom == atom.A && onlyImage(n) != nil:
				if b := c.image(onlyImage(n), nil, alignOf(onlyImage(n))); b != nil {
					out = append(out, importSeg{blocks: []*ob{b}})
				}
			case n.Data == glBreakTag:
				out = append(out, importSeg{brk: true})
			case isBlockNode(n):
				// A block inside inline content ends the paragraph, even when it gives nothing.
				if blocks := c.block(n, autop); len(blocks) > 0 {
					out = append(out, importSeg{blocks: blocks})
				} else {
					out = append(out, importSeg{brk: true})
				}
			default:
				out = append(out, c.inlineSegs(htmlChildren(n), withMarks(marks, inlineMarks(n)), autop)...)
			}
		}
	}
	return out
}

// onlyImage: a link (or span) whose only content is one image.
func onlyImage(n *html.Node) *html.Node {
	var img *html.Node
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		switch {
		case ch.Type == html.TextNode && strings.TrimSpace(ch.Data) == "":
		case ch.Type == html.ElementNode && ch.DataAtom == atom.Img && img == nil:
			img = ch
		default:
			return nil
		}
	}
	return img
}

// tidyInline merges adjacent text runs with the same marks, trims the ends and collapses
// the space between runs, as a browser shows it. nil when nothing visible is left.
func tidyInline(nodes []map[string]any) []any {
	var merged []map[string]any
	for _, n := range nodes {
		if len(merged) > 0 && n["type"] == "text" {
			last := merged[len(merged)-1]
			if last["type"] == "text" && sameMarks(last["marks"], n["marks"]) {
				last["text"] = last["text"].(string) + n["text"].(string)
				continue
			}
		}
		cp := map[string]any{}
		for k, v := range n {
			cp[k] = v
		}
		merged = append(merged, cp)
	}
	// Collapse spaces across runs (and after a break), trim both ends.
	prevSpace := true
	for _, n := range merged {
		if n["type"] != "text" {
			prevSpace = true
			continue
		}
		t := n["text"].(string)
		if prevSpace {
			t = strings.TrimLeft(t, " ")
		}
		n["text"] = t
		if t != "" {
			prevSpace = strings.HasSuffix(t, " ")
		}
	}
	for i := len(merged) - 1; i >= 0; i-- {
		n := merged[i]
		if n["type"] == "hardBreak" {
			merged = merged[:i]
			continue
		}
		if n["type"] == "text" {
			t := strings.TrimRight(n["text"].(string), " ")
			if t == "" {
				merged = merged[:i]
				continue
			}
			n["text"] = t
		}
		break
	}
	var out []any
	visible := false
	for _, n := range merged {
		if n["type"] == "text" {
			t := n["text"].(string)
			if t == "" {
				continue
			}
			if strings.TrimFunc(t, func(r rune) bool { return unicode.IsSpace(r) || r == ' ' }) != "" {
				visible = true
			}
		}
		if len(out) == 0 && n["type"] == "hardBreak" {
			continue
		}
		out = append(out, n)
	}
	if !visible {
		return nil
	}
	return out
}

func sameMarks(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

func inlineText(content []any) string {
	var b strings.Builder
	for _, n := range content {
		if m, ok := n.(map[string]any); ok && m["type"] == "text" {
			b.WriteString(m["text"].(string))
		}
	}
	return b.String()
}

// paragraphs builds paragraphs (and the blocks between them) from inline nodes.
func (c *importConverter) paragraphs(nodes []*html.Node, autop bool) []*ob {
	var out []*ob
	var cur []map[string]any
	emit := func() {
		if p := c.paragraph(cur); p != nil {
			out = append(out, p)
		}
		cur = nil
	}
	for _, s := range c.inlineSegs(nodes, nil, autop) {
		switch {
		case s.blocks != nil:
			emit()
			out = append(out, s.blocks...)
		case s.brk:
			emit()
		default:
			cur = append(cur, s.node)
		}
	}
	emit()
	return out
}

func (c *importConverter) paragraph(inline []map[string]any) *ob {
	content := tidyInline(inline)
	if content == nil {
		return nil
	}
	text := inlineText(content)
	c.setLast(text)
	return newOB("paragraph", 1, map[string]any{
		"pm":   map[string]any{"type": "paragraph", "content": content},
		"text": text,
	})
}

func (c *importConverter) heading(n *html.Node) []*ob {
	level := float64(n.Data[1] - '0')
	var inline []map[string]any
	var after []*ob
	for _, s := range c.inlineSegs(htmlChildren(n), nil, false) {
		switch {
		case s.blocks != nil:
			after = append(after, s.blocks...)
		case s.node != nil:
			inline = append(inline, s.node)
		}
	}
	content := tidyInline(inline)
	if content == nil {
		return after
	}
	text := inlineText(content)
	c.setLast(text)
	h := newOB("heading", 1, map[string]any{
		"level": level,
		"pm":    map[string]any{"type": "heading", "attrs": map[string]any{"level": level}, "content": content},
		"text":  text,
	})
	return append([]*ob{h}, after...)
}

// importPMParagraph is a paragraph node for inside another node's pm (a list item, a quote).
func importPMParagraph(content []any) map[string]any {
	if len(content) == 0 {
		return map[string]any{"type": "paragraph"}
	}
	return map[string]any{"type": "paragraph", "content": content}
}

// importPMParagraphs splits inline nodes into pm paragraphs, and the blocks that break out.
func (c *importConverter) importPMParagraphs(nodes []*html.Node, autop bool) ([]any, []*ob) {
	var paras []any
	var extra []*ob
	var cur []map[string]any
	emit := func() {
		if content := tidyInline(cur); content != nil {
			paras = append(paras, importPMParagraph(content))
		}
		cur = nil
	}
	for _, s := range c.inlineSegs(nodes, nil, autop) {
		switch {
		case s.blocks != nil:
			emit()
			for _, b := range s.blocks {
				if b.typ == "paragraph" {
					paras = append(paras, b.attrs["pm"])
				} else {
					extra = append(extra, b)
				}
			}
		case s.brk:
			emit()
		default:
			cur = append(cur, s.node)
		}
	}
	emit()
	return paras, extra
}

func importPMText(node any) string {
	m, ok := node.(map[string]any)
	if !ok {
		return ""
	}
	if m["type"] == "text" {
		s, _ := m["text"].(string)
		return s
	}
	var b strings.Builder
	if content, ok := m["content"].([]any); ok {
		for _, ch := range content {
			b.WriteString(importPMText(ch))
		}
	}
	return b.String()
}

// list builds a bulleted or numbered list: an item per <li>, a nested list inside its
// item's pm (as the editor keeps it). Blocks inside an item that a list item can't hold
// (an image, a table) follow the list.
func (c *importConverter) list(n *html.Node) []*ob {
	typ := "bullet_list"
	if n.DataAtom == atom.Ol {
		typ = "ordered_list"
	}
	list := newOB(typ, 1, nil)
	var after []*ob
	for _, li := range elementChildren(n) {
		if li.DataAtom != atom.Li {
			continue
		}
		pm, extra := c.listItemPM(li)
		after = append(after, extra...)
		text := importPMText(pm)
		list.children = append(list.children, newOB("list_item", 1, map[string]any{"pm": pm, "text": text}))
		c.setLast(text)
	}
	if len(list.children) == 0 {
		return after
	}
	return append([]*ob{list}, after...)
}

func (c *importConverter) listItemPM(li *html.Node) (map[string]any, []*ob) {
	var content []any
	var extra []*ob
	var run []*html.Node
	flush := func() {
		if len(run) == 0 {
			return
		}
		paras, more := c.importPMParagraphs(run, false)
		content = append(content, paras...)
		extra = append(extra, more...)
		run = nil
	}
	for _, ch := range htmlChildren(li) {
		if ch.Type == html.ElementNode && (ch.DataAtom == atom.Ul || ch.DataAtom == atom.Ol) {
			flush()
			nested, more := c.nestedListPM(ch)
			extra = append(extra, more...)
			if nested != nil {
				content = append(content, nested)
			}
			continue
		}
		if ch.Type == html.ElementNode && ch.DataAtom == atom.P {
			flush()
			paras, more := c.importPMParagraphs(htmlChildren(ch), false)
			content = append(content, paras...)
			extra = append(extra, more...)
			continue
		}
		run = append(run, ch)
	}
	flush()
	// A list item starts with a paragraph (listItem: "paragraph block*").
	if len(content) == 0 || content[0].(map[string]any)["type"] != "paragraph" {
		content = append([]any{importPMParagraph(nil)}, content...)
	}
	return map[string]any{"type": "listItem", "content": content}, extra
}

func (c *importConverter) nestedListPM(n *html.Node) (map[string]any, []*ob) {
	typ := "bulletList"
	if n.DataAtom == atom.Ol {
		typ = "orderedList"
	}
	var items []any
	var extra []*ob
	for _, li := range elementChildren(n) {
		if li.DataAtom != atom.Li {
			continue
		}
		pm, more := c.listItemPM(li)
		items = append(items, pm)
		extra = append(extra, more...)
	}
	if len(items) == 0 {
		return nil, extra
	}
	return map[string]any{"type": typ, "content": items}, extra
}

func elementChildren(n *html.Node) []*html.Node {
	var out []*html.Node
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode {
			out = append(out, ch)
		}
	}
	return out
}

// quoteParts separates a quote's citation (<cite>, or a footer holding one) from its
// content.
func quoteParts(n *html.Node) (content []*html.Node, cite string) {
	for _, ch := range htmlChildren(n) {
		if ch.Type == html.ElementNode && (ch.DataAtom == atom.Cite || ch.DataAtom == atom.Footer) {
			cite = strings.Join(strings.Fields(textOf(ch)), " ")
			continue
		}
		content = append(content, ch)
	}
	return content, cite
}

func (c *importConverter) quote(n *html.Node) []*ob {
	content, cite := quoteParts(n)
	var paras []any
	var after []*ob
	var run []*html.Node
	flush := func() {
		if len(run) > 0 {
			p, more := c.importPMParagraphs(run, false)
			paras = append(paras, p...)
			after = append(after, more...)
			run = nil
		}
	}
	for _, ch := range content {
		if ch.Type == html.ElementNode && isBlockNode(ch) {
			flush()
			for _, b := range c.block(ch, false) {
				switch b.typ {
				case "paragraph", "heading":
					// A heading in a quote reads as its text.
					paras = append(paras, importPMParagraph(b.attrs["pm"].(map[string]any)["content"].([]any)))
				default:
					after = append(after, b)
				}
			}
			continue
		}
		run = append(run, ch)
	}
	flush()
	if len(paras) == 0 {
		return after
	}
	pm := map[string]any{"type": "blockquote", "content": paras}
	attrs := map[string]any{"pm": pm, "text": importPMText(pm)}
	if cite != "" {
		attrs["cite"] = cite
	}
	c.setLast(importPMText(pm))
	return append([]*ob{newOB("blockquote", 2, attrs)}, after...)
}

// pullQuote: a pull quote holds one run of text (pullQuote: "inline*"), its paragraphs
// joined with line breaks.
func (c *importConverter) pullQuote(n *html.Node) []*ob {
	target := n
	if bq := findFirst([]*html.Node{n}, atom.Blockquote); bq != nil && bq != n {
		target = bq
	}
	content, cite := quoteParts(target)
	paras, after := c.importPMParagraphs(flattenParagraphs(content), false)
	var inline []any
	for i, p := range paras {
		if i > 0 {
			inline = append(inline, map[string]any{"type": "hardBreak"})
		}
		if pc, ok := p.(map[string]any)["content"].([]any); ok {
			inline = append(inline, pc...)
		}
	}
	if len(inline) == 0 {
		return after
	}
	pm := map[string]any{"type": "pullQuote", "content": inline}
	attrs := map[string]any{"pm": pm, "text": importPMText(pm)}
	if cite != "" {
		attrs["cite"] = cite
	}
	c.setLast(importPMText(pm))
	return append([]*ob{newOB("pull_quote", 1, attrs)}, after...)
}

// glBreakTag is a paragraph break between inline runs (flattenParagraphs).
const glBreakTag = "gl-break"

// flattenParagraphs replaces each <p> with its children followed by a paragraph break, so
// importPMParagraphs (with autop off) still splits them.
func flattenParagraphs(nodes []*html.Node) []*html.Node {
	var out []*html.Node
	for _, n := range nodes {
		if n.Type == html.ElementNode && n.DataAtom == atom.P {
			out = append(out, &html.Node{Type: html.ElementNode, DataAtom: atom.Span, Data: "span", FirstChild: n.FirstChild, LastChild: n.LastChild})
			out = append(out, &html.Node{Type: html.ElementNode, Data: glBreakTag})
			continue
		}
		out = append(out, n)
	}
	return out
}

func (c *importConverter) pre(n *html.Node) []*ob {
	if hasClass(n, "wp-block-verse") {
		// Poetry: a paragraph whose lines are line breaks.
		return c.paragraphs([]*html.Node{{Type: html.ElementNode, DataAtom: atom.Span, Data: "span", FirstChild: n.FirstChild, LastChild: n.LastChild}}, true)
	}
	code := textOf(n)
	code = strings.TrimSuffix(strings.TrimPrefix(code, "\n"), "\n")
	if strings.TrimSpace(code) == "" {
		return nil
	}
	attrs := map[string]any{"code": code}
	lang := languageOf(n)
	if lang == "" {
		if inner := findFirst(htmlChildren(n), atom.Code); inner != nil {
			lang = languageOf(inner)
		}
	}
	if lang != "" {
		attrs["language"] = lang
	}
	c.setLast(code)
	return []*ob{newOB("code_block", 1, attrs)}
}

var languageClass = regexp.MustCompile(`(?:^|\s)(?:language|lang)-([A-Za-z0-9_+#-]{1,32})(?:\s|$)`)

func languageOf(n *html.Node) string {
	if m := languageClass.FindStringSubmatch(attr(n, "class")); m != nil {
		return strings.ToLower(m[1])
	}
	if l := attr(n, "data-language"); l != "" && len(l) <= 32 {
		return strings.ToLower(l)
	}
	return ""
}

func alignOf(n *html.Node) string {
	switch {
	case hasClass(n, "alignfull"):
		return "full"
	case hasClass(n, "alignwide"):
		return "wide"
	}
	return ""
}

// figure: an image, table, quote, video or embed with its caption; anything else is its
// content.
func (c *importConverter) figure(n *html.Node) []*ob {
	var captionNode *html.Node
	for _, ch := range elementChildren(n) {
		if ch.DataAtom == atom.Figcaption || (ch.DataAtom == atom.P && hasClass(ch, "wp-caption-text")) {
			captionNode = ch
		}
	}
	var caption []any
	if captionNode != nil {
		caption = c.captionRuns(captionNode)
	}
	align := alignOf(n)
	switch {
	case hasClass(n, "wp-block-pullquote"):
		return c.pullQuote(n)
	case hasClass(n, "wp-block-embed"):
		u := attr(n, "data-url")
		if u == "" {
			for _, wrap := range findAll(htmlChildren(n), atom.Div) {
				if hasClass(wrap, "wp-block-embed__wrapper") {
					u = strings.TrimSpace(textOf(wrap))
				}
			}
		}
		if u == "" {
			if f := findFirst(htmlChildren(n), atom.Iframe); f != nil {
				return c.iframe(f)
			}
		}
		return c.embedFromURL(u, caption)
	}
	if t := findFirst(htmlChildren(n), atom.Table); t != nil {
		return c.table(t, caption)
	}
	if bq := findFirst(htmlChildren(n), atom.Blockquote); bq != nil {
		return c.quote(bq)
	}
	if v := findFirst(htmlChildren(n), atom.Video); v != nil {
		return c.playable(v, caption)
	}
	if a := findFirst(htmlChildren(n), atom.Audio); a != nil {
		return c.playable(a, caption)
	}
	if f := findFirst(htmlChildren(n), atom.Iframe); f != nil {
		return c.iframe(f)
	}
	if img := findFirst(htmlChildren(n), atom.Img); img != nil {
		if align == "" {
			align = alignOf(img)
		}
		if b := c.image(img, caption, align); b != nil {
			return []*ob{b}
		}
		return nil
	}
	var rest []*html.Node
	for _, ch := range htmlChildren(n) {
		if ch != captionNode {
			rest = append(rest, ch)
		}
	}
	return c.blocks(rest, false)
}

var wpImageClass = regexp.MustCompile(`(?:^|\s)wp-image-(\d+)(?:\s|$)`)

func imageAttrs(media importedMediaItem, alt any, caption []any, align string) map[string]any {
	attrs := map[string]any{"src": media.Path, "mediaId": float64(media.ID)}
	if s, _ := alt.(string); s != "" {
		attrs["alt"] = s
	}
	if len(caption) > 0 {
		attrs["caption"] = caption
	}
	if align == "wide" || align == "full" {
		attrs["align"] = align
	}
	return attrs
}

func stringAttr(v any) string {
	s, _ := v.(string)
	return s
}

func (c *importConverter) image(img *html.Node, caption []any, align string) *ob {
	src := firstNonEmptyString(attr(img, "src"), attr(img, "data-src"), attr(img, "data-lazy-src"))
	ref := importMediaRef{Kind: importMediaImage, URL: strings.TrimSpace(src), Alt: strings.TrimSpace(attr(img, "alt"))}
	if m := wpImageClass.FindStringSubmatch(attr(img, "class")); m != nil {
		ref.AttachmentID, _ = strconv.ParseInt(m[1], 10, 64)
	}
	if ref.URL == "" && ref.AttachmentID == 0 {
		return nil
	}
	if strings.HasPrefix(ref.URL, "data:") {
		c.mediaFail(&importMediaFailure{URL: "data:", Code: "inline_data", Reason: "Images written into the page (data: links) aren’t imported"})
		return nil
	}
	media, failure := c.opts.Media.resolve(ref)
	if failure != nil {
		c.mediaFail(failure)
		return nil
	}
	alt := firstNonEmptyString(ref.Alt, media.Alt)
	if len(caption) > 0 {
		c.setLast(runsText(caption))
	}
	return newOB("image", 2, imageAttrs(media, alt, caption, align))
}

func (c *importConverter) mediaFail(f *importMediaFailure) {
	f.After = c.lastText
	c.mediaFailed = append(c.mediaFailed, *f)
}

// captionRuns are a caption's text runs with the caption marks only (bold, italic, link).
func (c *importConverter) captionRuns(n *html.Node) []any {
	var inline []map[string]any
	for _, s := range c.inlineSegs(htmlChildren(n), nil, false) {
		if s.node == nil {
			continue
		}
		if s.node["type"] == "hardBreak" {
			inline = append(inline, map[string]any{"type": "text", "text": " "})
			continue
		}
		if marks, ok := s.node["marks"].([]any); ok {
			var kept []any
			for _, m := range marks {
				if captionMarks[stringOf(m.(map[string]any)["type"])] {
					kept = append(kept, m)
				}
			}
			if len(kept) > 0 {
				s.node["marks"] = kept
			} else {
				delete(s.node, "marks")
			}
		}
		inline = append(inline, s.node)
	}
	return tidyInline(inline)
}

func runsText(runs []any) string { return inlineText(runs) }

// table: rows of cells, each cell's content as paragraphs; the first row is the header
// row when it is <thead> or all <th>.
func (c *importConverter) table(t *html.Node, caption []any) []*ob {
	var rows []*html.Node
	headerRow := false
	var collect func(n *html.Node, inHead bool)
	collect = func(n *html.Node, inHead bool) {
		for _, ch := range elementChildren(n) {
			switch ch.DataAtom {
			case atom.Thead:
				collect(ch, true)
			case atom.Tbody, atom.Tfoot:
				collect(ch, false)
			case atom.Tr:
				if len(rows) == 0 && inHead {
					headerRow = true
				}
				rows = append(rows, ch)
			}
		}
	}
	collect(t, false)
	if len(rows) == 0 {
		return nil
	}
	if !headerRow {
		allTH := true
		cells := 0
		for _, cell := range elementChildren(rows[0]) {
			if cell.DataAtom == atom.Td {
				allTH = false
			}
			if cell.DataAtom == atom.Td || cell.DataAtom == atom.Th {
				cells++
			}
		}
		headerRow = allTH && cells > 0
	}
	var pmRows []any
	var lines []string
	var after []*ob
	for _, row := range rows {
		var cells []any
		var texts []string
		for _, cell := range elementChildren(row) {
			if cell.DataAtom != atom.Td && cell.DataAtom != atom.Th {
				continue
			}
			paras, extra := c.importPMParagraphs(flattenParagraphs(htmlChildren(cell)), false)
			after = append(after, extra...)
			if len(paras) == 0 {
				paras = []any{importPMParagraph(nil)}
			}
			pmCell := map[string]any{"type": "tableCell", "content": paras}
			spans := map[string]any{}
			for _, name := range []string{"colspan", "rowspan"} {
				if v, err := strconv.Atoi(attr(cell, name)); err == nil && v > 1 {
					spans[name] = float64(min(v, tableMaxSpan))
				}
			}
			if len(spans) > 0 {
				pmCell["attrs"] = spans
			}
			cells = append(cells, pmCell)
			var cellTexts []string
			for _, p := range paras {
				if s := importPMText(p); s != "" {
					cellTexts = append(cellTexts, s)
				}
			}
			if len(cellTexts) > 0 {
				texts = append(texts, strings.Join(cellTexts, " "))
			}
		}
		if len(cells) == 0 {
			continue
		}
		pmRows = append(pmRows, map[string]any{"type": "tableRow", "content": cells})
		lines = append(lines, strings.TrimSpace(strings.Join(texts, " ")))
	}
	if len(pmRows) == 0 {
		return after
	}
	attrs := map[string]any{"pm": map[string]any{"type": "table", "content": pmRows}}
	if text := strings.TrimSpace(strings.Join(lines, "\n")); text != "" {
		attrs["text"] = text
		c.setLast(text)
	}
	if headerRow {
		attrs["headerRow"] = true
	}
	if len(caption) > 0 {
		attrs["caption"] = caption
	}
	return append([]*ob{newOB("table", 1, attrs)}, after...)
}

func (c *importConverter) iframe(n *html.Node) []*ob {
	src := strings.TrimSpace(attr(n, "src"))
	if provider, ref, ok := matchEmbedURL(src); ok {
		attrs := map[string]any{"provider": provider, "ref": ref}
		if title := normalizeEmbedTitle(attr(n, "title")); title != "" {
			attrs["title"] = title
		}
		return []*ob{newOB("embed", 1, attrs)}
	}
	host := "another site"
	if u, err := url.Parse(src); err == nil && u.Hostname() != "" {
		host = u.Hostname()
	}
	c.drop("Embedded frame from "+host, renderNode(n))
	return nil
}

// embedFromURL: an embed block for a provider GoLive embeds (#425), else a paragraph
// linking to the URL.
func (c *importConverter) embedFromURL(raw string, caption []any) []*ob {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if provider, ref, ok := matchEmbedURL(raw); ok {
		attrs := map[string]any{"provider": provider, "ref": ref}
		if len(caption) > 0 {
			attrs["caption"] = caption
		}
		return []*ob{newOB("embed", 1, attrs)}
	}
	if !isSafeURL(raw, safeHrefSchemes) {
		c.drop("Embed", raw)
		return nil
	}
	c.note("embeds_as_links")
	run := map[string]any{"type": "text", "text": raw, "marks": []any{map[string]any{"type": "link", "attrs": map[string]any{"href": raw}}}}
	return []*ob{c.paragraph([]map[string]any{run})}
}

func (c *importConverter) playable(n *html.Node, caption []any) []*ob {
	kind := importMediaVideo
	if n.DataAtom == atom.Audio {
		kind = importMediaAudio
	}
	src := attr(n, "src")
	if src == "" {
		if s := findFirst(htmlChildren(n), atom.Source); s != nil {
			src = attr(s, "src")
		}
	}
	if strings.TrimSpace(src) == "" {
		return nil
	}
	media, failure := c.opts.Media.resolve(importMediaRef{Kind: kind, URL: strings.TrimSpace(src)})
	if failure != nil {
		c.mediaFail(failure)
		return nil
	}
	attrs := map[string]any{"mediaId": float64(media.ID)}
	if len(caption) > 0 {
		attrs["caption"] = caption
	}
	return []*ob{newOB(kind, 1, attrs)}
}

func (c *importConverter) details(n *html.Node) []*ob {
	attrs := map[string]any{}
	var rest []*html.Node
	for _, ch := range htmlChildren(n) {
		if ch.Type == html.ElementNode && ch.DataAtom == atom.Summary {
			if runs := c.captionRuns(ch); len(runs) > 0 {
				attrs["summary"] = runs
				attrs["text"] = runsText(runs)
				c.setLast(runsText(runs))
			}
			continue
		}
		rest = append(rest, ch)
	}
	if _, open := attrValue(n, "open"); open {
		attrs["open"] = true
	}
	return []*ob{newOB("details", 1, attrs, c.blocks(rest, false)...)}
}

func (c *importConverter) definitionList(n *html.Node) []*ob {
	var out []*ob
	for _, ch := range elementChildren(n) {
		switch ch.DataAtom {
		case atom.Dt:
			bold := &html.Node{Type: html.ElementNode, DataAtom: atom.Strong, Data: "strong", FirstChild: ch.FirstChild, LastChild: ch.LastChild}
			out = append(out, c.paragraphs([]*html.Node{bold}, false)...)
		case atom.Dd:
			out = append(out, c.blocks(htmlChildren(ch), false)...)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Fitting the nesting table

// fit keeps what parent may hold and flattens what it can't: a container it doesn't
// accept gives its children instead, and so does a container left without enough
// children (a one-column "columns", an empty group). Lists are flow.
func (c *importConverter) fit(parent string, blocks []*ob) []*ob {
	var out []*ob
	for _, b := range blocks {
		if b == nil {
			continue
		}
		if rule, isContainer := blockContainers[b.typ]; isContainer {
			b.children = c.fit(b.typ, b.children)
			if b.typ == "gallery" && len(b.children) == 0 {
				continue
			}
			if len(b.children) < rule.min || (rule.max > 0 && len(b.children) > rule.max) || !fitsIn(parent, b.typ) {
				out = append(out, c.fit(parent, flattenOB(b))...)
				continue
			}
			out = append(out, b)
			continue
		}
		if fitsIn(parent, b.typ) {
			out = append(out, b)
		}
	}
	return out
}

func fitsIn(parent, typ string) bool {
	if parent == "" {
		rule, isContainer := blockContainers[typ]
		return (!isContainer || !rule.nestedOnly) && !listItemBlockTypes[typ] && !nestedOnlyAtoms[typ]
	}
	return containerAccepts(parent, typ)
}

// flattenOB is a container's content without it (a columns block's columns' content).
func flattenOB(b *ob) []*ob {
	var out []*ob
	for _, ch := range b.children {
		if _, isContainer := blockContainers[ch.typ]; isContainer && ch.typ == "column" {
			out = append(out, ch.children...)
			continue
		}
		out = append(out, ch)
	}
	return out
}

// flattenImportBlocks writes the tree as a Block Spec v1 doc.
func flattenImportBlocks(top []*ob) BlockDocV1 {
	doc := BlockDocV1{DocVersion: 1, BlocksOrder: []string{}, Blocks: map[string]interface{}{}}
	var add func(b *ob) string
	add = func(b *ob) string {
		block := map[string]interface{}{"id": b.id, "type": b.typ, "version": b.version, "attrs": b.attrs}
		_, isContainer := blockContainers[b.typ]
		if isContainer || listBlockTypes[b.typ] {
			ids := make([]interface{}, 0, len(b.children))
			for _, ch := range b.children {
				ids = append(ids, add(ch))
			}
			block["children"] = ids
		}
		doc.Blocks[b.id] = block
		return b.id
	}
	for _, b := range top {
		doc.BlocksOrder = append(doc.BlocksOrder, add(b))
	}
	return doc
}

// ---------------------------------------------------------------------------
// HTML helpers

func attr(n *html.Node, key string) string {
	v, _ := attrValue(n, key)
	return v
}

func attrValue(n *html.Node, key string) (string, bool) {
	for _, a := range n.Attr {
		if a.Namespace == "" && a.Key == key {
			return a.Val, true
		}
	}
	return "", false
}

func hasClass(n *html.Node, class string) bool {
	for _, c := range strings.Fields(attr(n, "class")) {
		if c == class {
			return true
		}
	}
	return false
}

func textOf(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode && (ch.DataAtom == atom.Script || ch.DataAtom == atom.Style) {
			continue
		}
		b.WriteString(textOf(ch))
	}
	return b.String()
}

func findFirst(nodes []*html.Node, a atom.Atom) *html.Node {
	for _, n := range nodes {
		if n.Type == html.ElementNode && n.DataAtom == a {
			return n
		}
		if found := findFirst(htmlChildren(n), a); found != nil {
			return found
		}
	}
	return nil
}

func findAll(nodes []*html.Node, a atom.Atom) []*html.Node {
	var out []*html.Node
	for _, n := range nodes {
		if n.Type == html.ElementNode && n.DataAtom == a {
			out = append(out, n)
			continue
		}
		out = append(out, findAll(htmlChildren(n), a)...)
	}
	return out
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
