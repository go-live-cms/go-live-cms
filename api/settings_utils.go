package api

import (
	"database/sql"
	"slices"
	"strings"
	"time"
	_ "time/tzdata" // time zone validation must not depend on the image having zoneinfo
	"unicode"
)

// The General and Editor settings (#330). The admin and the public site keep their own
// copies of these lists (web/src/lib/siteDates.ts, web/gl-admin/lib/settingsForm.ts);
// their tests fail if the copies drift from these.

// SiteTaglineMax is the tagline's limit in characters (also a CHECK in 000025).
const SiteTaglineMax = 160

// siteLanguage is one supported site locale: a BCP-47 tag for <html lang> and the
// date names, and the Postgres text search configuration search (#145) uses for it:
// golive_search_config_for in migration 000025, checked against this list by
// TestSearchConfigMigrationMatchesLanguages.
type siteLanguage struct {
	Tag          string
	SearchConfig string
}

var siteLanguages = []siteLanguage{
	{"en-US", "english"},
	{"en-GB", "english"},
	{"pt-BR", "portuguese"},
	{"pt-PT", "portuguese"},
	{"es-ES", "spanish"},
	{"fr-FR", "french"},
	{"de-DE", "german"},
	{"it-IT", "italian"},
	{"nl-NL", "dutch"},
}

// Embed providers an embed block (#352) may load from. The sanitizer has no embed path
// yet: it drops every iframe/embed node (disallowedNodeTypes).
var embedProviders = []string{"youtube", "vimeo", "codepen", "spotify", "soundcloud", "loom", "figma", "x"}

const maxAllowedEmbeds = 20

func siteLanguageTags() []string {
	tags := make([]string, len(siteLanguages))
	for i, l := range siteLanguages {
		tags[i] = l.Tag
	}
	return tags
}

func isSiteLanguage(tag string) bool {
	return slices.ContainsFunc(siteLanguages, func(l siteLanguage) bool { return l.Tag == tag })
}

// isTimeZone accepts IANA zone names only: "Local" and "" are what LoadLocation
// resolves to the server's own zone, which isn't a setting.
func isTimeZone(name string) bool {
	if name == "" || name == "Local" || strings.TrimSpace(name) != name {
		return false
	}
	_, err := time.LoadLocation(name)
	return err == nil
}

func isEmbedProvider(id string) bool {
	return slices.Contains(embedProviders, id)
}

// isSingleLine refuses line breaks and other control characters (a tagline goes into
// <meta> tags and a header line).
func isSingleLine(s string) bool {
	return !strings.ContainsFunc(s, unicode.IsControl)
}

// normalizeEmbeds drops duplicates, keeping the first position of each. nil (the field
// was absent) stays nil, so the stored list is kept.
func normalizeEmbeds(ids []string) []string {
	if ids == nil {
		return nil
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

func boolToNullBool(b *bool) sql.NullBool {
	if b == nil {
		return sql.NullBool{}
	}
	return sql.NullBool{Bool: *b, Valid: true}
}
