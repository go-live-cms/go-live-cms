package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Site blocks I (#488). The vectors are the web's (blocks-spec/siteBlocks.test.ts reads the
// same file), so the editor's bridge, the collab store and the API keep and refuse the same.

type siteBlockVectors struct {
	Attrs []struct {
		Name     string                 `json:"name"`
		Type     string                 `json:"type"`
		Input    map[string]interface{} `json:"input"`
		Expected map[string]interface{} `json:"expected"`
	} `json:"attrs"`
	Kinds []struct {
		Name  string          `json:"name"`
		Kind  blockDocKind    `json:"kind"`
		Valid bool            `json:"valid"`
		Doc   json.RawMessage `json:"doc"`
	} `json:"kinds"`
}

func loadSiteBlockVectors(t *testing.T) siteBlockVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "web", "gl-admin", "lib", "blocks-spec", "siteBlockVectors.json"))
	require.NoError(t, err)
	var vectors siteBlockVectors
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors.Attrs)
	require.NotEmpty(t, vectors.Kinds)
	return vectors
}

func TestSiteBlockAttrVectors(t *testing.T) {
	for _, v := range loadSiteBlockVectors(t).Attrs {
		t.Run(v.Name, func(t *testing.T) {
			require.True(t, siteBlockTypes[v.Type], "%s is a site block type", v.Type)
			block := map[string]interface{}{"id": "block-0001", "type": v.Type, "version": float64(1), "attrs": v.Input}
			sanitizeBlock(block)
			require.Equal(t, v.Expected, block["attrs"])

			// Sanitizing what it kept changes nothing.
			again := map[string]interface{}{"id": "block-0001", "type": v.Type, "version": float64(1), "attrs": copyAttrs(v.Expected)}
			sanitizeBlock(again)
			require.Equal(t, v.Expected, again["attrs"])
		})
	}
}

func copyAttrs(attrs map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		out[k] = v
	}
	return out
}

func TestSiteBlockKindVectors(t *testing.T) {
	for _, v := range loadSiteBlockVectors(t).Kinds {
		t.Run(v.Name, func(t *testing.T) {
			doc := parseVectorDoc(t, v.Doc)
			err := doc.prepareForStoreAs(ThemeBlockManifest{}, v.Kind)
			if v.Valid {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
		})
	}
}

func TestSiteBlocksInAPost(t *testing.T) {
	t.Run("prepareForStore is the post kind: a template part stores, inert", func(t *testing.T) {
		raw := `{"doc_version":1,"blocks_order":["part-00001"],"blocks":{"part-00001":{"id":"part-00001","type":"template_part","version":1,"attrs":{"slug":"header","blocks":{}}}}}`
		doc := parseVectorDoc(t, json.RawMessage(raw))
		require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
		require.Equal(t, map[string]interface{}{"slug": "header"}, doc.Blocks["part-00001"].(map[string]interface{})["attrs"])

		part := parseVectorDoc(t, json.RawMessage(raw))
		require.ErrorContains(t, part.prepareForStoreAs(ThemeBlockManifest{}, blockDocKindPart), "template_part")
	})

	t.Run("an unknown kind is refused rather than checked as a post", func(t *testing.T) {
		doc := parseVectorDoc(t, json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`))
		require.ErrorContains(t, doc.prepareForStoreAs(ThemeBlockManifest{}, blockDocKind("page")), "kind")
	})

	t.Run("site blocks are flow, so a group or a column holds them; the query loop's are its own", func(t *testing.T) {
		for blockType := range siteBlockTypes {
			if _, container := blockContainers[blockType]; container || blockType == queryPaginationBlockType {
				require.False(t, isFlowBlockType(blockType), blockType)
				require.True(t, isCoreBlockType(blockType), blockType)
				continue
			}
			require.True(t, isFlowBlockType(blockType), blockType)
			require.True(t, containerAccepts("group", blockType), blockType)
			require.True(t, containerAccepts("column", blockType), blockType)
		}
		// #489: a query at the top level or in a group; its parts only in a query.
		require.True(t, containerAccepts("group", "query"))
		require.False(t, containerAccepts("column", "query"))
		require.False(t, containerAccepts("post_template", "query"))
		require.False(t, containerAccepts("post_template", "group"))
		require.False(t, containerAccepts("query_no_results", "group"))
		for _, part := range []string{"post_template", queryPaginationBlockType, "query_no_results"} {
			require.True(t, containerAccepts("query", part), part)
			require.False(t, containerAccepts("group", part), part)
		}
	})
}

// #489: the query loop's attrs map one to one onto /public list parameters, so whatever a
// client writes, no query string, status or SQL survives the store.
func TestSiteQueryAttrsCarryNoQueryLanguage(t *testing.T) {
	block := map[string]interface{}{"id": "query-0001", "type": "query", "version": float64(1), "attrs": map[string]interface{}{
		"postType": "post_status=draft", "where": "1=1; DROP TABLE posts", "status": "draft", "perPage": float64(500),
		"taxonomy": "category", "termIds": "1, 2,x,3", "authorId": float64(-1), "inherit": "true",
	}}
	sanitizeBlock(block)
	require.Equal(t, map[string]interface{}{"perPage": float64(24), "taxonomy": "category", "termIds": []interface{}{float64(1), float64(2), float64(3)}}, block["attrs"])
}

// #500: the comments block keeps its title only, as plain text, in every kind; where it may sit is
// the vectors' (never a part, never in a query, once per template). In a post it is inert.
func TestCommentsBlockStores(t *testing.T) {
	raw := `{"doc_version":1,"blocks_order":["comments-1","comments-2"],"blocks":{` +
		`"comments-1":{"id":"comments-1","type":"comments","version":1,"attrs":{"title":"  Responses\u0000 ","threads":[{"body":"hi"}],"postId":3,"pm":{"type":"doc"}}},` +
		`"comments-2":{"id":"comments-2","type":"comments","version":1,"attrs":{"title":"Comments"}}}}`
	doc := parseVectorDoc(t, json.RawMessage(raw))
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	require.Equal(t, map[string]interface{}{"title": "Responses"}, doc.Blocks["comments-1"].(map[string]interface{})["attrs"])
	require.Equal(t, map[string]interface{}{}, doc.Blocks["comments-2"].(map[string]interface{})["attrs"])

	template := parseVectorDoc(t, json.RawMessage(raw))
	require.ErrorContains(t, template.prepareForStoreAs(ThemeBlockManifest{}, blockDocKindTemplate), "at most one comments block")
	part := parseVectorDoc(t, json.RawMessage(raw))
	require.ErrorContains(t, part.prepareForStoreAs(ThemeBlockManifest{}, blockDocKindPart), "can't be in a part")
}
