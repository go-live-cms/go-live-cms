// post_block_media.go attaches what the public renderer needs about the
// images in a published block doc (#255): each image block stores only its
// mediaId and src, so the variants (for srcset), the intrinsic size and the
// focal point (for object-position) are looked up when the doc is served and
// added under the doc's "media" key, keyed by media id:
//
//	"published_blocks": {
//	  "doc_version": 1, "blocks_order": [...], "blocks": {...},
//	  "media": {"12": {"media_path": ..., "width": 1920, "height": 1080,
//	                   "variants": {...}, "focal_point": {"x": 0.4, "y": 0.3}}}
//	}
//
// It is derived on every read and never stored, so a replace or a focal point
// change shows up without republishing.
package api

import (
	"context"
	"encoding/json"
	"strconv"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// BlockMedia is the per-media info added to a published doc's "media" map.
type BlockMedia struct {
	MediaPath  string        `json:"media_path"`
	Width      int32         `json:"width"`
	Height     int32         `json:"height"`
	Variants   MediaVariants `json:"variants"`
	FocalPoint *FocalPoint   `json:"focal_point"`
}

// isBlockDocShape reports whether a decoded doc would also decode into
// BlockDocV1: doc_version a number, blocks_order an array of strings, blocks
// an object. Like that decode, absent or null fields are fine.
func isBlockDocShape(doc map[string]interface{}) bool {
	if doc == nil {
		return false
	}
	if v, ok := doc["doc_version"]; ok && v != nil {
		if _, isNum := v.(float64); !isNum {
			return false
		}
	}
	if v, ok := doc["blocks_order"]; ok && v != nil {
		order, isArr := v.([]interface{})
		if !isArr {
			return false
		}
		for _, id := range order {
			if _, isStr := id.(string); !isStr {
				return false
			}
		}
	}
	if v, ok := doc["blocks"]; ok && v != nil {
		if _, isObj := v.(map[string]interface{}); !isObj {
			return false
		}
	}
	return true
}

// blockDocMediaIDs returns the mediaIds of the doc's image blocks.
func blockDocMediaIDs(doc map[string]interface{}) []int64 {
	blocks, _ := doc["blocks"].(map[string]interface{})
	var ids []int64
	for _, raw := range blocks {
		block, _ := raw.(map[string]interface{})
		if block == nil || block["type"] != "image" {
			continue
		}
		attrs, _ := block["attrs"].(map[string]interface{})
		if id, ok := blockMediaID(attrs["mediaId"]); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// blockMediaID reads a mediaId attribute (a JSON number, or a numeric string
// from older docs).
func blockMediaID(v interface{}) (int64, bool) {
	var id int64
	switch n := v.(type) {
	case float64:
		if n != float64(int64(n)) {
			return 0, false
		}
		id = int64(n)
	case json.Number:
		parsed, err := n.Int64()
		if err != nil {
			return 0, false
		}
		id = parsed
	case string:
		parsed, err := strconv.ParseInt(n, 10, 64)
		if err != nil {
			return 0, false
		}
		id = parsed
	default:
		return 0, false
	}
	return id, id > 0
}

// attachBlockMedia adds the "media" map to each doc that has image blocks,
// with one query for all of them. Best effort: on a lookup error the docs
// are served without it and images render from their src alone.
func (server *Server) attachBlockMedia(ctx context.Context, docs ...map[string]interface{}) {
	perDoc := make([][]int64, len(docs))
	seen := map[int64]bool{}
	var ids []int64
	for i, doc := range docs {
		if doc == nil {
			continue
		}
		perDoc[i] = blockDocMediaIDs(doc)
		for _, id := range perDoc[i] {
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	if len(ids) == 0 {
		return
	}

	rows, err := server.store.GetMediaByIDs(ctx, ids)
	if err != nil {
		server.logger.Warn("loading block media failed; images served without variants", "error", err)
		return
	}
	byID := make(map[int64]db.Medium, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}

	for i, doc := range docs {
		media := map[string]BlockMedia{}
		for _, id := range perDoc[i] {
			row, ok := byID[id]
			if !ok {
				continue
			}
			media[strconv.FormatInt(id, 10)] = BlockMedia{
				MediaPath:  row.MediaPath,
				Width:      row.Width,
				Height:     row.Height,
				Variants:   variantsResponse(row.Variants),
				FocalPoint: focalPointFrom(row.FocalX, row.FocalY),
			}
		}
		if len(media) > 0 {
			doc["media"] = media
		}
	}
}
