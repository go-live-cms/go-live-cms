package api

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizePostSlug(t *testing.T) {
	cases := map[string]string{
		"Hello World":              "hello-world",
		"  Go_Programming  Guide":  "go-programming-guide",
		"What's new? (2026)":       "whats-new-2026",
		"a/b#c":                    "abc",
		"--Leading and trailing--": "leading-and-trailing",
		"São Paulo":                "são-paulo",
		"!!!":                      postSlugFallback,
		"":                         postSlugFallback,
	}
	for in, want := range cases {
		require.Equal(t, want, normalizePostSlug(in), "input %q", in)
	}
}
