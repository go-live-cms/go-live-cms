package customhtml

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

const (
	idA = "11111111-1111-4111-8111-111111111111"
	idB = "22222222-2222-4222-8222-222222222222"
)

func htmlDoc(attrs ...string) json.RawMessage {
	blocks := `"p1":{"id":"p1","type":"paragraph","version":1,"attrs":{"text":"x","n":12345678901234567890}}`
	order := `"p1"`
	for i, a := range attrs {
		id := fmt.Sprintf("h%d", i)
		blocks += fmt.Sprintf(`,"%s":{"id":"%s","type":"html","version":1,"attrs":%s}`, id, id, a)
		order += fmt.Sprintf(`,"%s"`, id)
	}
	return json.RawMessage(fmt.Sprintf(`{"doc_version":1,"blocks_order":[%s],"blocks":{%s}}`, order, blocks))
}

func attrsOf(t *testing.T, raw json.RawMessage, id string) map[string]interface{} {
	t.Helper()
	var doc struct {
		Blocks map[string]struct {
			Attrs map[string]interface{} `json:"attrs"`
		} `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc))
	return doc.Blocks[id].Attrs
}

func TestValidSnippetID(t *testing.T) {
	require.True(t, ValidSnippetID(idA))
	for _, bad := range []string{"", "x", "11111111-1111-4111-8111-11111111111", "11111111111141118111111111111111", "AAAAAAAA-1111-4111-8111-111111111111", idA + " ", "../" + idA} {
		require.False(t, ValidSnippetID(bad), bad)
	}
}

func TestMaterialize(t *testing.T) {
	t.Run("copies the sanitized markup", func(t *testing.T) {
		out, err := Materialize(htmlDoc(`{"snippetId":"`+idA+`"}`), map[string]string{idA: `<p onclick="x()">Hi</p>`})
		require.NoError(t, err)
		require.Equal(t, map[string]interface{}{"snippetId": idA, "html": "<p>Hi</p>"}, attrsOf(t, out, "h0"))
	})
	t.Run("another post's id renders nothing", func(t *testing.T) {
		out, err := Materialize(htmlDoc(`{"snippetId":"`+idB+`"}`), map[string]string{idA: `<p>Hi</p>`})
		require.NoError(t, err)
		require.Equal(t, map[string]interface{}{"snippetId": idB}, attrsOf(t, out, "h0"))
	})
	t.Run("inline markup never survives", func(t *testing.T) {
		out, err := Materialize(htmlDoc(`{"snippetId":"`+idB+`","html":"<script>alert(1)</script>"}`), nil)
		require.NoError(t, err)
		require.NotContains(t, attrsOf(t, out, "h0"), "html")
	})
	t.Run("no snippet id, no markup", func(t *testing.T) {
		out, err := Materialize(htmlDoc(`{"html":"<b>x</b>"}`), map[string]string{"": "<b>y</b>"})
		require.NoError(t, err)
		require.Empty(t, attrsOf(t, out, "h0"))
	})
	t.Run("empty markup renders nothing", func(t *testing.T) {
		out, err := Materialize(htmlDoc(`{"snippetId":"`+idA+`"}`), map[string]string{idA: `<script>x</script>`})
		require.NoError(t, err)
		require.NotContains(t, attrsOf(t, out, "h0"), "html")
	})
	t.Run("a document with no html block is returned as it was", func(t *testing.T) {
		raw := json.RawMessage(`{"doc_version": 1, "blocks": {}}`)
		out, err := Materialize(raw, map[string]string{idA: "x"})
		require.NoError(t, err)
		require.Equal(t, string(raw), string(out))
		// The word in a paragraph's text isn't a block.
		raw = json.RawMessage(`{"doc_version":1,"blocks":{"a":{"type":"paragraph","attrs":{"text":"\"html\""}}}}`)
		out, err = Materialize(raw, nil)
		require.NoError(t, err)
		require.Equal(t, string(raw), string(out))
	})
	t.Run("a stored empty document", func(t *testing.T) {
		out, err := Materialize(json.RawMessage(`{}`), nil)
		require.NoError(t, err)
		require.Equal(t, `{}`, string(out))
	})
	t.Run("numbers stay as written", func(t *testing.T) {
		out, err := Materialize(htmlDoc(`{"snippetId":"`+idA+`"}`), map[string]string{idA: `x`})
		require.NoError(t, err)
		require.Contains(t, string(out), "12345678901234567890")
	})
}

func TestSnippetIDs(t *testing.T) {
	require.ElementsMatch(t, []string{idA, idB}, SnippetIDs(htmlDoc(`{"snippetId":"`+idA+`"}`, `{"snippetId":"`+idB+`"}`, `{"snippetId":"`+idA+`"}`, `{}`)))
	require.Empty(t, SnippetIDs(json.RawMessage(`{}`)))
}

func TestMarkup(t *testing.T) {
	got := Markup(htmlDoc(`{"snippetId":"`+idA+`","html":"<p onclick=\"x\">a</p>"}`, `{"snippetId":"`+idB+`"}`))
	require.Equal(t, map[string]string{idA: "<p>a</p>"}, got)
}

func TestResanitize(t *testing.T) {
	out, err := Resanitize(htmlDoc(`{"snippetId":"` + idA + `","html":"<p onclick=\"x\">a</p>"}`))
	require.NoError(t, err)
	require.Equal(t, "<p>a</p>", attrsOf(t, out, "h0")["html"])

	raw := htmlDoc(`{"snippetId":"` + idA + `","html":"<p>a</p>"}`)
	out, err = Resanitize(raw)
	require.NoError(t, err)
	require.Equal(t, string(raw), string(out))
}

func TestRekey(t *testing.T) {
	next := 0
	newID := func() string { next++; return fmt.Sprintf("new-%d", next) }

	raw := htmlDoc(
		`{"snippetId":"`+idA+`","html":"<b>stale</b>"}`,
		`{"snippetId":"`+idA+`"}`,
		`{"snippetId":"`+idB+`"}`, // not in source: another post's
		`{}`,
	)
	out, snippets, err := Rekey(raw, map[string]string{idA: `<p onclick="x">a</p>`}, newID)
	require.NoError(t, err)

	require.Equal(t, []Snippet{{ID: "new-1", HTML: "<p>a</p>"}}, snippets, "a repeated id is one new snippet")
	require.Equal(t, map[string]interface{}{"snippetId": "new-1"}, attrsOf(t, out, "h0"), "the markup stays out of the doc")
	require.Equal(t, map[string]interface{}{"snippetId": "new-1"}, attrsOf(t, out, "h1"))
	require.Empty(t, attrsOf(t, out, "h2"), "a foreign id is dropped")
	require.Empty(t, attrsOf(t, out, "h3"))

	plain := json.RawMessage(`{"doc_version":1,"blocks":{}}`)
	out, snippets, err = Rekey(plain, map[string]string{idA: "x"}, newID)
	require.NoError(t, err)
	require.Empty(t, snippets)
	require.Equal(t, string(plain), string(out))
}
