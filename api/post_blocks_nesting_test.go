package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// How blocks nest (#414). The vectors are the web's (blocks-spec/nesting.test.ts reads
// the same file), so the collab server's store and the API agree on every doc.

type nestingVector struct {
	Name    string          `json:"name"`
	Valid   bool            `json:"valid"`
	Doc     json.RawMessage `json:"doc"`
	Deduped *struct {
		BlocksOrder []string            `json:"blocks_order"`
		Children    map[string][]string `json:"children"`
	} `json:"deduped"`
}

func loadNestingVectors(t *testing.T) []nestingVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "web", "gl-admin", "lib", "blocks-spec", "nestingVectors.json"))
	require.NoError(t, err)
	var file struct {
		Vectors []nestingVector `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(raw, &file))
	require.NotEmpty(t, file.Vectors)
	return file.Vectors
}

func parseVectorDoc(t *testing.T, raw json.RawMessage) BlockDocV1 {
	t.Helper()
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal(raw, &doc))
	return doc
}

func TestNestingVectors(t *testing.T) {
	for _, v := range loadNestingVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			doc := parseVectorDoc(t, v.Doc)
			doc.deduplicateBlocks()
			err := doc.checkBlockNesting()
			if v.Valid {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
			}
			if v.Deduped != nil {
				require.Equal(t, v.Deduped.BlocksOrder, doc.BlocksOrder)
				for id, want := range v.Deduped.Children {
					block := doc.Blocks[id].(map[string]interface{})
					got := make([]string, 0)
					for _, child := range block["children"].([]interface{}) {
						got = append(got, child.(string))
					}
					require.Equal(t, want, got)
				}
			}

			// The whole store pipeline gives the same answer.
			stored := parseVectorDoc(t, v.Doc)
			storeErr := stored.prepareForStore(ThemeBlockManifest{})
			if v.Valid {
				require.NoError(t, storeErr)
			} else {
				require.Error(t, storeErr)
			}
		})
	}
}

func TestNestingTable(t *testing.T) {
	t.Run("is acyclic", func(t *testing.T) {
		var visit func(containerType string, path map[string]bool)
		visit = func(containerType string, path map[string]bool) {
			require.False(t, path[containerType], "%s holds itself", containerType)
			next := map[string]bool{containerType: true}
			for k := range path {
				next[k] = true
			}
			for _, accepted := range blockContainers[containerType].accepts {
				if _, ok := blockContainers[accepted]; ok {
					visit(accepted, next)
				}
			}
		}
		for containerType := range blockContainers {
			visit(containerType, map[string]bool{})
		}
	})

	t.Run("a group holds flow, theme and unknown types, never a container or a list item", func(t *testing.T) {
		for _, childType := range []string{"paragraph", "heading", "image", "bullet_list", "theme:example/alert", "alert"} {
			require.True(t, containerAccepts("group", childType), childType)
		}
		for _, childType := range []string{"group", "list_item"} {
			require.False(t, containerAccepts("group", childType), childType)
		}
		require.False(t, containerAccepts("paragraph", "paragraph"))
		require.False(t, containerAccepts("group", ""))
	})
}

func TestSanitize_GroupAttrs(t *testing.T) {
	doc := BlockDocV1{
		DocVersion:  1,
		BlocksOrder: []string{"group-0001"},
		Blocks: map[string]interface{}{
			"group-0001": map[string]interface{}{
				"id": "group-0001", "type": "group", "version": float64(1),
				"attrs":    map[string]interface{}{"style": "tinted", "align": "huge", "onclick": "x", "class": "evil", "pm": map[string]interface{}{"type": "group"}},
				"children": []interface{}{"para-00001"},
			},
			"para-00001": map[string]interface{}{"id": "para-00001", "type": "paragraph", "version": float64(1), "attrs": map[string]interface{}{"text": "x"}},
		},
	}
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	attrs := doc.Blocks["group-0001"].(map[string]interface{})["attrs"].(map[string]interface{})
	require.Equal(t, map[string]interface{}{"style": "tinted"}, attrs)

	t.Run("every valid value is kept", func(t *testing.T) {
		for _, attrs := range []map[string]interface{}{
			{"style": "none", "align": "content"}, {"style": "tinted", "align": "wide"}, {"align": "full"},
		} {
			got := map[string]interface{}{}
			for k, v := range attrs {
				got[k] = v
			}
			sanitizeGroupAttrs(got)
			require.Equal(t, attrs, got)
		}
		odd := map[string]interface{}{"style": 3, "align": nil}
		sanitizeGroupAttrs(odd)
		require.Empty(t, odd)
	})
}

// An image inside a group appears in the media's "Used in" (#176): contentMediaUses walks
// blocks_order, then children depth first.
func TestContentMediaUsesNested(t *testing.T) {
	doc := parseVectorDoc(t, json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["image-0001", "group-0001", "image-0003"],
		"blocks": {
			"image-0001": {"id": "image-0001", "type": "image", "version": 2, "attrs": {"mediaId": 1}},
			"group-0001": {"id": "group-0001", "type": "group", "version": 1, "attrs": {}, "children": ["para-00001", "image-0002", "list-00001"]},
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {}},
			"image-0002": {"id": "image-0002", "type": "image", "version": 2, "attrs": {"mediaId": 2}},
			"list-00001": {"id": "list-00001", "type": "bullet_list", "version": 1, "attrs": {}, "children": ["item-00001"]},
			"item-00001": {"id": "item-00001", "type": "list_item", "version": 1, "attrs": {}},
			"image-0003": {"id": "image-0003", "type": "image", "version": 2, "attrs": {"mediaId": 1}},
			"orphan-001": {"id": "orphan-001", "type": "image", "version": 2, "attrs": {"mediaId": 9}}
		}
	}`))
	uses := doc.contentMediaUses()
	require.Len(t, uses, 3)
	require.Equal(t, int64(1), uses[0].MediaID)
	require.Equal(t, "image-0001", uses[0].BlockID)
	require.Equal(t, int64(2), uses[1].MediaID)
	require.Equal(t, "image-0002", uses[1].BlockID)
	require.Equal(t, "image", uses[1].BlockType)
	require.Equal(t, "image-0003", uses[2].BlockID)
	// The public renderer's media map covers it too (it walks the flat map).
	var flat map[string]interface{}
	raw, err := json.Marshal(doc)
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &flat))
	require.ElementsMatch(t, []int64{1, 2, 1, 9}, blockDocMediaIDs(flat))
}

// regenerateBlockIDs (duplicate #354, templates #322) remaps a container's children and
// every nested id: no change was needed for nesting, this pins it.
func TestRegenerateBlockIDsNested(t *testing.T) {
	src := json.RawMessage(`{
		"doc_version": 1,
		"blocks_order": ["group-0001"],
		"blocks": {
			"group-0001": {"id": "group-0001", "type": "group", "version": 1, "attrs": {"style": "tinted"}, "children": ["para-00001", "list-00001", "image-0001"]},
			"para-00001": {"id": "para-00001", "type": "paragraph", "version": 1, "attrs": {"pm": {"type": "paragraph", "attrs": {"data-block-id": "para-00001"}, "content": [{"type": "text", "text": "hi"}]}}},
			"list-00001": {"id": "list-00001", "type": "bullet_list", "version": 1, "attrs": {}, "children": ["item-00001"]},
			"item-00001": {"id": "item-00001", "type": "list_item", "version": 1, "attrs": {"text": "one"}},
			"image-0001": {"id": "image-0001", "type": "image", "version": 2, "attrs": {"mediaId": 5}}
		}
	}`)
	out, err := regenerateBlockIDs(src, uuid.NewString)
	require.NoError(t, err)
	ids := requireRegeneratedFrom(t, src, out)
	require.Len(t, ids, 5)

	doc := parseVectorDoc(t, out)
	require.NoError(t, doc.prepareForStore(ThemeBlockManifest{}))
	require.Len(t, doc.BlocksOrder, 1)
	group := doc.Blocks[doc.BlocksOrder[0]].(map[string]interface{})
	children := group["children"].([]interface{})
	require.Len(t, children, 3)
	for _, child := range children {
		_, ok := doc.Blocks[child.(string)]
		require.True(t, ok, "child %v is in blocks", child)
		require.NotContains(t, []string{"para-00001", "list-00001", "image-0001"}, child)
	}
	uses := doc.contentMediaUses()
	require.Len(t, uses, 1)
	require.Equal(t, int64(5), uses[0].MediaID)
}
