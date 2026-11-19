package importer

import (
	"bufio"
	"bytes"
	"encoding/xml"
	"errors"
	"html"
	"io"
	"strconv"
	"strings"
	"time"
)

// maxXMLDepth caps element nesting in a WXR file (a real export is about six deep).
const maxXMLDepth = 64

// node is one element of the export, read into memory one <item> (or channel field) at a
// time: its namespace kind, local name, attributes, text and child elements.
type node struct {
	space    string
	name     string
	attrs    []xml.Attr
	text     strings.Builder
	children []*node
}

func (n *node) child(space, name string) *node {
	for _, c := range n.children {
		if c.name == name && (space == "" || c.space == space) {
			return c
		}
	}
	return nil
}

func (n *node) value(space, name string) string {
	if c := n.child(space, name); c != nil {
		return c.text.String()
	}
	return ""
}

func (n *node) attr(name string) string {
	for _, a := range n.attrs {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

// The namespaces a WXR file uses, by kind: each export version (1.0–1.2) has its own wp
// URL, so they are told apart by what the URL holds.
const (
	nsWP      = "wp"
	nsContent = "content"
	nsExcerpt = "excerpt"
	nsDC      = "dc"
	nsOther   = ""
)

func spaceKind(url string) string {
	switch {
	case strings.Contains(url, "wordpress.org/export") && strings.HasSuffix(strings.TrimSuffix(url, "/"), "excerpt"):
		return nsExcerpt
	case strings.Contains(url, "wordpress.org/export"):
		return nsWP
	case strings.Contains(url, "purl.org/rss/1.0/modules/content"):
		return nsContent
	case strings.Contains(url, "purl.org/dc/elements"):
		return nsDC
	}
	return nsOther
}

// ParseWXR reads a WordPress export. r must already be capped by the caller.
func ParseWXR(r io.Reader, limits Limits) (*Export, error) {
	limits = limits.withDefaults()
	br := bufio.NewReader(r)
	d := xml.NewDecoder(br)
	d.Strict = true
	// The XML entities plus the HTML ones WordPress sometimes leaves in titles: a fixed
	// table, so nothing expands into more than a character or two.
	d.Entity = xml.HTMLEntity
	d.CharsetReader = func(charset string, input io.Reader) (io.Reader, error) {
		switch strings.ToLower(charset) {
		case "utf-8", "utf8", "us-ascii", "ascii":
			return input, nil
		}
		return nil, ErrInvalidXML
	}

	exp := &Export{
		Source:      SourceWXR,
		Attachments: map[int64]Attachment{},
		Blocks:      map[int64]string{},
		NotImported: map[string]int{},
	}
	var (
		sawRSS, sawWXR bool
		depth          int
		baseSite, link string
		rawItems       []*node
	)
	for {
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, xmlError(err)
		}
		switch t := tok.(type) {
		case xml.Directive:
			// <!DOCTYPE …> (and any other declaration): never in an export, and the only
			// way to declare entities.
			if bytes.HasPrefix(bytes.TrimSpace(t), []byte("DOCTYPE")) || bytes.Contains(t, []byte("ENTITY")) {
				return nil, ErrUnsafeXML
			}
		case xml.StartElement:
			depth++
			if depth > maxXMLDepth {
				return nil, ErrTooDeep
			}
			switch depth {
			case 1:
				if t.Name.Local != "rss" {
					return nil, ErrNotWordPress
				}
				sawRSS = true
			case 2:
				// <channel>
			case 3:
				n, err := readNode(d, t, depth)
				if err != nil {
					return nil, err
				}
				depth--
				kind := n.space
				switch {
				case kind == nsWP && n.name == "wxr_version":
					sawWXR = true
				case kind == nsWP && n.name == "base_site_url":
					baseSite = strings.TrimSpace(n.text.String())
				case kind == nsOther && n.name == "link":
					link = strings.TrimSpace(n.text.String())
				case kind == nsOther && n.name == "title":
					exp.Title = strings.TrimSpace(n.text.String())
				case kind == nsWP && n.name == "author":
					exp.Authors = append(exp.Authors, Author{
						Login:       strings.TrimSpace(n.value(nsWP, "author_login")),
						Email:       strings.TrimSpace(n.value(nsWP, "author_email")),
						DisplayName: unescapeName(n.value(nsWP, "author_display_name")),
					})
				case kind == nsWP && n.name == "category":
					exp.Terms = append(exp.Terms, Term{
						Taxonomy:    "category",
						Slug:        decodeSlug(n.value(nsWP, "category_nicename")),
						Name:        unescapeName(n.value(nsWP, "cat_name")),
						Parent:      decodeSlug(n.value(nsWP, "category_parent")),
						Description: strings.TrimSpace(n.value(nsWP, "category_description")),
					})
				case kind == nsWP && n.name == "tag":
					exp.Terms = append(exp.Terms, Term{
						Taxonomy:    "tag",
						Slug:        decodeSlug(n.value(nsWP, "tag_slug")),
						Name:        unescapeName(n.value(nsWP, "tag_name")),
						Description: strings.TrimSpace(n.value(nsWP, "tag_description")),
					})
				case kind == nsWP && n.name == "term":
					taxonomy := strings.TrimSpace(n.value(nsWP, "term_taxonomy"))
					switch taxonomy {
					case "category", "post_tag":
						// Also listed as wp:category / wp:tag.
					case "nav_menu", "post_format", "wp_theme", "wp_template_part_area", "link_category":
					default:
						exp.Terms = append(exp.Terms, Term{
							Taxonomy: taxonomy,
							Slug:     decodeSlug(n.value(nsWP, "term_slug")),
							Name:     unescapeName(n.value(nsWP, "term_name")),
							Parent:   decodeSlug(n.value(nsWP, "term_parent")),
						})
					}
				case kind == nsOther && n.name == "item":
					rawItems = append(rawItems, n)
					if len(rawItems) > limits.MaxItems*2 {
						return nil, ErrTooManyItems
					}
				}
			}
		case xml.EndElement:
			depth--
		}
	}
	if !sawRSS || !sawWXR {
		return nil, ErrNotWordPress
	}
	exp.SiteURL = strings.TrimRight(firstNonEmpty(baseSite, link), "/")

	var items []Item
	for _, n := range rawItems {
		item, kind := wxrItem(n)
		switch kind {
		case "attachment":
			exp.Attachments[item.WpID] = Attachment{
				URL:     strings.TrimSpace(n.value(nsWP, "attachment_url")),
				Title:   item.Title,
				Alt:     strings.TrimSpace(postMeta(n, "_wp_attachment_image_alt")),
				Caption: strings.TrimSpace(PlainText(n.value(nsExcerpt, "encoded"))),
			}
		case "wp_block":
			exp.Blocks[item.WpID] = item.Content
		case "":
			items = append(items, item)
		default:
			exp.NotImported[kind]++
		}
		if comments := countChildren(n, nsWP, "comment"); comments > 0 {
			exp.NotImported["comments"] += comments
		}
	}
	if len(items) > limits.MaxItems {
		return nil, ErrTooManyItems
	}
	exp.Items = orderParentsFirst(items)
	exp.Terms = withItemTerms(exp.Terms, exp.Items)
	return exp, nil
}

// withItemTerms adds the terms posts name that the export's term list doesn't (a partial
// export lists only some).
func withItemTerms(terms []Term, items []Item) []Term {
	seen := map[string]bool{}
	for _, t := range terms {
		seen[t.Taxonomy+":"+t.Slug] = true
	}
	for _, t := range markdownTerms(items) {
		if !seen[t.Taxonomy+":"+t.Slug] {
			seen[t.Taxonomy+":"+t.Slug] = true
			terms = append(terms, t)
		}
	}
	return terms
}

// wxrItem reads one <item>. kind is "" for a post or page (any importable type),
// "attachment", "wp_block", or the type of something never imported.
func wxrItem(n *node) (Item, string) {
	postType := strings.TrimSpace(n.value(nsWP, "post_type"))
	id, _ := strconv.ParseInt(strings.TrimSpace(n.value(nsWP, "post_id")), 10, 64)
	parent, _ := strconv.ParseInt(strings.TrimSpace(n.value(nsWP, "post_parent")), 10, 64)
	item := Item{
		WpID:     id,
		ParentID: parent,
		Type:     postType,
		Title:    strings.TrimSpace(PlainText(n.value(nsOther, "title"))),
		Slug:     decodeSlug(n.value(nsWP, "post_name")),
		Link:     strings.TrimSpace(n.value(nsOther, "link")),
		Excerpt:  PlainText(n.value(nsExcerpt, "encoded")),
		Content:  n.value(nsContent, "encoded"),
		Author:   strings.TrimSpace(n.value(nsDC, "creator")),
		Date:     wxrDate(n.value(nsWP, "post_date_gmt"), n.value(nsWP, "post_date")),
		Modified: wxrDate(n.value(nsWP, "post_modified_gmt"), n.value(nsWP, "post_modified")),
	}
	if item.Modified.IsZero() || item.Modified.Before(item.Date) {
		item.Modified = item.Date
	}
	guid := strings.TrimSpace(n.value(nsOther, "guid"))
	item.Key = "wxr:" + guid
	if guid == "" {
		item.Key = "wxr:" + strings.TrimSpace(n.value(nsOther, "link")) + "#" + strconv.FormatInt(id, 10)
	}
	switch postType {
	case "attachment", "wp_block":
		return item, postType
	case "nav_menu_item", "revision", "customize_changeset", "oembed_cache", "custom_css",
		"user_request", "wp_global_styles", "wp_template", "wp_template_part", "wp_navigation",
		"wp_font_family", "wp_font_face", "acf-field", "acf-field-group", "wpcf7_contact_form":
		return item, postType
	}
	if postType == "" {
		return item, "unknown"
	}
	switch status := strings.TrimSpace(n.value(nsWP, "status")); status {
	case "publish":
		item.Status = StatusPublished
	case "trash":
		item.Status, item.SkipReason = StatusDraft, "in_trash"
	case "auto-draft", "inherit":
		item.Status, item.SkipReason = StatusDraft, "auto_draft"
	case "private", "future", "pending":
		item.Status, item.StatusNote = StatusDraft, status
	default:
		item.Status = StatusDraft
	}
	// The block editor's posts start with a block comment; anything else is the classic
	// editor's, where WordPress adds the paragraphs on display.
	item.Autop = !strings.Contains(item.Content, "<!-- wp:")
	for _, c := range n.children {
		if c.space != nsOther || c.name != "category" {
			continue
		}
		ref := TermRef{Slug: decodeSlug(c.attr("nicename")), Name: unescapeName(c.text.String())}
		switch c.attr("domain") {
		case "category":
			ref.Taxonomy = "category"
		case "post_tag":
			ref.Taxonomy = "tag"
		case "post_format", "":
			continue
		default:
			ref.Taxonomy = c.attr("domain")
		}
		if ref.Slug == "" {
			ref.Slug = Slugify(ref.Name)
		}
		item.Terms = append(item.Terms, ref)
	}
	if thumb, err := strconv.ParseInt(strings.TrimSpace(postMeta(n, "_thumbnail_id")), 10, 64); err == nil {
		item.FeaturedID = thumb
	}
	return item, ""
}

// postMeta is the value of one wp:postmeta key of an item.
func postMeta(n *node, key string) string {
	for _, c := range n.children {
		if c.space == nsWP && c.name == "postmeta" && strings.TrimSpace(c.value(nsWP, "meta_key")) == key {
			return c.value(nsWP, "meta_value")
		}
	}
	return ""
}

func countChildren(n *node, space, name string) int {
	count := 0
	for _, c := range n.children {
		if c.space == space && c.name == name {
			count++
		}
	}
	return count
}

// readNode reads the element start opened (at depth) and everything in it.
func readNode(d *xml.Decoder, start xml.StartElement, depth int) (*node, error) {
	n := &node{space: spaceKind(start.Name.Space), name: start.Name.Local, attrs: start.Attr}
	for {
		tok, err := d.Token()
		if err != nil {
			return nil, xmlError(err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if depth+1 > maxXMLDepth {
				return nil, ErrTooDeep
			}
			child, err := readNode(d, t, depth+1)
			if err != nil {
				return nil, err
			}
			n.children = append(n.children, child)
		case xml.CharData:
			n.text.Write(t)
		case xml.Directive:
			return nil, ErrUnsafeXML
		case xml.EndElement:
			return n, nil
		}
	}
}

func xmlError(err error) error {
	var known *Error
	if errors.As(err, &known) {
		return known
	}
	var syntax *xml.SyntaxError
	if errors.As(err, &syntax) {
		return ErrInvalidXML
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return ErrInvalidXML
	}
	return err
}

// wxrDate reads WordPress's "2006-01-02 15:04:05": the GMT one, else the site-local one
// (taken as UTC). "0000-00-00 00:00:00" (an unsaved draft's) is no date.
func wxrDate(values ...string) time.Time {
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" || strings.HasPrefix(v, "0000") {
			continue
		}
		if t, err := time.ParseInLocation("2006-01-02 15:04:05", v, time.UTC); err == nil {
			return t
		}
	}
	return time.Time{}
}

// decodeSlug undoes WordPress's percent-encoding of non-ASCII slugs ("caf%c3%a9").
func decodeSlug(s string) string {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return strings.ToValidUTF8(b.String(), "")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// unescapeName: WordPress exports names HTML-escaped ("Café &amp; Culture").
func unescapeName(s string) string {
	return strings.TrimSpace(html.UnescapeString(s))
}
