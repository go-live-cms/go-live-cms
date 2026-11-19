package api

import (
	"html"
	"regexp"
	"strconv"
	"strings"

	nethtml "golang.org/x/net/html"
)

// WordPress shortcodes in imported HTML (#150). The ones core ships and themes use most
// become markup the converter reads: [caption] a figure, [gallery] a gallery, [embed] and
// a bare provider URL on its own line an embed, [video]/[audio] the media elements. Any
// other shortcode standing alone on its line (a plugin's contact form, a slider) has no
// GoLive equivalent: it becomes a placeholder the converter drops and reports. One inside
// a sentence stays as text: brackets in prose ("[sic]", "[1]") are not shortcodes.

var (
	shortcodeCaption = regexp.MustCompile(`(?s)\[caption([^\]]*)\](.*?)\[/caption\]`)
	shortcodeEmbed   = regexp.MustCompile(`(?s)\[embed[^\]]*\](.*?)\[/embed\]`)
	shortcodeGallery = regexp.MustCompile(`\[gallery([^\]]*)\]`)
	shortcodeMedia   = regexp.MustCompile(`(?s)\[(video|audio)([^\]]*)\](?:.*?\[/(?:video|audio)\])?`)
	shortcodeJetpack = regexp.MustCompile(`\[(youtube|vimeo)[ =]+([^\]\s]+)[^\]]*\]`)
	shortcodeAttr    = regexp.MustCompile(`([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))`)
	// A shortcode alone on its line (or its enclosing form spanning lines).
	shortcodeAlone = regexp.MustCompile(`(?m)^[ \t]*(?:<p>)?[ \t]*\[([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^\]]*)?\](?:(?s:.*?)\[/([a-zA-Z][a-zA-Z0-9_-]*)\])?[ \t]*(?:</p>)?[ \t]*$`)
	// A URL alone on its line: WordPress embeds it (oEmbed) when it can.
	bareURLLine = regexp.MustCompile(`(?m)^[ \t]*(?:<p>)?[ \t]*(https?://[^\s<>"]+)[ \t]*(?:</p>)?[ \t]*$`)
)

func shortcodeAttrs(s string) map[string]string {
	out := map[string]string{}
	for _, m := range shortcodeAttr.FindAllStringSubmatch(s, -1) {
		out[strings.ToLower(m[1])] = m[2] + m[3] + m[4]
	}
	return out
}

func escapeAttr(s string) string { return html.EscapeString(s) }

// shortcodes rewrites a body's shortcodes (see above) before it is parsed.
func (c *importConverter) shortcodes(s string, autop bool) string {
	if !strings.Contains(s, "[") && (!autop || !strings.Contains(s, "://")) {
		return s
	}
	s = shortcodeCaption.ReplaceAllStringFunc(s, func(m string) string {
		sub := shortcodeCaption.FindStringSubmatch(m)
		attrs := shortcodeAttrs(sub[1])
		inner := sub[2]
		// The image (maybe in a link) comes first, the caption text after it.
		img, text := inner, ""
		if i := strings.Index(inner, "<img"); i >= 0 {
			end := -1
			if a := strings.Index(inner[i:], "</a>"); a >= 0 && strings.Contains(inner[:i], "<a") {
				end = i + a + len("</a>")
			} else if gt := strings.Index(inner[i:], ">"); gt >= 0 {
				end = i + gt + 1
			}
			if end > 0 {
				img, text = inner[:end], strings.TrimSpace(inner[end:])
			}
		}
		if text == "" {
			text = attrs["caption"]
		}
		class := ""
		switch attrs["align"] {
		case "alignwide", "alignfull":
			class = ` class="` + attrs["align"] + `"`
		}
		return "<figure" + class + ">" + img + "<figcaption>" + text + "</figcaption></figure>"
	})
	s = shortcodeEmbed.ReplaceAllStringFunc(s, func(m string) string {
		u := strings.TrimSpace(shortcodeEmbed.FindStringSubmatch(m)[1])
		return `<` + glEmbedTag + ` data-url="` + escapeAttr(u) + `"></` + glEmbedTag + `>`
	})
	s = shortcodeJetpack.ReplaceAllStringFunc(s, func(m string) string {
		sub := shortcodeJetpack.FindStringSubmatch(m)
		u := sub[2]
		if !strings.Contains(u, "://") {
			if sub[1] == "vimeo" {
				u = "https://vimeo.com/" + u
			} else {
				u = "https://www.youtube.com/watch?v=" + u
			}
		}
		return `<` + glEmbedTag + ` data-url="` + escapeAttr(u) + `"></` + glEmbedTag + `>`
	})
	s = shortcodeGallery.ReplaceAllStringFunc(s, func(m string) string {
		attrs := shortcodeAttrs(shortcodeGallery.FindStringSubmatch(m)[1])
		return `<` + glGalleryTag + ` data-ids="` + escapeAttr(attrs["ids"]) + `" data-columns="` + escapeAttr(attrs["columns"]) + `"></` + glGalleryTag + `>`
	})
	s = shortcodeMedia.ReplaceAllStringFunc(s, func(m string) string {
		sub := shortcodeMedia.FindStringSubmatch(m)
		attrs := shortcodeAttrs(sub[2])
		src := attrs["src"]
		for _, key := range []string{"mp4", "m4v", "webm", "ogv", "mp3", "ogg", "wav", "m4a"} {
			if src == "" {
				src = attrs[key]
			}
		}
		return "<" + sub[1] + ` src="` + escapeAttr(src) + `"></` + sub[1] + ">"
	})
	if autop {
		s = bareURLLine.ReplaceAllStringFunc(s, func(m string) string {
			u := bareURLLine.FindStringSubmatch(m)[1]
			if _, _, ok := matchEmbedURL(u); !ok {
				return m
			}
			return `<` + glEmbedTag + ` data-url="` + escapeAttr(u) + `"></` + glEmbedTag + `>`
		})
	}
	s = shortcodeAlone.ReplaceAllStringFunc(s, func(m string) string {
		sub := shortcodeAlone.FindStringSubmatch(m)
		if sub[2] != "" && !strings.EqualFold(sub[1], sub[2]) {
			return m
		}
		raw := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(m), "<p>"), "</p>")
		return `<` + glShortcodeTag + ` data-name="` + escapeAttr(sub[1]) + `" data-raw="` + escapeAttr(raw) + `"></` + glShortcodeTag + `>`
	})
	return s
}

// shortcodeGallery: [gallery ids="…"] becomes a gallery of those attachments.
func (c *importConverter) shortcodeGallery(n *nethtml.Node) []*ob {
	var images []*ob
	for _, raw := range strings.Split(attr(n, "data-ids"), ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		media, failure := c.opts.Media.resolve(importMediaRef{Kind: importMediaImage, AttachmentID: id})
		if failure != nil {
			c.mediaFail(failure)
			continue
		}
		images = append(images, newOB("image", 2, imageAttrs(media, media.Alt, nil, "")))
	}
	if len(images) == 0 {
		if strings.TrimSpace(attr(n, "data-ids")) == "" {
			// [gallery] without ids shows the post's attached images, which the export
			// doesn't tie to the post reliably.
			c.drop("Gallery of attached images", "[gallery]")
		}
		return nil
	}
	columns := 3.0
	if v, err := strconv.Atoi(attr(n, "data-columns")); err == nil {
		columns = float64(max(2, min(4, v)))
	}
	return []*ob{newOB("gallery", 1, map[string]any{"columns": columns}, images...)}
}
