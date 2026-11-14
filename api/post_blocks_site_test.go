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

	t.Run("site blocks are flow, so a group or a column holds them", func(t *testing.T) {
		for blockType := range siteBlockTypes {
			require.True(t, isFlowBlockType(blockType), blockType)
			require.True(t, containerAccepts("group", blockType), blockType)
			require.True(t, containerAccepts("column", blockType), blockType)
		}
	})
}
