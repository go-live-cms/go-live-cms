package importer

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer/html"
	"gopkg.in/yaml.v3"
)

// maxFrontMatterBytes caps a Markdown file's front matter.
const maxFrontMatterBytes = 64 << 10

// zipBombRatio: an entry that expands more than this many times its compressed size (and
// past zipBombFloor) is refused.
const (
	zipBombRatio = 200
	zipBombFloor = 1 << 20
)

// keptFileExtensions are the zip's other files kept for the posts to use: images (the
// upload pipeline checks their content again).
var keptFileExtensions = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true, ".avif": true, ".svg": true,
}

var markdownRenderer = goldmark.New(
	goldmark.WithExtensions(extension.GFM, extension.Footnote),
	// Raw HTML is passed through to the converter, which only ever builds blocks from it
	// (never outputs it): what it can't map is dropped and reported, like WordPress HTML.
	goldmark.WithRendererOptions(html.WithUnsafe()),
)

// ParseMarkdownZip reads a zip of Markdown files. r is the zip, size its length; the caller
// caps both.
func ParseMarkdownZip(r io.ReaderAt, size int64, limits Limits) (*Export, error) {
	limits = limits.withDefaults()
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, ErrInvalidZip
	}
	if len(zr.File) > limits.MaxZipEntries {
		return nil, ErrTooManyFiles
	}
	exp := &Export{
		Source:      SourceMarkdown,
		Attachments: map[int64]Attachment{},
		Blocks:      map[int64]string{},
		Files:       map[string][]byte{},
		NotImported: map[string]int{},
	}
	// Every name is checked before anything is read, so a zip with one bad entry is
	// refused as a whole rather than imported in part.
	for _, f := range zr.File {
		if _, err := safeZipPath(f); err != nil {
			return nil, err
		}
	}
	var total int64
	authors := map[string]bool{}
	for _, f := range zr.File {
		name, _ := safeZipPath(f)
		if name == "" || f.FileInfo().IsDir() || skippedZipName(name) {
			continue
		}
		ext := strings.ToLower(path.Ext(name))
		isMarkdown := ext == ".md" || ext == ".markdown"
		if !isMarkdown && !keptFileExtensions[ext] {
			exp.NotImported["other_files"]++
			continue
		}
		limit := limits.MaxFileBytes
		if isMarkdown {
			limit = limits.MaxMarkdownBytes
		}
		if f.UncompressedSize64 > uint64(limit) {
			if isMarkdown {
				return nil, ErrMarkdownLarge
			}
			exp.NotImported["large_files"]++
			continue
		}
		if f.UncompressedSize64 > zipBombFloor && f.UncompressedSize64 > uint64(zipBombRatio)*(f.CompressedSize64+1) {
			return nil, ErrZipBomb
		}
		data, err := readZipEntry(f, limit)
		if err != nil {
			if errors.Is(err, errEntryTooLarge) {
				if isMarkdown {
					return nil, ErrMarkdownLarge
				}
				// The header lied about its size.
				return nil, ErrZipBomb
			}
			return nil, ErrInvalidZip
		}
		total += int64(len(data))
		if total > limits.MaxTotalBytes {
			return nil, ErrZipTooLarge
		}
		if !isMarkdown {
			exp.Files[name] = data
			continue
		}
		item, err := markdownItem(name, data, f.Modified)
		if err != nil {
			return nil, err
		}
		if item.Author != "" && !authors[item.Author] {
			authors[item.Author] = true
			exp.Authors = append(exp.Authors, Author{Login: item.Author, DisplayName: item.Author})
		}
		exp.Items = append(exp.Items, item)
		if len(exp.Items) > limits.MaxItems {
			return nil, ErrTooManyItems
		}
	}
	if len(exp.Items) == 0 {
		return nil, ErrNoMarkdown
	}
	// Zip order is whatever the tool wrote: sort by path for a stable import order.
	sort.SliceStable(exp.Items, func(i, j int) bool { return exp.Items[i].Key < exp.Items[j].Key })
	exp.Terms = markdownTerms(exp.Items)
	return exp, nil
}

// safeZipPath is the entry's path, checked: relative, no "..", no backslashes or drive
// letters, no control characters, and never a symlink (its target could be anywhere).
func safeZipPath(f *zip.File) (string, error) {
	if f.Mode()&fs.ModeSymlink != 0 || f.Mode()&fs.ModeType&^fs.ModeDir != 0 {
		return "", ErrUnsafeZip
	}
	name := f.Name
	if name == "" || strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "/") ||
		(len(name) >= 2 && name[1] == ':') {
		return "", ErrUnsafeZip
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", ErrUnsafeZip
		}
	}
	for _, part := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		if part == ".." || part == "." {
			return "", ErrUnsafeZip
		}
	}
	clean := path.Clean(name)
	if clean != strings.TrimSuffix(name, "/") || strings.HasPrefix(clean, "../") {
		return "", ErrUnsafeZip
	}
	return clean, nil
}

// skippedZipName: macOS resource forks and hidden files, which no export means as content.
func skippedZipName(name string) bool {
	if strings.HasPrefix(name, "__MACOSX/") {
		return true
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

var errEntryTooLarge = errors.New("zip entry larger than its limit")

// readZipEntry reads an entry, cut off one byte past limit whatever its header says.
func readZipEntry(f *zip.File, limit int64) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errEntryTooLarge
	}
	return data, nil
}

var datePrefix = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})[-_]`)

// markdownItem reads one file: front matter (YAML between --- lines), then the body.
func markdownItem(name string, data []byte, modified time.Time) (Item, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	meta, body, err := splitFrontMatter(data)
	if err != nil {
		return Item{}, &Error{"invalid_front_matter", fmt.Sprintf("The front matter of %s couldn’t be read", path.Base(name))}
	}
	stem := strings.TrimSuffix(path.Base(name), path.Ext(name))
	item := Item{
		Key:    "md:" + name,
		Type:   "post",
		Status: StatusPublished,
		Dir:    path.Dir(name),
	}
	if item.Dir == "." {
		item.Dir = ""
	}
	if s := metaString(meta, "guid", "id", "uuid"); s != "" {
		item.Key = "md:" + s
	}
	item.Title = metaString(meta, "title")
	item.Slug = metaString(meta, "slug")
	item.Excerpt = metaString(meta, "description", "excerpt", "summary")
	item.Author = metaString(meta, "author")
	if authors := metaList(meta, "authors"); item.Author == "" && len(authors) > 0 {
		item.Author = authors[0]
	}
	if t := metaString(meta, "type", "layout"); t == "page" || t == "post" {
		item.Type = t
	}
	if metaBool(meta, "draft") || strings.EqualFold(metaString(meta, "status"), "draft") {
		item.Status = StatusDraft
	}
	item.Date = metaTime(meta, "date", "published", "publishDate", "pubDate")
	item.Modified = metaTime(meta, "lastmod", "updated", "modified")
	if item.Date.IsZero() {
		if m := datePrefix.FindStringSubmatch(stem); m != nil {
			item.Date, _ = time.Parse("2006-01-02", m[1])
		}
	}
	if item.Date.IsZero() {
		item.Date = modified.UTC()
	}
	if item.Modified.IsZero() || item.Modified.Before(item.Date) {
		item.Modified = item.Date
	}
	if item.Slug == "" {
		item.Slug = Slugify(datePrefix.ReplaceAllString(stem, ""))
	}
	for _, name := range metaList(meta, "categories", "category") {
		item.Terms = append(item.Terms, TermRef{Taxonomy: "category", Slug: Slugify(name), Name: name})
	}
	for _, name := range metaList(meta, "tags", "tag", "keywords") {
		item.Terms = append(item.Terms, TermRef{Taxonomy: "tag", Slug: Slugify(name), Name: name})
	}
	item.FeaturedPath = metaString(meta, "image", "featured_image", "cover", "thumbnail", "featuredImage")
	item.Aliases = metaList(meta, "aliases", "redirect_from")
	if u := metaString(meta, "url", "permalink"); u != "" {
		item.Link = u
	}

	var out bytes.Buffer
	if err := markdownRenderer.Convert(body, &out); err != nil {
		return Item{}, &Error{"invalid_markdown", fmt.Sprintf("%s couldn’t be read", path.Base(name))}
	}
	item.Content = out.String()
	if item.Title == "" {
		item.Title, item.Content = leadingHeading(item.Content)
	}
	if item.Title == "" {
		item.Title = stem
	}
	return item, nil
}

// splitFrontMatter separates a leading "---" YAML block from the body. No front matter is
// fine (the body is the whole file).
func splitFrontMatter(data []byte) (map[string]any, []byte, error) {
	normalized := bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	if !bytes.HasPrefix(normalized, []byte("---\n")) {
		return map[string]any{}, normalized, nil
	}
	rest := normalized[4:]
	// The closing line is exactly "---".
	closing := func(at int) bool { return at == len(rest) || rest[at] == '\n' }
	var yamlPart, body []byte
	if bytes.HasPrefix(rest, []byte("---")) && closing(3) {
		body = rest[3:] // empty front matter
	} else {
		end := -1
		for from := 0; ; {
			i := bytes.Index(rest[from:], []byte("\n---"))
			if i < 0 {
				break
			}
			if at := from + i + 4; closing(at) {
				end = from + i
				break
			}
			from += i + 4
		}
		if end < 0 {
			return nil, nil, errors.New("unterminated front matter")
		}
		yamlPart, body = rest[:end], rest[end+4:]
	}
	if len(yamlPart) > maxFrontMatterBytes {
		return nil, nil, errors.New("front matter too large")
	}
	body = bytes.TrimLeft(body, "\n")
	meta := map[string]any{}
	if len(bytes.TrimSpace(yamlPart)) > 0 {
		if err := yaml.Unmarshal(yamlPart, &meta); err != nil {
			return nil, nil, err
		}
	}
	return meta, body, nil
}

func metaString(meta map[string]any, keys ...string) string {
	for _, k := range keys {
		switch v := meta[k].(type) {
		case string:
			if s := strings.TrimSpace(v); s != "" {
				return s
			}
		case int, int64, float64:
			return fmt.Sprint(v)
		}
	}
	return ""
}

func metaBool(meta map[string]any, key string) bool {
	v, _ := meta[key].(bool)
	return v
}

// metaList reads a list, or a comma-separated string, of names.
func metaList(meta map[string]any, keys ...string) []string {
	for _, k := range keys {
		var out []string
		switch v := meta[k].(type) {
		case []any:
			for _, e := range v {
				if s := strings.TrimSpace(fmt.Sprint(e)); s != "" && e != nil {
					out = append(out, s)
				}
			}
		case string:
			for _, s := range strings.Split(v, ",") {
				if s = strings.TrimSpace(s); s != "" {
					out = append(out, s)
				}
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

func metaTime(meta map[string]any, keys ...string) time.Time {
	for _, k := range keys {
		switch v := meta[k].(type) {
		case time.Time:
			return v.UTC()
		case string:
			for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02"} {
				if t, err := time.Parse(layout, strings.TrimSpace(v)); err == nil {
					return t.UTC()
				}
			}
		}
	}
	return time.Time{}
}

var leadingH1 = regexp.MustCompile(`^\s*<h1[^>]*>(.*?)</h1>\s*`)

// leadingHeading takes a leading <h1> as the title (and out of the body).
func leadingHeading(content string) (string, string) {
	m := leadingH1.FindStringSubmatchIndex(content)
	if m == nil {
		return "", content
	}
	return PlainText(content[m[2]:m[3]]), content[m[1]:]
}

// markdownTerms are the terms the files name, each once.
func markdownTerms(items []Item) []Term {
	seen := map[string]bool{}
	var terms []Term
	for _, it := range items {
		for _, ref := range it.Terms {
			key := ref.Taxonomy + ":" + ref.Slug
			if ref.Slug == "" || seen[key] {
				continue
			}
			seen[key] = true
			terms = append(terms, Term{Taxonomy: ref.Taxonomy, Slug: ref.Slug, Name: ref.Name})
		}
	}
	return terms
}
