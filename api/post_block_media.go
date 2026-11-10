// post_block_media.go attaches what the public renderer needs about the
// images in a published block doc (#255): each image block stores only its
// mediaId and src, so the variants (for srcset), the intrinsic size, the
// focal point (for object-position) and decorative (alt="", #325) are looked
// up when the doc is served and
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
//
// The video, audio and file blocks (#423) are in it too: they store only the media id,
// and the renderer takes the file's URL (`media_path`, always under /uploads), type,
// size and name from here. Ids that no longer exist (the media was deleted) are listed
// in "media_missing", so the renderer can leave those blocks out: that is not the same
// as a failed lookup, after which there is neither, and images render from their src.
package api

import (
	"context"
	"encoding/json"
	"sort"
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
	// Decorative (#325): the renderer outputs alt="" whatever the block's alt
	// says, so marking an image decorative applies without republishing.
	Decorative bool `json:"decorative,omitempty"`

	// For a video, audio or file block (#423) only, so an image's entry stays as it
	// was: the type and size for the file's "PDF · 240 KB", its name (the label's
	// default and the players' accessible name) and the uploaded file's name, which a
	// download is saved as (the stored name is random, #399).
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
	Name     string `json:"name,omitempty"`
	Filename string `json:"filename,omitempty"`
}

// mediaBlockTypes are the core block types that show a media item by `attrs.mediaId`
// (Block Spec `MEDIA_BLOCK_TYPES`): each is in post_media (#176, "Used in") and in the
// public `media` map. The image's entry has its variants; the others' their file info.
var mediaBlockTypes = map[string]bool{"image": true, "video": true, "audio": true, "file": true, "cover": true, "media_text": true}

// imageBlockTypes are the media blocks showing an image (#427: a cover's and media & text's
// too): their entries carry the variants, the others the file info.
var imageBlockTypes = map[string]bool{"image": true, "cover": true, "media_text": true}

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

// blockDocMediaIDs returns the mediaIds of the doc's media blocks (image, video, audio,
// file, cover, media & text), at any depth (the flat map).
func blockDocMediaIDs(doc map[string]interface{}) []int64 {
	ids, _ := blockDocMediaRefs(doc)
	return ids
}

// blockDocMediaRefs returns the mediaIds of the doc's media blocks, and which of them a
// video, audio or file block shows (their entries carry the file info).
func blockDocMediaRefs(doc map[string]interface{}) ([]int64, map[int64]bool) {
	blocks, _ := doc["blocks"].(map[string]interface{})
	var ids []int64
	fileInfo := map[int64]bool{}
	for _, raw := range blocks {
		block, _ := raw.(map[string]interface{})
		blockType := stringOf(block["type"])
		if block == nil || !mediaBlockTypes[blockType] {
			continue
		}
		attrs, _ := block["attrs"].(map[string]interface{})
		if id, ok := blockMediaID(attrs["mediaId"]); ok {
			ids = append(ids, id)
			if !imageBlockTypes[blockType] {
				fileInfo[id] = true
			}
		}
	}
	return ids, fileInfo
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

// attachBlockMedia adds the "media" map to each doc that has media blocks, with one
// query for all of them, and "media_missing" (sorted ids) for the ones that don't exist
// any more. Best effort: on a lookup error the docs are served without either, and
// images render from their src alone.
func (server *Server) attachBlockMedia(ctx context.Context, docs ...map[string]interface{}) {
	perDoc := make([][]int64, len(docs))
	fileInfo := map[int64]bool{}
	seen := map[int64]bool{}
	var ids []int64
	for i, doc := range docs {
		if doc == nil {
			continue
		}
		var info map[int64]bool
		perDoc[i], info = blockDocMediaRefs(doc)
		for id := range info {
			fileInfo[id] = true
		}
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
		missing := map[int64]bool{}
		for _, id := range perDoc[i] {
			row, ok := byID[id]
			if !ok {
				missing[id] = true
				continue
			}
			entry := BlockMedia{
				MediaPath:  publicMediaPath(server.config.UploadPath, row.MediaPath),
				Width:      row.Width,
				Height:     row.Height,
				Variants:   publicVariants(server.config.UploadPath, resizedOnly(variantsResponse(row.Variants))),
				FocalPoint: focalPointFrom(row.FocalX, row.FocalY),
				Decorative: row.Decorative,
			}
			if fileInfo[id] {
				entry.MimeType = row.MimeType
				entry.FileSize = row.FileSize
				entry.Name = row.Name
				entry.Filename = row.OriginalFilename
			}
			media[strconv.FormatInt(id, 10)] = entry
		}
		if len(media) > 0 {
			doc["media"] = media
		}
		if len(missing) > 0 {
			ids := make([]int64, 0, len(missing))
			for id := range missing {
				ids = append(ids, id)
			}
			sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
			doc["media_missing"] = ids
		}
	}
}
