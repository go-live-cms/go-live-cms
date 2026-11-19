package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/importer"
)

// The converter (#150) on the real-world fixtures, plus the rules one by one. The docs it
// makes from the fixtures are written to importedDocsVectorsPath, which the web suite
// seeds with the real bridge and schema (importedDocs.test.ts): the editor must build every
// block, so nothing the import kept is hidden. Regenerate with UPDATE_IMPORT_VECTORS=1.

const importedDocsVectorsPath = "../web/gl-admin/lib/collaboration/importedDocs.vectors.json"

// fakeImportMedia stands in for the downloads: example.com files are found (a media id
// per URL, in the order asked), anything else fails like another host does.
type fakeImportMedia struct {
	attachments map[int64]importer.Attachment
	ids         map[string]int64
	asked       []importMediaRef
}

func (f *fakeImportMedia) resolve(ref importMediaRef) (importedMediaItem, *importMediaFailure) {
	f.asked = append(f.asked, ref)
	raw, alt := ref.URL, ref.Alt
	if a, ok := f.attachments[ref.AttachmentID]; ok && ref.AttachmentID != 0 {
		raw, alt = a.URL, firstNonEmptyString(alt, a.Alt)
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Host != "" && u.Hostname() != "example.com") || raw == "" {
		return importedMediaItem{}, &importMediaFailure{URL: displayURL(raw), Code: importOtherHost.Code, Reason: importOtherHost.Message}
	}
	key := path.Base(resizedSuffix.ReplaceAllString(u.Path, "$1"))
	if f.ids == nil {
		f.ids = map[string]int64{}
	}
	id, ok := f.ids[key]
	if !ok {
		id = int64(len(f.ids) + 1)
		f.ids[key] = id
	}
	return importedMediaItem{ID: id, Path: "/uploads/media/" + key, Alt: alt}, nil
}

// predictableImportIDs makes block and snippet ids a counter for the test.
func predictableImportIDs(t *testing.T) {
	t.Helper()
	blocks, snippets := 0, 0
	prevBlock, prevSnippet := newImportBlockID, newImportSnippetID
	newImportBlockID = func() string { blocks++; return fmt.Sprintf("imp-%016d", blocks) }
	newImportSnippetID = func() string {
		snippets++
		return fmt.Sprintf("00000000-0000-4000-8000-%012d", snippets)
	}
	t.Cleanup(func() { newImportBlockID, newImportSnippetID = prevBlock, prevSnippet })
}

func loadWXRFixture(t *testing.T) *importer.Export {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "importer", "testdata", "wordpress-export.xml"))
	require.NoError(t, err)
	exp, err := importer.ParseWXR(bytes.NewReader(data), importer.Limits{})
	require.NoError(t, err)
	return exp
}

func fixtureItem(t *testing.T, exp *importer.Export, id int64) importer.Item {
	t.Helper()
	for _, it := range exp.Items {
		if it.WpID == id {
			return it
		}
	}
	t.Fatalf("no item %d", id)
	return importer.Item{}
}

// blocksOfType lists a doc's blocks of a type in document order (any depth).
func blocksOfType(doc BlockDocV1, typ string) []map[string]interface{} {
	var out []map[string]interface{}
	doc.walkBlocks(func(_ string, b map[string]interface{}) {
		if b["type"] == typ {
			out = append(out, b)
		}
	})
	return out
}

func topTypes(doc BlockDocV1) []string {
	var out []string
	for _, id := range doc.BlocksOrder {
		out = append(out, doc.Blocks[id].(map[string]interface{})["type"].(string))
	}
	return out
}

func impAttrs(b map[string]interface{}) map[string]interface{} {
	return b["attrs"].(map[string]interface{})
}

func childBlocks(doc BlockDocV1, b map[string]interface{}) []map[string]interface{} {
	var out []map[string]interface{}
	for _, id := range b["children"].([]interface{}) {
		out = append(out, doc.Blocks[id.(string)].(map[string]interface{}))
	}
	return out
}

// storedImport converts and runs the doc through prepareForStore, as the job does.
func storedImport(t *testing.T, content string, opts importConvertOptions) (BlockDocV1, importConversion) {
	t.Helper()
	conv := convertImportedContent(content, opts)
	doc, err := roundTripBlockDoc(conv.Doc)
	require.NoError(t, err)
	before, _ := json.Marshal(doc)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	after, _ := json.Marshal(doc)
	// The sanitizer has nothing left to remove: the converter only builds what it keeps.
	require.JSONEq(t, string(before), string(after))
	return doc, conv
}

func TestImportConvert_ClassicPost(t *testing.T) {
	predictableImportIDs(t)
	exp := loadWXRFixture(t)
	media := &fakeImportMedia{attachments: exp.Attachments}
	item := fixtureItem(t, exp, 20)
	doc, conv := storedImport(t, item.Content, importConvertOptions{Autop: item.Autop, Media: media, Reusable: exp.Blocks})

	require.Equal(t, []string{
		"paragraph", "paragraph", "image", "embed", "heading", "bullet_list", "image", "ordered_list",
		"blockquote", "gallery", "table", "paragraph", "code_block", "paragraph",
	}, topTypes(doc))

	paras := blocksOfType(doc, "paragraph")
	first := impAttrs(paras[0])
	require.Equal(t, "Welcome to the new blog. This post was written in the classic editor, so it has no paragraph tags.", first["text"])
	content := first["pm"].(map[string]interface{})["content"].([]interface{})
	require.Equal(t, map[string]interface{}{"type": "text", "text": "new", "marks": []interface{}{map[string]interface{}{"type": "bold"}}}, content[1])
	// A single line break inside a classic paragraph is a hard break.
	second := impAttrs(paras[1])["pm"].(map[string]interface{})["content"].([]interface{})
	require.Contains(t, second, map[string]interface{}{"type": "hardBreak"})
	require.Equal(t, "Prices in [brackets] stay text, like [sic].", impAttrs(paras[2])["text"])
	require.Equal(t, "The end.", impAttrs(paras[3])["text"])

	// [caption] â†’ an image at its original size (the attachment), with the attachment's
	// alt (the img had none) and the caption's runs.
	image := impAttrs(blocksOfType(doc, "image")[0])
	require.Equal(t, "/uploads/media/bike.jpg", image["src"])
	require.Equal(t, "A red bicycle against a wall", image["alt"])
	require.Equal(t, []interface{}{
		map[string]interface{}{"type": "text", "text": "Our bike, "},
		map[string]interface{}{"type": "text", "text": "by the river", "marks": []interface{}{map[string]interface{}{"type": "italic"}}},
	}, image["caption"])
	require.Equal(t, int64(10), media.asked[0].AttachmentID)

	// A bare YouTube URL on its own line is an embed.
	embed := impAttrs(blocksOfType(doc, "embed")[0])
	require.Equal(t, "youtube", embed["provider"])
	require.Equal(t, "dQw4w9WgXcQ", embed["ref"])

	// Lists: items are blocks, a nested list stays in its item's pm, an image in an item
	// follows the list.
	list := blocksOfType(doc, "bullet_list")[0]
	items := childBlocks(doc, list)
	require.Len(t, items, 3)
	require.Equal(t, "SnacksApplesBread", impAttrs(items[1])["text"])
	nested := impAttrs(items[1])["pm"].(map[string]interface{})["content"].([]interface{})[1].(map[string]interface{})
	require.Equal(t, "bulletList", nested["type"])
	require.Equal(t, "Water", impAttrs(items[2])["text"])
	require.Equal(t, "/uploads/media/team.png", impAttrs(blocksOfType(doc, "image")[1])["src"])

	quote := impAttrs(blocksOfType(doc, "blockquote")[0])
	require.Equal(t, "Anonymous", quote["cite"])
	require.Equal(t, "Travel is the only thing you buy that makes you richer.", quote["text"])

	gallery := blocksOfType(doc, "gallery")[0]
	require.Equal(t, float64(2), impAttrs(gallery)["columns"])
	require.Len(t, childBlocks(doc, gallery), 2)

	table := impAttrs(blocksOfType(doc, "table")[0])
	require.Equal(t, true, table["headerRow"])
	require.Equal(t, "Day Distance\nMonday 40 km\nRest day", table["text"])
	require.Contains(t, jsonOf(t, table["pm"]), `"colspan":2`)

	code := impAttrs(blocksOfType(doc, "code_block")[0])
	require.Equal(t, "go", code["language"])
	require.Equal(t, `fmt.Println("hi")`, code["code"])

	// Dropped: the plugin shortcode and the script, each with what it followed and the
	// original. The other host's image is a failed download, not a drop.
	require.Equal(t, []importDropped{
		{Label: "Shortcode [contact-form-7]", After: "Day Distance Monday 40 km Rest day", Original: `[contact-form-7 id="5" title="Contact form 1"]`},
		{Label: "Script", After: "Prices in [brackets] stay text, like [sic].", Original: `<script>alert("tracking")</script>`},
	}, conv.Dropped)
	require.Len(t, conv.MediaFailed, 1)
	require.Equal(t, importMediaFailure{URL: "cdn.other-host.net/banner.png", Code: "other_host", Reason: importOtherHost.Message, After: `fmt.Println("hi")`}, conv.MediaFailed[0])

	writeImportVector(t, "classic", doc)
}

func TestImportConvert_BlockEditorPost(t *testing.T) {
	predictableImportIDs(t)
	exp := loadWXRFixture(t)
	media := &fakeImportMedia{attachments: exp.Attachments}
	item := fixtureItem(t, exp, 21)
	doc, conv := storedImport(t, item.Content, importConvertOptions{Autop: item.Autop, Media: media, Reusable: exp.Blocks})

	require.Equal(t, []string{
		"heading", "paragraph", "bullet_list", "blockquote", "pull_quote", "code_block", "image", "gallery",
		"embed", "paragraph", "table", "divider", "spacer", "buttons", "columns", "group", "details", "cover",
		"media_text", "html", "heading", "paragraph", "file", "paragraph",
	}, topTypes(doc))

	marks := jsonOf(t, impAttrs(blocksOfType(doc, "paragraph")[0])["pm"])
	for _, mark := range []string{"bold", "italic", "code", "highlight", "subscript", "superscript"} {
		require.Contains(t, marks, `"type":"`+mark+`"`)
	}
	require.NotContains(t, marks, "background-color", "a highlight keeps no colour")

	// The list-item blocks of WordPress 6 become one list; the nested ordered list stays in
	// its item; strike kept.
	list := blocksOfType(doc, "bullet_list")[0]
	items := childBlocks(doc, list)
	require.Len(t, items, 2)
	require.Contains(t, jsonOf(t, impAttrs(items[1])["pm"]), `"orderedList"`)
	require.Contains(t, jsonOf(t, impAttrs(items[1])["pm"]), `"strike"`)

	require.Equal(t, "Alan Kay", impAttrs(blocksOfType(doc, "blockquote")[0])["cite"])
	pull := impAttrs(blocksOfType(doc, "pull_quote")[0])
	require.Equal(t, "The team", pull["cite"])
	require.Equal(t, "Moving is easier than you think.", pull["text"])
	require.Equal(t, "wp export --dir=/tmp && ls", impAttrs(blocksOfType(doc, "code_block")[0])["code"])

	image := impAttrs(blocksOfType(doc, "image")[0])
	require.Equal(t, "wide", image["align"])
	require.Equal(t, "Bike by the canal", image["alt"], "the post's alt wins over the library's")
	require.Contains(t, jsonOf(t, image["caption"]), `"href":"https://example.com/places/"`)

	gallery := blocksOfType(doc, "gallery")[0]
	require.Equal(t, float64(2), impAttrs(gallery)["columns"])
	galleryImages := childBlocks(doc, gallery)
	require.Len(t, galleryImages, 2)
	require.Equal(t, "Boats in the harbour at dusk", impAttrs(galleryImages[0])["alt"])
	require.Equal(t, "Fruit stalls", impAttrs(galleryImages[1])["alt"])
	require.Equal(t, "Two views of the town", runsText(impAttrs(gallery)["caption"].([]interface{})))

	embed := impAttrs(blocksOfType(doc, "embed")[0])
	require.Equal(t, "vimeo", embed["provider"])
	require.Equal(t, "A short film", runsText(embed["caption"].([]interface{})))
	// An embed from a provider GoLive doesn't embed is a link.
	require.Equal(t, "https://www.tiktok.com/@someone/video/123", impAttrs(blocksOfType(doc, "paragraph")[1])["text"])

	table := impAttrs(blocksOfType(doc, "table")[0])
	require.Equal(t, "A typical afternoon", runsText(table["caption"].([]interface{})))
	require.Equal(t, "8", impAttrs(blocksOfType(doc, "spacer")[0])["size"], "60px is nearest the 64px step")

	buttons := impAttrs(blocksOfType(doc, "buttons")[0])
	require.Equal(t, "center", buttons["align"])
	require.Equal(t, "Start now Learn more", buttons["text"])
	require.NotContains(t, jsonOf(t, buttons["pm"]), "javascript", "an unsafe href is left out")
	require.Contains(t, jsonOf(t, buttons["pm"]), `"variant":"secondary"`)

	columns := blocksOfType(doc, "columns")[0]
	require.Equal(t, "33-67", impAttrs(columns)["layout"])
	require.Equal(t, "wide", impAttrs(columns)["align"])
	cols := childBlocks(doc, columns)
	require.Len(t, cols, 2)
	var rightTypes []string
	for _, b := range childBlocks(doc, cols[1]) {
		rightTypes = append(rightTypes, b["type"].(string))
	}
	require.Equal(t, []string{"heading", "paragraph"}, rightTypes, "a group in a column gives its blocks")

	group := impAttrs(blocksOfType(doc, "group")[0])
	require.Equal(t, "tinted", group["style"])
	require.Equal(t, "full", group["align"])

	details := impAttrs(blocksOfType(doc, "details")[0])
	require.Equal(t, true, details["open"])
	require.Equal(t, "What about comments?", details["text"])

	cover := blocksOfType(doc, "cover")[0]
	require.Equal(t, float64(40), impAttrs(cover)["overlay"])
	require.Equal(t, "full", impAttrs(cover)["align"])
	require.Len(t, childBlocks(doc, cover), 1)
	mediaText := blocksOfType(doc, "media_text")[0]
	require.Equal(t, "right", impAttrs(mediaText)["position"])

	// Custom HTML: a snippet, sanitized like an admin's.
	require.Len(t, conv.Snippets, 1)
	for id, html := range conv.Snippets {
		require.Equal(t, id, impAttrs(blocksOfType(doc, "html")[0])["snippetId"])
		require.Contains(t, html, "Custom <b>markup</b>")
		require.NotContains(t, html, "onclick")
		require.NotContains(t, html, "<script")
	}

	// A plugin block with saved HTML is converted; the reusable block is inlined.
	require.Equal(t, "A plugin's heading", impAttrs(blocksOfType(doc, "heading")[2])["text"])
	require.Contains(t, jsonOf(t, doc.Blocks), "Get the ")
	require.Equal(t, "Annual report 2024", impAttrs(blocksOfType(doc, "file")[0])["label"])

	var labels []string
	for _, d := range conv.Dropped {
		labels = append(labels, d.Label)
	}
	require.Equal(t, []string{"Shortcode [newsletter_signup]", "Latest posts block", "Contact form block (jetpack)"}, labels)
	require.Equal(t, `<!-- wp:latest-posts {"postsToShow":3} /-->`, conv.Dropped[1].Original)
	require.Equal(t, "Custom markup", conv.Dropped[0].After)
	require.Contains(t, conv.Notes, "embeds_as_links")
	require.Contains(t, conv.Notes, "converted_blocks")
	require.Len(t, conv.MediaFailed, 1)
	require.Equal(t, "cdn.other-host.net/podcast.mp3", conv.MediaFailed[0].URL)

	writeImportVector(t, "blocks", doc)
}

func TestImportConvert_Markdown(t *testing.T) {
	predictableImportIDs(t)
	html := "<p>Some <strong>bold</strong> text and a <a href=\"https://gohugo.io\">link</a>.</p>\n" +
		"<p><img src=\"../images/cover.png\" alt=\"A cover\"></p>\n" +
		"<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n" +
		"<ul>\n<li><input checked=\"\" disabled=\"\" type=\"checkbox\" /> done</li>\n</ul>\n" +
		"<pre><code class=\"language-sh\">echo hi\n</code></pre>\n" +
		"<iframe src=\"https://www.youtube.com/embed/dQw4w9WgXcQ\" title=\"A video\"></iframe>\n" +
		"<iframe src=\"https://maps.example.org/embed?q=1\"></iframe>\n"
	media := &fakeImportMedia{}
	doc, conv := storedImport(t, html, importConvertOptions{Media: media})
	require.Equal(t, []string{"paragraph", "image", "table", "bullet_list", "code_block", "embed"}, topTypes(doc))
	require.Equal(t, "../images/cover.png", media.asked[0].URL)
	require.Equal(t, "A video", impAttrs(blocksOfType(doc, "embed")[0])["title"])
	require.Equal(t, "echo hi", impAttrs(blocksOfType(doc, "code_block")[0])["code"])
	require.Len(t, conv.Dropped, 2)
	require.Equal(t, "Form", conv.Dropped[0].Label, "a task list's checkbox")
	require.Equal(t, "Embedded frame from maps.example.org", conv.Dropped[1].Label)
	writeImportVector(t, "markdown", doc)
}

func TestImportConvert_Rules(t *testing.T) {
	media := &fakeImportMedia{}
	convert := func(t *testing.T, html string, autop bool) (BlockDocV1, importConversion) {
		t.Helper()
		return storedImport(t, html, importConvertOptions{Autop: autop, Media: media})
	}

	t.Run("code excludes other marks", func(t *testing.T) {
		doc, _ := convert(t, "<p><strong><code>x</code></strong></p>", false)
		require.Equal(t, `[{"marks":[{"type":"code"}],"text":"x","type":"text"}]`, jsonOf(t, impAttrs(blocksOfType(doc, "paragraph")[0])["pm"].(map[string]interface{})["content"]))
	})
	t.Run("unsafe links lose the mark, keep the text", func(t *testing.T) {
		doc, _ := convert(t, `<p><a href="javascript:alert(1)">click</a></p>`, false)
		require.Equal(t, `[{"text":"click","type":"text"}]`, jsonOf(t, impAttrs(blocksOfType(doc, "paragraph")[0])["pm"].(map[string]interface{})["content"]))
	})
	t.Run("white space collapses across runs and ends trim", func(t *testing.T) {
		doc, _ := convert(t, "<p>  a <em> b </em>  c\n</p>", false)
		require.Equal(t, "a b c", impAttrs(blocksOfType(doc, "paragraph")[0])["text"])
	})
	t.Run("empty and nbsp-only paragraphs are left out", func(t *testing.T) {
		doc, _ := convert(t, "<p>&nbsp;</p><p> </p><p>kept</p>", false)
		require.Equal(t, []string{"paragraph"}, topTypes(doc))
	})
	t.Run("an image inside a paragraph splits it", func(t *testing.T) {
		doc, _ := convert(t, `<p>before <img src="https://example.com/a.png" alt="A"> after</p>`, false)
		require.Equal(t, []string{"paragraph", "image", "paragraph"}, topTypes(doc))
	})
	t.Run("headings keep their level", func(t *testing.T) {
		doc, _ := convert(t, "<h1>One</h1><h4>Four</h4>", false)
		require.Equal(t, float64(1), impAttrs(blocksOfType(doc, "heading")[0])["level"])
		require.Equal(t, float64(4), impAttrs(blocksOfType(doc, "heading")[1])["pm"].(map[string]interface{})["attrs"].(map[string]interface{})["level"])
	})
	t.Run("a shortcode inside a sentence stays text", func(t *testing.T) {
		doc, conv := convert(t, "Call [phone] now.", true)
		require.Empty(t, conv.Dropped)
		require.Equal(t, "Call [phone] now.", impAttrs(blocksOfType(doc, "paragraph")[0])["text"])
	})
	t.Run("an enclosing shortcode alone is dropped whole", func(t *testing.T) {
		_, conv := convert(t, "Intro\n\n[accordion title=\"Q\"]\nAnswer\n[/accordion]\n\nOutro", true)
		require.Len(t, conv.Dropped, 1)
		require.Equal(t, "Shortcode [accordion]", conv.Dropped[0].Label)
		require.Equal(t, "Intro", conv.Dropped[0].After)
		require.Contains(t, conv.Dropped[0].Original, "Answer")
	})
	t.Run("a gallery without ids is reported", func(t *testing.T) {
		_, conv := convert(t, "[gallery]", true)
		require.Equal(t, "Gallery of attached images", conv.Dropped[0].Label)
	})
	t.Run("forms, svg, objects and frames are dropped with their markup", func(t *testing.T) {
		_, conv := convert(t, `<form><input name="q"></form><svg><circle/></svg><object data="x.swf"></object><iframe src="https://evil.example/x"></iframe><style>p{}</style>`, false)
		var labels []string
		for _, d := range conv.Dropped {
			labels = append(labels, d.Label)
		}
		require.Equal(t, []string{"Form", "SVG image", "Embedded object", "Embedded frame from evil.example", "Style sheet"}, labels)
		require.Contains(t, conv.Dropped[0].Original, "<input")
	})
	t.Run("the original is capped", func(t *testing.T) {
		_, conv := convert(t, "<script>"+strings.Repeat("Ã©", 6000)+"</script>", false)
		require.LessOrEqual(t, len(conv.Dropped[0].Original), importOriginalMaxBytes)
		require.True(t, strings.HasPrefix(conv.Dropped[0].Original, "<script>"))
	})
	t.Run("a one-column columns block gives its content", func(t *testing.T) {
		doc, _ := convert(t, `<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:paragraph --><p>Only</p><!-- /wp:paragraph --></div><!-- /wp:column --></div><!-- /wp:columns -->`, false)
		require.Equal(t, []string{"paragraph"}, topTypes(doc))
	})
	t.Run("an empty group is left out", func(t *testing.T) {
		doc, _ := convert(t, `<!-- wp:group --><div class="wp-block-group"></div><!-- /wp:group --><!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->`, false)
		require.Equal(t, []string{"paragraph"}, topTypes(doc))
	})
	t.Run("a gallery in a group gives its images", func(t *testing.T) {
		doc, _ := convert(t, `<!-- wp:group --><div class="wp-block-group"><!-- wp:gallery --><figure class="wp-block-gallery"><!-- wp:image {"id":5} --><figure class="wp-block-image"><img src="https://example.com/g.png" alt="g"/></figure><!-- /wp:image --></figure><!-- /wp:gallery --></div><!-- /wp:group -->`, false)
		group := blocksOfType(doc, "group")[0]
		require.Equal(t, "image", childBlocks(doc, group)[0]["type"])
	})
	t.Run("a cover with nothing on it is an image", func(t *testing.T) {
		doc, _ := convert(t, `<!-- wp:cover {"url":"https://example.com/c.jpg"} --><div class="wp-block-cover"></div><!-- /wp:cover -->`, false)
		require.Equal(t, []string{"image"}, topTypes(doc))
	})
	t.Run("a missing block keeps its original", func(t *testing.T) {
		_, conv := convert(t, `<!-- wp:missing {"originalName":"acme/slider","originalContent":"<div>slides</div>"} /-->`, false)
		require.Equal(t, importDropped{Label: "Slider block (acme)", Original: "<div>slides</div>"}, conv.Dropped[0])
	})
	t.Run("a reusable block that isn't in the export", func(t *testing.T) {
		_, conv := convert(t, `<!-- wp:block {"ref":999} /-->`, false)
		require.Equal(t, "Reusable block", conv.Dropped[0].Label)
	})
	t.Run("verse keeps its lines", func(t *testing.T) {
		doc, _ := convert(t, "<!-- wp:verse --><pre class=\"wp-block-verse\">Roses are red\nViolets are blue</pre><!-- /wp:verse -->", false)
		content := jsonOf(t, impAttrs(blocksOfType(doc, "paragraph")[0])["pm"])
		require.Contains(t, content, `"hardBreak"`)
	})
	t.Run("definition lists", func(t *testing.T) {
		doc, _ := convert(t, "<dl><dt>Term</dt><dd>Meaning</dd></dl>", false)
		require.Equal(t, []string{"paragraph", "paragraph"}, topTypes(doc))
		require.Contains(t, jsonOf(t, impAttrs(blocksOfType(doc, "paragraph")[0])["pm"]), `"bold"`)
	})
	t.Run("classic HTML details", func(t *testing.T) {
		doc, _ := convert(t, "<details><summary>More</summary><p>Hidden</p></details>", false)
		require.Equal(t, []string{"details"}, topTypes(doc))
	})
	t.Run("data: images are not imported", func(t *testing.T) {
		_, conv := convert(t, `<img src="data:image/png;base64,AAAA">`, false)
		require.Equal(t, "inline_data", conv.MediaFailed[0].Code)
	})
	t.Run("legacy core-embed blocks", func(t *testing.T) {
		doc, _ := convert(t, `<!-- wp:core-embed/youtube {"url":"https://youtu.be/dQw4w9WgXcQ"} --><figure class="wp-block-embed-youtube"><div class="wp-block-embed__wrapper">https://youtu.be/dQw4w9WgXcQ</div></figure><!-- /wp:core-embed/youtube -->`, false)
		require.Equal(t, []string{"embed"}, topTypes(doc))
	})
	t.Run("jetpack video shortcodes", func(t *testing.T) {
		doc, _ := convert(t, "[youtube https://www.youtube.com/watch?v=dQw4w9WgXcQ]\n\n[vimeo 76979871]", true)
		require.Equal(t, []string{"embed", "embed"}, topTypes(doc))
	})
	t.Run("video and audio shortcodes download the file", func(t *testing.T) {
		_, conv := convert(t, `[video mp4="https://cdn.other-host.net/a.mp4"][/video]`, true)
		require.Equal(t, "other_host", conv.MediaFailed[0].Code)
	})
	t.Run("nextpage is noted", func(t *testing.T) {
		_, conv := convert(t, "<!-- wp:nextpage --><!--nextpage--><!-- /wp:nextpage -->", false)
		require.Equal(t, []string{"page_breaks"}, conv.Notes)
	})
	t.Run("custom html that sanitizes to nothing is dropped", func(t *testing.T) {
		_, conv := convert(t, "<!-- wp:html --><script>x()</script><!-- /wp:html -->", false)
		require.Equal(t, "Custom HTML", conv.Dropped[0].Label)
	})
}

func TestParseWPBlocks(t *testing.T) {
	blocks := parseWPBlocks("intro<!-- wp:group {\"a\":{\"b\":1}} --><div><!-- wp:paragraph --><p>x</p><!-- /wp:paragraph --></div><!-- /wp:group --><!-- wp:acme/thing /-->tail")
	require.Len(t, blocks, 4)
	require.Equal(t, "", blocks[0].name)
	require.Equal(t, "core/group", blocks[1].name)
	require.Equal(t, map[string]any{"a": map[string]any{"b": float64(1)}}, blocks[1].attrs)
	require.Equal(t, "<div><p>x</p></div>", blocks[1].html())
	require.Equal(t, "<div></div>", blocks[1].ownHTML())
	require.Equal(t, "acme/thing", blocks[2].name)

	// Unclosed and stray closers don't lose content.
	blocks = parseWPBlocks("<!-- wp:paragraph --><p>open</p><!-- /wp:heading -->")
	require.Len(t, blocks, 1)
	require.Equal(t, "<p>open</p>", blocks[0].html())

	require.Equal(t, "Latest posts block", wpBlockLabel("core/latest-posts"))
	require.Equal(t, "Form block (jetpack)", wpBlockLabel("jetpack/form"))
}

// writeImportVector records a converted doc for the web's bridge test (or checks it).
func writeImportVector(t *testing.T, name string, doc BlockDocV1) {
	t.Helper()
	vectors := map[string]json.RawMessage{}
	if raw, err := os.ReadFile(importedDocsVectorsPath); err == nil {
		require.NoError(t, json.Unmarshal(raw, &vectors))
	}
	encoded, err := json.Marshal(doc)
	require.NoError(t, err)
	if os.Getenv("UPDATE_IMPORT_VECTORS") == "" {
		require.Contains(t, vectors, name, "run with UPDATE_IMPORT_VECTORS=1 to write %s", importedDocsVectorsPath)
		require.JSONEq(t, string(vectors[name]), string(encoded), "the converter's output changed: rerun with UPDATE_IMPORT_VECTORS=1 and check the web suite")
		return
	}
	vectors[name] = encoded
	keys := make([]string, 0, len(vectors))
	for k := range vectors {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out bytes.Buffer
	out.WriteString("{\n")
	for i, k := range keys {
		var pretty bytes.Buffer
		require.NoError(t, json.Indent(&pretty, vectors[k], "  ", "  "))
		fmt.Fprintf(&out, "  %q: %s", k, pretty.String())
		if i < len(keys)-1 {
			out.WriteString(",")
		}
		out.WriteString("\n")
	}
	out.WriteString("}\n")
	require.NoError(t, os.WriteFile(importedDocsVectorsPath, out.Bytes(), 0o644))
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}
