package api

import (
	"context"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
)

// Embeds (#425, docs/design/block-library.md section 5). An `embed` block stores which
// provider (`provider`, an id of the table below), which item (`ref`, that provider's id,
// checked against its pattern) and a plain-text `title`. Never HTML from a provider, and
// never the URL someone pasted: the public page builds its player from a fixed per-provider
// template, only after the reader clicks.
//
// This table is the API's half of `web/gl-admin/lib/blocks-spec/embeds.ts`, which holds the
// other half (names, player URLs). Both test suites read `embedVectors.json` there, so a
// ref one side accepts can't be refused by the other.
//
// Security rules that this file exists to keep:
//   - Every host the API will ever fetch is a literal in `oEmbed` below. The pasted URL
//     only ever yields a ref, which must match its provider's pattern (no dots, no percent
//     signs, no way to escape the path), and the URL given to the oEmbed endpoint is
//     rebuilt from that ref.
//   - A URL is matched on its parsed, exact host: `youtube.com.evil.example`,
//     `notyoutube.com`, a user-info trick (`https://youtube.com@evil.example/`) and any
//     explicit port are refused.

// embedTitleMaxRunes caps an embed's title (Block Spec `EMBED_TITLE_MAX_LENGTH`, in code
// points too).
const embedTitleMaxRunes = 200

// embedHTMLTag is what makes a title HTML rather than text: "<" before a letter, "/", "!"
// or "?". "a < b" and "I <3 this" stay text (Block Spec `normalizeEmbedTitle`).
var embedHTMLTag = regexp.MustCompile(`<[a-zA-Z/!?]`)

// embedOEmbedAnswer is everything read from a provider's answer. Anything else in it (its
// `html` first of all) is never decoded.
type embedOEmbedAnswer struct {
	Title      string `json:"title"`
	AuthorName string `json:"author_name"`
}

type embedProvider struct {
	// hosts: the exact hostnames (lower case) a pasted URL may have.
	hosts map[string]bool
	// ref: the stored id's pattern, anchored.
	ref *regexp.Regexp
	// refFromURL reads the id out of a URL on one of `hosts`; "" when it isn't an item's URL.
	refFromURL func(u *url.URL) string
	// canonical is the item's public page, built from a valid ref.
	canonical func(ref string) string
	// oEmbed is the provider's fixed endpoint, asked about the canonical URL. HTTPS only.
	oEmbed func(canonical string) string
	// title picks the title out of the answer.
	title func(answer embedOEmbedAnswer) string
}

func embedHosts(hosts ...string) map[string]bool {
	set := make(map[string]bool, len(hosts))
	for _, host := range hosts {
		set[host] = true
	}
	return set
}

func titleOfAnswer(answer embedOEmbedAnswer) string { return answer.Title }

// firstMatch is the first submatch of `re` in s, "" without one.
func firstMatch(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

var (
	youtubeShortPath = regexp.MustCompile(`^/([A-Za-z0-9_-]{11})/?$`)
	youtubeItemPath  = regexp.MustCompile(`^/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{11})/?$`)

	vimeoItemPath   = regexp.MustCompile(`^/([0-9]{1,12})(?:/([0-9a-f]{6,32}))?/?$`)
	vimeoGroupPath  = regexp.MustCompile(`^/(?:channels/[A-Za-z0-9_-]+|groups/[A-Za-z0-9_-]+/videos)/([0-9]{1,12})/?$`)
	vimeoPlayerPath = regexp.MustCompile(`^/video/([0-9]{1,12})/?$`)
	vimeoHash       = regexp.MustCompile(`^[0-9a-f]{6,32}$`)

	xStatusPath = regexp.MustCompile(`^/(?:[A-Za-z0-9_]{1,15}|i|i/web)/status(?:es)?/([0-9]{1,25})(?:/(?:photo|video)/[0-9]+)?/?$`)

	codepenPenPath = regexp.MustCompile(`^/([A-Za-z0-9_-]{1,64})/(?:pen|full|details|embed|pres|debug)/([A-Za-z0-9]{1,16})/?$`)

	soundcloudPath = regexp.MustCompile(`^/([a-z0-9_-]{1,100}(?:/sets)?/[a-z0-9_-]{1,200})/?$`)

	spotifyPath = regexp.MustCompile(`^/(?:intl-[a-z-]{2,8}/)?(?:embed/)?((?:track|album|playlist|episode|show)/[A-Za-z0-9]{22})/?$`)
)

// embedProviderTable: the providers an embed can come from (`embedProviders`, the setting's
// allowed values, lists the same ids). The endpoints were checked against the live
// services: `publish.twitter.com` answers 301 to `publish.x.com`, another host, so X's
// endpoint is the latter.
var embedProviderTable = map[string]*embedProvider{
	"youtube": {
		hosts: embedHosts("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"),
		ref:   regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`),
		refFromURL: func(u *url.URL) string {
			if strings.EqualFold(u.Hostname(), "youtu.be") {
				return firstMatch(youtubeShortPath, u.Path)
			}
			if u.Path == "/watch" || u.Path == "/watch/" {
				return u.Query().Get("v")
			}
			return firstMatch(youtubeItemPath, u.Path)
		},
		canonical: func(ref string) string { return "https://www.youtube.com/watch?v=" + ref },
		oEmbed: func(canonical string) string {
			return "https://www.youtube.com/oembed?format=json&url=" + url.QueryEscape(canonical)
		},
		title: titleOfAnswer,
	},
	"vimeo": {
		hosts: embedHosts("vimeo.com", "www.vimeo.com", "player.vimeo.com"),
		// An unlisted video's ref carries its hash: "76979871/8272103f6e".
		ref: regexp.MustCompile(`^[0-9]{1,12}(?:/[0-9a-f]{6,32})?$`),
		refFromURL: func(u *url.URL) string {
			if strings.EqualFold(u.Hostname(), "player.vimeo.com") {
				id := firstMatch(vimeoPlayerPath, u.Path)
				if h := u.Query().Get("h"); id != "" && vimeoHash.MatchString(h) {
					return id + "/" + h
				}
				return id
			}
			if m := vimeoItemPath.FindStringSubmatch(u.Path); m != nil {
				if m[2] != "" {
					return m[1] + "/" + m[2]
				}
				return m[1]
			}
			return firstMatch(vimeoGroupPath, u.Path)
		},
		canonical: func(ref string) string { return "https://vimeo.com/" + ref },
		oEmbed: func(canonical string) string {
			return "https://vimeo.com/api/oembed.json?url=" + url.QueryEscape(canonical)
		},
		title: titleOfAnswer,
	},
	"x": {
		hosts:      embedHosts("x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"),
		ref:        regexp.MustCompile(`^[0-9]{1,25}$`),
		refFromURL: func(u *url.URL) string { return firstMatch(xStatusPath, u.Path) },
		canonical:  func(ref string) string { return "https://x.com/i/status/" + ref },
		oEmbed: func(canonical string) string {
			return "https://publish.x.com/oembed?omit_script=true&url=" + url.QueryEscape(canonical)
		},
		// X's answer has no title: the card says whose post it is ("Post by …").
		title: func(answer embedOEmbedAnswer) string {
			if strings.TrimSpace(answer.AuthorName) == "" {
				return ""
			}
			return "Post by " + answer.AuthorName
		},
	},
	"codepen": {
		hosts: embedHosts("codepen.io"),
		ref:   regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}/[A-Za-z0-9]{1,16}$`),
		refFromURL: func(u *url.URL) string {
			if m := codepenPenPath.FindStringSubmatch(u.Path); m != nil {
				return m[1] + "/" + m[2]
			}
			return ""
		},
		canonical: func(ref string) string {
			user, pen, _ := strings.Cut(ref, "/")
			return "https://codepen.io/" + user + "/pen/" + pen
		},
		oEmbed: func(canonical string) string {
			return "https://codepen.io/api/oembed?format=json&url=" + url.QueryEscape(canonical)
		},
		title: titleOfAnswer,
	},
	"soundcloud": {
		hosts:      embedHosts("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"),
		ref:        regexp.MustCompile(`^[a-z0-9_-]{1,100}(?:/sets)?/[a-z0-9_-]{1,200}$`),
		refFromURL: func(u *url.URL) string { return firstMatch(soundcloudPath, u.Path) },
		canonical:  func(ref string) string { return "https://soundcloud.com/" + ref },
		oEmbed: func(canonical string) string {
			return "https://soundcloud.com/oembed?format=json&url=" + url.QueryEscape(canonical)
		},
		title: titleOfAnswer,
	},
	"spotify": {
		hosts:      embedHosts("open.spotify.com"),
		ref:        regexp.MustCompile(`^(?:track|album|playlist|episode|show)/[A-Za-z0-9]{22}$`),
		refFromURL: func(u *url.URL) string { return firstMatch(spotifyPath, u.Path) },
		canonical:  func(ref string) string { return "https://open.spotify.com/" + ref },
		oEmbed: func(canonical string) string {
			return "https://open.spotify.com/oembed?url=" + url.QueryEscape(canonical)
		},
		title: titleOfAnswer,
	},
}

// matchEmbedURL finds the provider and ref of a pasted URL, whichever providers the site
// allows. ok is false for anything that isn't an http(s) URL of an item on a known provider's
// exact host.
func matchEmbedURL(raw string) (provider, ref string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Opaque != "" || u.User != nil || u.Port() != "" {
		return "", "", false
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", "", false
	}
	host := strings.ToLower(u.Hostname())
	for id, spec := range embedProviderTable {
		if !spec.hosts[host] {
			continue
		}
		ref := spec.refFromURL(u)
		if spec.ref.MatchString(ref) {
			return id, ref, true
		}
		return "", "", false
	}
	return "", "", false
}

// validEmbedRef reports whether ref is an item of provider, by that provider's pattern.
func validEmbedRef(provider, ref string) bool {
	spec, known := embedProviderTable[provider]
	return known && spec.ref.MatchString(ref)
}

// normalizeEmbedTitle makes a title plain text by the file label's rules (control
// characters to spaces, trimmed, capped) and refuses one holding HTML: "" then, and the
// page shows the provider's name instead. The same in Block Spec.
func normalizeEmbedTitle(raw string) string {
	attrs := map[string]interface{}{"title": raw}
	sanitizePlainText(attrs, "title", embedTitleMaxRunes)
	title, _ := attrs["title"].(string)
	if embedHTMLTag.MatchString(title) {
		return ""
	}
	return title
}

// sanitizeEmbedAttrs (#425) is the allowlist: a known `provider`, a `ref` valid for it, a
// plain-text `title` and a caption reduced like an image's. A block with a provider and no
// ref is an embed still waiting for its link.
func sanitizeEmbedAttrs(attrs map[string]interface{}) {
	keepOnlyAttrs(attrs, "provider", "ref", "title", "caption")
	provider, _ := attrs["provider"].(string)
	if _, known := embedProviderTable[provider]; !known {
		delete(attrs, "provider")
		delete(attrs, "ref")
	} else if ref, ok := attrs["ref"].(string); !ok || !validEmbedRef(provider, ref) {
		delete(attrs, "ref")
	}
	if raw, present := attrs["title"]; present {
		text, _ := raw.(string)
		if title := normalizeEmbedTitle(text); title != "" {
			attrs["title"] = title
		} else {
			delete(attrs, "title")
		}
	}
	sanitizeCaption(attrs)
}

// hideDisallowedEmbeds empties the attrs of every embed whose provider the site doesn't
// allow now, in the docs the public site is about to receive (#425): the renderer draws
// nothing for an embed with no provider, so nothing of it reaches a reader's browser. The
// stored doc is not touched, so allowing the provider again brings the block back. Docs
// with no embed cost no lookup. If the setting can't be read, every embed is hidden.
func (server *Server) hideDisallowedEmbeds(ctx context.Context, docs ...map[string]interface{}) {
	var embeds []map[string]interface{}
	for _, doc := range docs {
		blocks, _ := doc["blocks"].(map[string]interface{})
		for _, raw := range blocks {
			if block, ok := raw.(map[string]interface{}); ok && block["type"] == "embed" {
				embeds = append(embeds, block)
			}
		}
	}
	if len(embeds) == 0 {
		return
	}
	allowed := map[string]bool{}
	settings, err := server.store.GetSettings(ctx)
	if err != nil {
		slog.WarnContext(ctx, "embed_settings_lookup_failed", "error", err.Error())
	} else {
		for _, id := range settings.EditorAllowedEmbeds {
			allowed[id] = true
		}
	}
	for _, block := range embeds {
		attrs, _ := block["attrs"].(map[string]interface{})
		provider, _ := attrs["provider"].(string)
		ref, _ := attrs["ref"].(string)
		if !allowed[provider] || !validEmbedRef(provider, ref) {
			block["attrs"] = map[string]interface{}{}
		}
	}
}

// publicizeBlockDocs prepares published block docs for the public site: embeds of providers
// no longer allowed are emptied, and inline nodes get their public shape (#320).
func (server *Server) publicizeBlockDocs(ctx context.Context, docs ...map[string]interface{}) {
	server.hideDisallowedEmbeds(ctx, docs...)
	server.publicizeInlineNodes(ctx, docs...)
}
