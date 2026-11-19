package importer

import (
	"archive/zip"
	"bytes"
	"io/fs"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	require.NoError(t, err)
	return data
}

func itemByWpID(t *testing.T, exp *Export, id int64) Item {
	t.Helper()
	for _, it := range exp.Items {
		if it.WpID == id {
			return it
		}
	}
	t.Fatalf("no item %d", id)
	return Item{}
}

func TestParseWXR_RealExport(t *testing.T) {
	data := readFixture(t, "wordpress-export.xml")
	require.Equal(t, SourceWXR, Detect(data[:512]))

	exp, err := ParseWXR(bytes.NewReader(data), Limits{})
	require.NoError(t, err)
	require.Equal(t, "https://example.com", exp.SiteURL)
	require.Equal(t, "Example Blog", exp.Title)

	require.Equal(t, []Author{
		{Login: "ana", Email: "ana@example.com", DisplayName: "Ana Costa"},
		{Login: "kenji", Email: "kenji@example.com", DisplayName: "Kenji Sato"},
	}, exp.Authors)

	// Terms: categories with their parents (a percent-encoded slug decoded), tags, the
	// custom taxonomy; never menus.
	slugs := map[string]Term{}
	for _, term := range exp.Terms {
		slugs[term.Taxonomy+":"+term.Slug] = term
	}
	require.Equal(t, "guides", slugs["category:wordpress-guides"].Parent)
	require.Equal(t, "wordpress-guides", slugs["category:migrations"].Parent)
	require.Equal(t, "Café & Culture", slugs["category:café"].Name)
	require.Contains(t, slugs, "tag:news")
	require.Contains(t, slugs, "category:news")
	require.Contains(t, slugs, "genre:sci-fi")
	require.NotContains(t, slugs, "nav_menu:main")

	// Attachments by id, with alt and caption; reusable blocks.
	require.Len(t, exp.Attachments, 5)
	require.Equal(t, Attachment{URL: "https://example.com/wp-content/uploads/2024/05/bike.jpg", Title: "bike", Alt: "A red bicycle against a wall", Caption: "Our bike, by the river"}, exp.Attachments[10])
	require.Contains(t, exp.Blocks[70], "weekly")

	// Posts, pages and the custom type; a page after its parent; menu items, attachments
	// and reusable blocks are not items.
	var order []int64
	for _, it := range exp.Items {
		order = append(order, it.WpID)
	}
	require.Equal(t, []int64{20, 21, 30, 31, 40, 60}, order)
	require.Equal(t, 1, exp.NotImported["nav_menu_item"])
	require.Equal(t, 2, exp.NotImported["comments"])

	classic := itemByWpID(t, exp, 20)
	require.Equal(t, "wxr:https://example.com/?p=20", classic.Key)
	require.Equal(t, "Hello & welcome: a classic post", classic.Title)
	require.Equal(t, "hello-classic-world", classic.Slug)
	require.Equal(t, StatusPublished, classic.Status)
	require.True(t, classic.Autop, "classic content gets wpautop")
	require.Equal(t, "A short welcome.", classic.Excerpt)
	require.Equal(t, "ana", classic.Author)
	require.Equal(t, time.Date(2024, 5, 6, 11, 0, 0, 0, time.UTC), classic.Date)
	require.Equal(t, time.Date(2024, 6, 1, 7, 0, 0, 0, time.UTC), classic.Modified)
	require.Equal(t, int64(11), classic.FeaturedID)
	require.Equal(t, "https://example.com/2024/05/06/hello-classic-world/", classic.Link)
	require.Equal(t, []TermRef{
		{Taxonomy: "category", Slug: "news", Name: "News"},
		{Taxonomy: "category", Slug: "migrations", Name: "Migrations"},
		{Taxonomy: "tag", Slug: "wordpress", Name: "WordPress"},
		{Taxonomy: "tag", Slug: "news", Name: "news"},
		{Taxonomy: "genre", Slug: "sci-fi", Name: "Sci-fi"},
	}, classic.Terms)

	blocks := itemByWpID(t, exp, 21)
	require.False(t, blocks.Autop, "block editor content has its own paragraphs")
	require.Contains(t, blocks.Content, "<!-- wp:gallery")

	team := itemByWpID(t, exp, 31)
	require.Equal(t, StatusDraft, team.Status)
	require.Equal(t, "private", team.StatusNote)
	require.Equal(t, int64(30), team.ParentID)

	trashed := itemByWpID(t, exp, 40)
	require.Equal(t, "in_trash", trashed.SkipReason)
	require.True(t, trashed.Date.IsZero(), "an unsaved draft's 0000 date is no date")

	product := itemByWpID(t, exp, 60)
	require.Equal(t, "product", product.Type)
}

func TestParseWXR_RefusesUnsafeAndForeignXML(t *testing.T) {
	cases := map[string]struct {
		body string
		err  *Error
	}{
		"doctype with entities": {
			body: `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><rss><channel><wp:wxr_version xmlns:wp="http://wordpress.org/export/1.2/">1.2</wp:wxr_version><title>&b;</title></channel></rss>`,
			err:  ErrUnsafeXML,
		},
		"external entity": {
			body: `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>`,
			err:  ErrUnsafeXML,
		},
		"undeclared entity": {
			body: `<?xml version="1.0"?><rss><channel><wp:wxr_version xmlns:wp="http://wordpress.org/export/1.2/">1.2</wp:wxr_version><title>&xxe;</title></channel></rss>`,
			err:  ErrInvalidXML,
		},
		"an RSS feed, not an export": {
			body: `<?xml version="1.0"?><rss><channel><title>Feed</title><item><title>x</title></item></channel></rss>`,
			err:  ErrNotWordPress,
		},
		"another root": {
			body: `<?xml version="1.0"?><html><body/></html>`,
			err:  ErrNotWordPress,
		},
		"broken": {
			body: `<?xml version="1.0"?><rss><channel><title>open`,
			err:  ErrInvalidXML,
		},
		"another charset": {
			body: `<?xml version="1.0" encoding="UTF-16"?><rss/>`,
			err:  ErrInvalidXML,
		},
		"too deep": {
			body: `<?xml version="1.0"?><rss><channel><item>` + strings.Repeat("<a>", 100) + strings.Repeat("</a>", 100) + `</item></channel></rss>`,
			err:  ErrTooDeep,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseWXR(strings.NewReader(tc.body), Limits{})
			require.ErrorIs(t, err, tc.err)
		})
	}
}

func TestParseWXR_ItemCap(t *testing.T) {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:wxr_version>1.2</wp:wxr_version>`)
	for i := 0; i < 5; i++ {
		b.WriteString(`<item><title>p</title><wp:post_type>post</wp:post_type><wp:status>publish</wp:status></item>`)
	}
	b.WriteString(`</channel></rss>`)
	_, err := ParseWXR(strings.NewReader(b.String()), Limits{MaxItems: 3})
	require.ErrorIs(t, err, ErrTooManyItems)
	exp, err := ParseWXR(strings.NewReader(b.String()), Limits{MaxItems: 5})
	require.NoError(t, err)
	require.Len(t, exp.Items, 5)
}

func TestDetect(t *testing.T) {
	require.Equal(t, SourceMarkdown, Detect([]byte("PK\x03\x04rest")))
	require.Equal(t, SourceWXR, Detect([]byte("\xef\xbb\xbf  \n<?xml version")))
	require.Equal(t, SourceWXR, Detect([]byte("<rss version")))
	require.Equal(t, "", Detect([]byte("%PDF-1.4")))
}

func TestSlugifyAndPlainText(t *testing.T) {
	require.Equal(t, "café-culture", Slugify(" Café & Culture "))
	require.Equal(t, "go-1-24", Slugify("Go 1.24!"))
	require.Equal(t, "", Slugify("!!!"))
	require.Equal(t, "A short welcome & more", PlainText("<p>A <em>short</em>\n welcome &amp; more</p>"))
}

// zipEntry is one file of a test zip.
type zipEntry struct {
	name string
	body string
	mode fs.FileMode
}

func buildZip(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		header := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		header.Modified = time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
		if e.mode != 0 {
			header.SetMode(e.mode)
		}
		f, err := w.CreateHeader(header)
		require.NoError(t, err)
		_, err = f.Write([]byte(e.body))
		require.NoError(t, err)
	}
	require.NoError(t, w.Close())
	return buf.Bytes()
}

const markdownPost = `---
title: "Hello from Hugo"
date: 2024-03-04T05:06:07Z
lastmod: 2024-04-01
slug: hello-hugo
description: A first post.
tags: [Go, "Static sites"]
categories: Notes
author: ana
image: images/cover.png
aliases:
  - /old/hello/
---

Some **bold** text and a [link](https://gohugo.io).

![A cover](../images/cover.png)

| a | b |
|---|---|
| 1 | 2 |

- [x] done
`

func TestParseMarkdownZip(t *testing.T) {
	data := buildZip(t,
		zipEntry{name: "content/"},
		zipEntry{name: "content/posts/hello.md", body: markdownPost},
		zipEntry{name: "content/posts/2024-02-01-no-front-matter.md", body: "# Its own title\n\nBody text.\n"},
		zipEntry{name: "content/about.md", body: "---\ntitle: About\ntype: page\ndraft: true\n---\nAbout us."},
		zipEntry{name: "content/images/cover.png", body: "\x89PNG\r\n\x1a\nfake"},
		zipEntry{name: "content/notes.txt", body: "ignored"},
		zipEntry{name: "__MACOSX/content/._hello.md", body: "junk"},
		zipEntry{name: "content/.DS_Store", body: "junk"},
	)
	require.Equal(t, SourceMarkdown, Detect(data))
	exp, err := ParseMarkdownZip(bytes.NewReader(data), int64(len(data)), Limits{})
	require.NoError(t, err)
	require.Len(t, exp.Items, 3)
	require.Equal(t, []byte("\x89PNG\r\n\x1a\nfake"), exp.Files["content/images/cover.png"])
	require.Equal(t, 1, exp.NotImported["other_files"])
	require.Equal(t, []Author{{Login: "ana", DisplayName: "ana"}}, exp.Authors)

	byKey := map[string]Item{}
	for _, it := range exp.Items {
		// path#hash: the hash is the post's title, slug and date.
		path, hash, _ := strings.Cut(it.Key, "#")
		require.Len(t, hash, 12)
		byKey[path] = it
	}
	hello := byKey["md:content/posts/hello.md"]
	require.Equal(t, "Hello from Hugo", hello.Title)
	require.Equal(t, "hello-hugo", hello.Slug)
	require.Equal(t, "A first post.", hello.Excerpt)
	require.Equal(t, StatusPublished, hello.Status)
	require.Equal(t, "post", hello.Type)
	require.Equal(t, time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC), hello.Date)
	require.Equal(t, time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC), hello.Modified)
	require.Equal(t, "content/posts", hello.Dir)
	require.Equal(t, "images/cover.png", hello.FeaturedPath)
	require.Equal(t, []string{"/old/hello/"}, hello.Aliases)
	require.Equal(t, []TermRef{
		{Taxonomy: "category", Slug: "notes", Name: "Notes"},
		{Taxonomy: "tag", Slug: "go", Name: "Go"},
		{Taxonomy: "tag", Slug: "static-sites", Name: "Static sites"},
	}, hello.Terms)
	require.Contains(t, hello.Content, "<strong>bold</strong>")
	require.Contains(t, hello.Content, "<table>")
	require.Contains(t, hello.Content, `<img src="../images/cover.png" alt="A cover"`)
	require.False(t, hello.Autop)

	plain := byKey["md:content/posts/2024-02-01-no-front-matter.md"]
	require.Equal(t, "Its own title", plain.Title, "a leading heading is the title")
	require.NotContains(t, plain.Content, "<h1")
	require.Equal(t, "no-front-matter", plain.Slug)
	require.Equal(t, time.Date(2024, 2, 1, 0, 0, 0, 0, time.UTC), plain.Date)

	about := byKey["md:content/about.md"]
	require.Equal(t, "page", about.Type)
	require.Equal(t, StatusDraft, about.Status)
	require.Equal(t, time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC), about.Date, "no date: the file's")

	require.Len(t, exp.Terms, 3)
}

func TestParseMarkdownZip_GUIDKey(t *testing.T) {
	data := buildZip(t, zipEntry{name: "a.md", body: "---\nid: 42\ntitle: Keyed\n---\nx"})
	exp, err := ParseMarkdownZip(bytes.NewReader(data), int64(len(data)), Limits{})
	require.NoError(t, err)
	require.Equal(t, "md:42", exp.Items[0].Key)
}

func TestParseMarkdownZip_Refusals(t *testing.T) {
	cases := map[string]struct {
		entries []zipEntry
		limits  Limits
		err     *Error
	}{
		"path traversal":            {entries: []zipEntry{{name: "../evil.md", body: "x"}}, err: ErrUnsafeZip},
		"nested traversal":          {entries: []zipEntry{{name: "posts/../../evil.md", body: "x"}}, err: ErrUnsafeZip},
		"absolute path":             {entries: []zipEntry{{name: "/etc/evil.md", body: "x"}}, err: ErrUnsafeZip},
		"backslashes":               {entries: []zipEntry{{name: `..\evil.md`, body: "x"}}, err: ErrUnsafeZip},
		"drive letter":              {entries: []zipEntry{{name: "C:/evil.md", body: "x"}}, err: ErrUnsafeZip},
		"symlink":                   {entries: []zipEntry{{name: "link.md", body: "/etc/passwd", mode: fs.ModeSymlink | 0o777}}, err: ErrUnsafeZip},
		"one bad entry refuses all": {entries: []zipEntry{{name: "good.md", body: "fine"}, {name: "../bad.png", body: "x"}}, err: ErrUnsafeZip},
		"no markdown":               {entries: []zipEntry{{name: "a.png", body: "\x89PNG"}}, err: ErrNoMarkdown},
		"markdown too large": {
			entries: []zipEntry{{name: "big.md", body: strings.Repeat("a", 2048)}},
			limits:  Limits{MaxMarkdownBytes: 1024},
			err:     ErrMarkdownLarge,
		},
		"too many entries": {
			entries: []zipEntry{{name: "a.md", body: "a"}, {name: "b.md", body: "b"}, {name: "c.md", body: "c"}},
			limits:  Limits{MaxZipEntries: 2},
			err:     ErrTooManyFiles,
		},
		"total too large": {
			entries: []zipEntry{{name: "a.md", body: strings.Repeat("a", 600)}, {name: "b.md", body: strings.Repeat("b", 600)}},
			limits:  Limits{MaxTotalBytes: 1000},
			err:     ErrZipTooLarge,
		},
		"bomb": {
			entries: []zipEntry{{name: "bomb.md", body: strings.Repeat("0", 3<<20)}},
			limits:  Limits{MaxMarkdownBytes: 8 << 20},
			err:     ErrZipBomb,
		},
		"bad front matter": {entries: []zipEntry{{name: "a.md", body: "---\ntitle: [unclosed\n---\nx"}}, err: &Error{Code: "invalid_front_matter"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			data := buildZip(t, tc.entries...)
			_, err := ParseMarkdownZip(bytes.NewReader(data), int64(len(data)), tc.limits)
			require.Error(t, err)
			var got *Error
			require.ErrorAs(t, err, &got)
			require.Equal(t, tc.err.Code, got.Code)
		})
	}
}

func TestParseMarkdownZip_LyingHeader(t *testing.T) {
	// A header that claims a small size for a large body: the read is cut off at the cap.
	data := buildZip(t, zipEntry{name: "a.md", body: strings.Repeat("x", 4096)})
	// Patch the central directory's uncompressed size (4096 = 0x1000) to 16.
	idx := bytes.LastIndex(data, []byte("PK\x01\x02"))
	require.Greater(t, idx, 0)
	patched := append([]byte{}, data...)
	patched[idx+24], patched[idx+25], patched[idx+26], patched[idx+27] = 16, 0, 0, 0
	_, err := ParseMarkdownZip(bytes.NewReader(patched), int64(len(patched)), Limits{MaxMarkdownBytes: 1024})
	require.Error(t, err)
}

func TestParseMarkdownZip_NotAZip(t *testing.T) {
	_, err := ParseMarkdownZip(bytes.NewReader([]byte("PK\x03\x04garbage")), 12, Limits{})
	require.ErrorIs(t, err, ErrInvalidZip)
}

func TestSplitFrontMatter(t *testing.T) {
	meta, body, err := splitFrontMatter([]byte("---\r\ntitle: A\r\n---\r\nBody\r\n"))
	require.NoError(t, err)
	require.Equal(t, "A", meta["title"])
	require.Equal(t, "Body\n", string(body))

	_, body, err = splitFrontMatter([]byte("---\n---\nOnly body"))
	require.NoError(t, err)
	require.Equal(t, "Only body", string(body))

	_, _, err = splitFrontMatter([]byte("---\ntitle: A\nno end"))
	require.Error(t, err)

	// A "---" inside the YAML (not on its own line) isn't the end.
	meta, body, err = splitFrontMatter([]byte("---\ntitle: a---b\n---\nx"))
	require.NoError(t, err)
	require.Equal(t, "a---b", meta["title"])
	require.Equal(t, "x", string(body))
}

func TestParseMarkdownZip_KeysDontCollideAcrossSites(t *testing.T) {
	read := func(body string) string {
		data := buildZip(t, zipEntry{name: "content/about.md", body: body})
		exp, err := ParseMarkdownZip(bytes.NewReader(data), int64(len(data)), Limits{})
		require.NoError(t, err)
		return exp.Items[0].Key
	}
	a := read("---\ntitle: About Site A\ndate: 2024-01-01\n---\nA")
	require.Equal(t, a, read("---\ntitle: About Site A\ndate: 2024-01-01\n---\nA, edited"), "the same post again: the same key")
	require.NotEqual(t, a, read("---\ntitle: About Site B\ndate: 2025-06-01\n---\nB"), "another site's file at the same path")
	require.True(t, strings.HasPrefix(a, "md:content/about.md#"))
}
