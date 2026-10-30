package api

import (
	"html"
	"strings"
	"unicode"
	"unicode/utf8"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Full-text search helpers (#145). The index is post_search (000024_post_search),
// kept current by triggers; the queries are db/query/post_search.sql.

// maxSearchQueryRunes caps the search text: longer input is cut, not refused.
const maxSearchQueryRunes = 200

// The sentinels the search queries ask ts_headline to put around each match
// (chr(57344) / chr(57345) in post_search.sql). They are private-use code
// points, and the queries remove them from the source text first, so only
// ts_headline can have placed them.
const (
	highlightStart = ''
	highlightStop  = ''
)

// normalizeSearchQuery makes the ?q= text safe to send to Postgres: valid UTF-8,
// no control characters (a NUL is an error in a text parameter), whitespace
// collapsed, and at most maxSearchQueryRunes long.
func normalizeSearchQuery(raw string) string {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == highlightStart || r == highlightStop {
			return ' '
		}
		return r
	}, strings.ToValidUTF8(raw, ""))
	query := strings.Join(strings.Fields(cleaned), " ")
	if utf8.RuneCountInString(query) > maxSearchQueryRunes {
		query = strings.TrimSpace(string([]rune(query)[:maxSearchQueryRunes]))
	}
	return query
}

// highlightHTML turns a ts_headline result with sentinel-marked matches into
// HTML: every character of the text escaped, each match wrapped in <mark>, runs
// of whitespace (the newlines between blocks) collapsed to one space. <mark> is
// the only markup it can produce, whatever the post or the query contains.
func highlightHTML(headline string) string {
	var out, segment strings.Builder
	inMark := false
	flush := func() {
		out.WriteString(html.EscapeString(segment.String()))
		segment.Reset()
	}
	for _, r := range headline {
		switch {
		case r == highlightStart:
			if !inMark {
				flush()
				out.WriteString("<mark>")
				inMark = true
			}
		case r == highlightStop:
			if inMark {
				flush()
				out.WriteString("</mark>")
				inMark = false
			}
		case unicode.IsSpace(r):
			segment.WriteRune(' ')
		default:
			segment.WriteRune(r)
		}
	}
	flush()
	if inMark {
		out.WriteString("</mark>")
	}
	return collapseSpaces(out.String())
}

// excerptHTML is a hit's highlighted excerpt with "…" where it starts or ends
// inside the text rather than at its edges.
func excerptHTML(row db.SearchPublicPostsRow) string {
	excerpt := highlightHTML(row.ExcerptHighlight)
	if excerpt == "" {
		return ""
	}
	if !row.ExcerptAtStart {
		excerpt = "…" + excerpt
	}
	if !row.ExcerptAtEnd {
		excerpt += "…"
	}
	return excerpt
}

// collapseSpaces trims and turns every run of spaces into one.
func collapseSpaces(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// The public search's types: everything, or one of the two it covers.
const (
	searchTypeAll  = "all"
	searchTypePost = "post"
	searchTypePage = "page"
)

// parseSearchType reads ?type=: "" and "all" mean both; anything but post or
// page is refused.
func parseSearchType(raw string) (string, bool) {
	switch raw {
	case "", searchTypeAll:
		return searchTypeAll, true
	case searchTypePost, searchTypePage:
		return raw, true
	}
	return "", false
}
