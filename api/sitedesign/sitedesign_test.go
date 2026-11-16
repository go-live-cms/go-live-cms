package sitedesign

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseFile(t *testing.T) {
	ok, err := ParseFile([]byte(`{"title":"  Header ","doc":{"doc_version":1,"blocks_order":[],"blocks":{}}}`))
	require.NoError(t, err)
	require.Equal(t, "Header", ok.Title)
	require.JSONEq(t, `{"doc_version":1,"blocks_order":[],"blocks":{}}`, string(ok.Doc))

	for name, raw := range map[string]string{
		"not JSON":       `{`,
		"unknown field":  `{"title":"x","doc":{"blocks_order":[],"blocks":{}},"html":"<b>"}`,
		"trailing data":  `{"title":"x","doc":{"blocks_order":[],"blocks":{}}} {}`,
		"no title":       `{"doc":{"blocks_order":[],"blocks":{}}}`,
		"blank title":    `{"title":"   ","doc":{"blocks_order":[],"blocks":{}}}`,
		"two lines":      `{"title":"a\nb","doc":{"blocks_order":[],"blocks":{}}}`,
		"long title":     `{"title":"` + strings.Repeat("é", MaxTitleRunes+1) + `","doc":{"blocks_order":[],"blocks":{}}}`,
		"no doc":         `{"title":"x"}`,
		"doc not object": `{"title":"x","doc":[]}`,
		"doc not a spec": `{"title":"x","doc":{"blocks":{}}}`,
		"blocks array":   `{"title":"x","doc":{"blocks_order":[],"blocks":[]}}`,
	} {
		_, err := ParseFile([]byte(raw))
		require.Error(t, err, name)
	}
	_, err = ParseFile([]byte(`{"title":"x","doc":{"blocks_order":[],"blocks":{},"pad":"` + strings.Repeat("a", MaxFileBytes) + `"}}`))
	require.ErrorContains(t, err, "larger")

	// A title of exactly the limit is fine.
	_, err = ParseFile([]byte(`{"title":"` + strings.Repeat("é", MaxTitleRunes) + `","doc":{"blocks_order":[],"blocks":{}}}`))
	require.NoError(t, err)
}

func TestSlugPattern(t *testing.T) {
	for _, slug := range []string{"header", "single", "single-case_study", "archive-post", "404", "custom-" + strings.Repeat("a", 64), "a"} {
		require.True(t, SlugPattern.MatchString(slug), slug)
	}
	for _, slug := range []string{"", "Header", "-header", "_header", "../header", "header.json", "a b", strings.Repeat("a", 81)} {
		require.False(t, SlugPattern.MatchString(slug), slug)
	}
}

func TestStartersAreValid(t *testing.T) {
	names := StarterNames()
	require.ElementsMatch(t, []string{
		"template/index", "template/single", "template/page", "template/archive", "template/home", "template/search", "template/404",
		"part/header", "part/footer",
	}, names)
	for _, name := range names {
		kind, slug, _ := strings.Cut(name, "/")
		file, ok := Starter(kind, slug)
		require.True(t, ok, name)
		require.NotEmpty(t, file.Title, name)
		var doc struct {
			BlocksOrder []string                   `json:"blocks_order"`
			Blocks      map[string]json.RawMessage `json:"blocks"`
		}
		require.NoError(t, json.Unmarshal(file.Doc, &doc), name)
		require.NotEmpty(t, doc.BlocksOrder, name)
		for _, id := range doc.BlocksOrder {
			require.Contains(t, doc.Blocks, id, name)
		}
	}
}

func TestStarterLookup(t *testing.T) {
	header, ok := Starter(KindPart, "header")
	require.True(t, ok)
	require.Equal(t, "Header", header.Title)
	_, ok = Starter(KindPart, "sidebar")
	require.False(t, ok, "a part has a starter only for its own slug")

	// Every template slug has one: its own, a shorter prefix's, an alias's (#491), or the
	// generic one.
	for slug, want := range map[string]string{
		"single":            "single",
		"single-case_study": "single",
		"page":              "page",
		"page-fullwidth":    "page",
		"custom-landing":    "page",
		"archive-post":      "archive",
		"taxonomy-category": "archive",
		"author":            "archive",
		"home":              "home",
		"front-page":        "home",
		"search":            "search",
		"404":               "404",
		"index":             "index",
		"unknown-kind":      "index",
	} {
		file, ok := Starter(KindTemplate, slug)
		require.True(t, ok, slug)
		expected, ok := Starter(KindTemplate, want)
		require.True(t, ok, want)
		require.JSONEq(t, string(expected.Doc), string(file.Doc), slug)
	}
	single, _ := Starter(KindTemplate, "single")
	index, _ := Starter(KindTemplate, "index")
	require.NotEqual(t, string(index.Doc), string(single.Doc))
	for _, slug := range []string{"", "Bad", "../parts/header"} {
		_, ok := Starter(KindTemplate, slug)
		require.False(t, ok, slug)
	}
	_, ok = Starter("page", "header")
	require.False(t, ok)
}

func TestHash(t *testing.T) {
	a := Hash([]byte(`{"a":1}`))
	require.Len(t, a, 64)
	require.Equal(t, a, Hash([]byte(`{"a":1}`)))
	require.NotEqual(t, a, Hash([]byte(`{"a":2}`)))
}
