// Package importer reads the files the importer (#150) accepts into one shape: a
// WordPress export (WXR, Tools › Export) or a zip of Markdown files with front matter.
// It parses only; nothing here touches the database or the network. The api package
// turns an Export into an import job, converts each item's HTML into a block doc and
// imports it in the background.
//
// Both readers treat the file as hostile:
//   - WXR is read as a token stream with encoding/xml in strict mode. A DOCTYPE is
//     refused outright, so there are no external entities and no entity expansion (Go
//     never expands DTD entities; refusing it keeps that from being a question), and
//     nesting is capped. Only the standard and HTML character entities are known.
//   - A zip is read from its central directory: every entry's name is checked (no
//     absolute paths, no .., no backslashes or drive letters), a symlink refuses the whole
//     zip, entries and sizes are capped, every read is cut off at its cap whatever the
//     header claims, and an entry that expands too much is a zip bomb.
//
// The caller caps the file itself (IMPORT_MAX_SIZE) before handing it over.
package importer

import (
	"bytes"
	"html"
	"strings"
	"time"
	"unicode"
)

// Sources.
const (
	SourceWXR      = "wxr"
	SourceMarkdown = "markdown"
)

// Item statuses after reading: what the post becomes, or why it is skipped.
const (
	StatusPublished = "published"
	StatusDraft     = "draft"
)

// Error is a file the importer can't read: a fixed code and a message safe to show.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

var (
	ErrNotAnExport   = &Error{"not_an_export", "This file isn’t a WordPress export or a zip of Markdown files"}
	ErrNotWordPress  = &Error{"not_wordpress", "This XML file isn’t a WordPress export"}
	ErrUnsafeXML     = &Error{"unsafe_xml", "The export uses features GoLive doesn’t read (a DOCTYPE or entities)"}
	ErrInvalidXML    = &Error{"invalid_xml", "The export isn’t well-formed XML, so it couldn’t be read"}
	ErrTooDeep       = &Error{"too_deep", "The export nests elements too deeply"}
	ErrUnsafeZip     = &Error{"unsafe_zip", "The zip has a link or a path outside its folder, so it wasn’t read"}
	ErrZipBomb       = &Error{"zip_bomb", "A file in the zip expands far beyond its size, so the zip wasn’t read"}
	ErrZipTooLarge   = &Error{"zip_too_large", "The zip’s files are larger than GoLive reads"}
	ErrTooManyFiles  = &Error{"too_many_files", "The zip has more files than GoLive reads"}
	ErrInvalidZip    = &Error{"invalid_zip", "The zip couldn’t be read"}
	ErrNoMarkdown    = &Error{"no_markdown", "The zip has no Markdown files"}
	ErrTooManyItems  = &Error{"too_many_items", "The export has more posts than one import takes"}
	ErrMarkdownLarge = &Error{"markdown_too_large", "A Markdown file in the zip is larger than 2 MB"}
)

// Limits are the caps a read enforces. Zero values get the defaults.
type Limits struct {
	// MaxItems is the most posts and pages one export may hold.
	MaxItems int
	// MaxZipEntries is the most entries (files and folders) a zip may list.
	MaxZipEntries int
	// MaxMarkdownBytes caps one Markdown file, uncompressed.
	MaxMarkdownBytes int64
	// MaxFileBytes caps any other file kept from a zip (the upload limit).
	MaxFileBytes int64
	// MaxTotalBytes caps everything read from a zip, uncompressed.
	MaxTotalBytes int64
}

func (l Limits) withDefaults() Limits {
	if l.MaxItems <= 0 {
		l.MaxItems = 20000
	}
	if l.MaxZipEntries <= 0 {
		l.MaxZipEntries = 5000
	}
	if l.MaxMarkdownBytes <= 0 {
		l.MaxMarkdownBytes = 2 << 20
	}
	if l.MaxFileBytes <= 0 {
		l.MaxFileBytes = 10 << 20
	}
	if l.MaxTotalBytes <= 0 {
		l.MaxTotalBytes = 512 << 20
	}
	return l
}

// Export is what a file holds.
type Export struct {
	Source string
	// SiteURL is the WordPress site's address (wp:base_site_url, else the channel link);
	// images are only downloaded from its host. Empty for Markdown.
	SiteURL string
	Title   string
	Authors []Author
	Terms   []Term
	// Items are the posts, pages and other types, a page's parent before it.
	Items []Item
	// Attachments are the export's attachments by WordPress id.
	Attachments map[int64]Attachment
	// Blocks are the reusable blocks (wp_block) by id, for core/block references.
	Blocks map[int64]string
	// Files are a zip's other files (images) by their path in the zip.
	Files map[string][]byte
	// NotImported counts what the importer doesn't bring over (comments, menu items, …).
	NotImported map[string]int
}

// Author is an export's author.
type Author struct {
	Login       string `json:"login"`
	Email       string `json:"email,omitempty"`
	DisplayName string `json:"display_name"`
}

// Term is a category, tag or other term. Taxonomy is "category", "tag" or the export's
// own name for anything else. Parent is the parent's slug.
type Term struct {
	Taxonomy    string `json:"taxonomy"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Parent      string `json:"parent,omitempty"`
	Description string `json:"description,omitempty"`
}

// TermRef is a post's term.
type TermRef struct {
	Taxonomy string `json:"taxonomy"`
	Slug     string `json:"slug"`
	Name     string `json:"name"`
}

// Attachment is a WordPress attachment (a media item).
type Attachment struct {
	URL     string `json:"url"`
	Title   string `json:"title,omitempty"`
	Alt     string `json:"alt,omitempty"`
	Caption string `json:"caption,omitempty"`
}

// Item is one post or page.
type Item struct {
	// Key identifies the item across imports: the WordPress GUID, or the Markdown file's.
	Key      string `json:"key"`
	WpID     int64  `json:"wp_id,omitempty"`
	ParentID int64  `json:"parent_id,omitempty"`
	// Type is the export's post type (post, page, or a custom one).
	Type string `json:"type"`
	// Status is StatusPublished or StatusDraft; SkipReason is set for an item that is
	// never imported (in the trash, an auto-draft) and Note for a status that changed
	// (private, scheduled, pending review → draft).
	Status     string `json:"status"`
	SkipReason string `json:"skip_reason,omitempty"`
	StatusNote string `json:"status_note,omitempty"`
	Title      string `json:"title"`
	Slug       string `json:"slug,omitempty"`
	// Link is the old public URL (redirected to the new one when it differs); Aliases are
	// more old URLs (Markdown front matter).
	Link    string   `json:"link,omitempty"`
	Aliases []string `json:"aliases,omitempty"`
	Excerpt string   `json:"excerpt,omitempty"`
	// Content is HTML. Autop: it is the classic editor's, where blank lines are
	// paragraphs (WordPress's wpautop), so the converter applies the same rule.
	Content  string    `json:"content"`
	Autop    bool      `json:"autop,omitempty"`
	Author   string    `json:"author,omitempty"`
	Date     time.Time `json:"date"`
	Modified time.Time `json:"modified"`
	// Terms in the export's order (the first category is the one kept, #331).
	Terms []TermRef `json:"terms,omitempty"`
	// FeaturedID is the featured image's attachment id (WordPress); FeaturedPath its path
	// in the zip or its URL (Markdown).
	FeaturedID   int64  `json:"featured_id,omitempty"`
	FeaturedPath string `json:"featured_path,omitempty"`
	// Dir is the Markdown file's folder in the zip, for relative image paths.
	Dir string `json:"dir,omitempty"`
}

// Detect names the source a file's first bytes look like, or "".
func Detect(head []byte) string {
	if bytes.HasPrefix(head, []byte("PK\x03\x04")) {
		return SourceMarkdown
	}
	trimmed := bytes.TrimLeft(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")), " \t\r\n")
	if bytes.HasPrefix(trimmed, []byte("<?xml")) || bytes.HasPrefix(trimmed, []byte("<rss")) {
		return SourceWXR
	}
	return ""
}

// Slugify makes a term's or a post's slug from a name: lower case, letters and digits kept
// (any script), runs of anything else one hyphen. The API normalizes it again.
func Slugify(s string) string {
	var b strings.Builder
	hyphen := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			hyphen = false
			continue
		}
		if !hyphen && b.Len() > 0 {
			b.WriteByte('-')
			hyphen = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// PlainText is HTML reduced to text: tags removed, the common entities decoded, white
// space collapsed. For excerpts and titles, never for bodies.
func PlainText(markup string) string {
	var b strings.Builder
	inTag := false
	for _, r := range markup {
		switch {
		case r == '<':
			inTag = true
		case r == '>' && inTag:
			inTag = false
			b.WriteByte(' ')
		case !inTag:
			b.WriteRune(r)
		}
	}
	text := html.UnescapeString(b.String())
	return strings.Join(strings.Fields(text), " ")
}

// orderParentsFirst sorts items so that each one comes after its parent (when the parent
// is in the export), keeping the export's order otherwise. A cycle keeps the export order.
func orderParentsFirst(items []Item) []Item {
	byID := make(map[int64]int, len(items))
	for i, it := range items {
		if it.WpID != 0 {
			byID[it.WpID] = i
		}
	}
	out := make([]Item, 0, len(items))
	state := make([]uint8, len(items)) // 0 new, 1 visiting, 2 done
	var visit func(i int)
	visit = func(i int) {
		if state[i] != 0 {
			return
		}
		state[i] = 1
		if p, ok := byID[items[i].ParentID]; ok && items[i].ParentID != 0 && p != i && state[p] == 0 {
			visit(p)
		}
		state[i] = 2
		out = append(out, items[i])
	}
	for i := range items {
		visit(i)
	}
	return out
}
