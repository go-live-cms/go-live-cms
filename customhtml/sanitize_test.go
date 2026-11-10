package customhtml

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/customhtml/customhtmltest"
)

func TestSanitizeRemovesEveryPayload(t *testing.T) {
	for _, tc := range customhtmltest.XSSPayloads {
		t.Run(tc.Name, func(t *testing.T) {
			out := Sanitize(tc.Input)
			lower := strings.ToLower(out)
			for _, bad := range tc.Forbidden {
				require.NotContains(t, lower, bad, "input %q gave %q", tc.Input, out)
			}
			// Publish sanitizes what a write stored: the second pass changes nothing.
			require.Equal(t, out, Sanitize(out), "not idempotent for %q", tc.Input)
		})
	}
}

func TestSanitizeKeepsNormalMarkup(t *testing.T) {
	cases := []struct{ name, input, want string }{
		{"design's example", `<dl class="office-hours"><dt>Office hours</dt><dd>Tuesdays, 15:00 to 16:00 CET</dd></dl>`, `<dl class="office-hours"><dt>Office hours</dt><dd>Tuesdays, 15:00 to 16:00 CET</dd></dl>`},
		{"link", `<a href="https://example.com/a?b=1">x</a>`, `<a href="https://example.com/a?b=1" rel="noreferrer">x</a>`},
		{"relative link", `<a href="/about">x</a>`, `<a href="/about">x</a>`},
		{"anchor link", `<a href="#top">x</a>`, `<a href="#top">x</a>`},
		{"mailto", `<a href="mailto:a@example.com">x</a>`, `<a href="mailto:a@example.com">x</a>`},
		{"tel", `<a href="tel:+351000">x</a>`, `<a href="tel:+351000">x</a>`},
		{"image", `<img src="/uploads/media/a.jpg" alt="A cat" width="100" height="50" loading="lazy">`, `<img src="/uploads/media/a.jpg" alt="A cat" width="100" height="50" loading="lazy">`},
		{"table", `<table><thead><tr><th scope="col" colspan="2">A</th></tr></thead></table>`, `<table><thead><tr><th scope="col" colspan="2">A</th></tr></thead></table>`},
		{"aria", `<div role="note" aria-label="Note" title="Hello">x</div>`, `<div role="note" aria-label="Note" title="Hello">x</div>`},
		{"text with ampersand", `<p>Fish &amp; chips</p>`, `<p>Fish &amp; chips</p>`},
		{"style colour and spacing", `<div style="color: #333; margin-top: 8px">x</div>`, `<div style="color: #333; margin-top: 8px">x</div>`},
		{"style variable", `<p style="color: var(--text-secondary)">x</p>`, `<p style="color: var(--text-secondary)">x</p>`},
		{"style https image", `<div style="background-image: url('https://example.com/a.jpg')">x</div>`, `<div style="background-image: url(&#39;https://example.com/a.jpg&#39;)">x</div>`},
		{"style uploads image", `<div style="background-image: url(/uploads/a.jpg)">x</div>`, `<div style="background-image: url(/uploads/a.jpg)">x</div>`},
		{"style layout", `<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(1rem + 2px)">x</div>`, `<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(1rem + 2px)">x</div>`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := Sanitize(tc.input)
			require.Equal(t, tc.want, out)
			require.Equal(t, out, Sanitize(out))
		})
	}
}

// One bad declaration costs that declaration, not the element or its neighbours.
func TestSanitizeStyleKeepsTheGoodDeclarations(t *testing.T) {
	out := Sanitize(`<div style="color: red; background: url(javascript:alert(1)); margin: 0">x</div>`)
	require.Equal(t, `<div style="color: red; margin: 0">x</div>`, out)
}

func TestSanitizeDropsNULBytes(t *testing.T) {
	require.Equal(t, "<p>ab</p>", Sanitize("<p>a\x00b</p>"))
}

func TestSanitizeLinkTarget(t *testing.T) {
	out := Sanitize(`<a href="https://example.com" target="_blank" rel="noopener">x</a>`)
	require.Contains(t, out, `target="_blank"`)
	require.Contains(t, out, `noopener`)
	require.Contains(t, Sanitize(`<a href="https://example.com" target="_blank">x</a>`), `noopener`, "added when the admin left it out")
	require.NotContains(t, Sanitize(`<a href="https://example.com" target="evil">x</a>`), "target")
}

func TestSafeCSSValue(t *testing.T) {
	for value, want := range map[string]bool{
		"red":                      true,
		"rgba(0, 0, 0, .5)":        true,
		"var(--x)":                 true,
		"url(/a.png)":              true,
		"url(https://a.b/c.png)":   true,
		"expression(alert(1))":     false,
		"expression (alert(1))":    false,
		"url(javascript:alert(1))": false,
		"url(data:text/html,x)":    false,
		"url(//a.b/c.png)":         true,
		"attr(data-x)":             false,
		"calc(100% - (2 * 1rem))":  true,
		"calc(1rem*(2 + 1))":       true,
		"expression (alert(1)) x":  false,
		"-moz-element(#a)":         false,
		"unknownfunc(1)":           false,
		"e\\xpression(1)":          false,
		"a/* c */b":                false,
		"</style>":                 false,
	} {
		require.Equal(t, want, safeCSSValue(value), value)
	}
}
