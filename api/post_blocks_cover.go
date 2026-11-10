package api

import "math"

// Cover and media & text (#427, docs/design/block-library.md 2.2, 3.4, 4). Containers (the
// rows are in post_blocks_nesting.go) that show one media library image by `mediaId`. Each
// is an allowlist like a group's; a number is clamped, so a stored doc can't ask for an
// overlay the theme doesn't guarantee readable text for, and anything else invalid is
// dropped and the block renders with its default. The web's rules are
// `blocks-spec/coverMedia.ts`; `coverMediaVectors.json` is read by both sides' tests.

const (
	coverOverlayMin  = 0
	coverOverlayMax  = 80
	coverOverlayStep = 5
	// mediaAltMaxRunes is what the media library's own alt field takes (`max=255`).
	mediaAltMaxRunes = 255
)

// mediaTextPositions: where the media sits on wide screens (Block Spec `MEDIA_TEXT_POSITIONS`).
var mediaTextPositions = map[string]bool{"left": true, "right": true}

// sanitizeCoverAttrs (#427): `mediaId`, `alt`, `decorative`, `focal`, `overlay` and `align`
// only. No `src`: the public page takes the image's URL from the media library.
func sanitizeCoverAttrs(attrs map[string]interface{}) {
	keepOnlyAttrs(attrs, "mediaId", "alt", "decorative", "focal", "overlay", "align")
	sanitizeBlockImageAttrs(attrs)
	if raw, present := attrs["overlay"]; present {
		overlay, ok := raw.(float64)
		if !ok {
			delete(attrs, "overlay")
		} else {
			attrs["overlay"] = clampCoverOverlay(overlay)
		}
	}
	if s, ok := attrs["align"].(string); !ok || !groupAligns[s] {
		delete(attrs, "align")
	}
}

// sanitizeMediaTextAttrs (#427): `mediaId`, `alt`, `decorative`, `focal` and `position` only.
func sanitizeMediaTextAttrs(attrs map[string]interface{}) {
	keepOnlyAttrs(attrs, "mediaId", "alt", "decorative", "focal", "position")
	sanitizeBlockImageAttrs(attrs)
	if s, ok := attrs["position"].(string); !ok || !mediaTextPositions[s] {
		delete(attrs, "position")
	}
}

// sanitizeBlockImageAttrs: what both blocks hold about their image.
func sanitizeBlockImageAttrs(attrs map[string]interface{}) {
	sanitizeMediaID(attrs)
	sanitizePlainText(attrs, "alt", mediaAltMaxRunes)
	if raw, present := attrs["decorative"]; present {
		if _, ok := raw.(bool); !ok {
			delete(attrs, "decorative")
		}
	}
	if raw, present := attrs["focal"]; present {
		if focal, ok := clampFocal(raw); ok {
			attrs["focal"] = focal
		} else {
			delete(attrs, "focal")
		}
	}
}

// clampCoverOverlay clamps to 0..80 and snaps to the step of 5 (the web's `normalizeCoverOverlay`).
func clampCoverOverlay(value float64) float64 {
	clamped := math.Min(coverOverlayMax, math.Max(coverOverlayMin, value))
	return math.Round(clamped/coverOverlayStep) * coverOverlayStep
}

// clampFocal keeps a focal point with both axes numbers, each clamped to 0..100 and rounded
// to a whole percent (the web's `normalizeFocal`); anything else isn't one.
func clampFocal(raw interface{}) (map[string]interface{}, bool) {
	point, ok := raw.(map[string]interface{})
	if !ok {
		return nil, false
	}
	x, xok := point["x"].(float64)
	y, yok := point["y"].(float64)
	if !xok || !yok {
		return nil, false
	}
	clamp := func(value float64) float64 { return math.Round(math.Min(100, math.Max(0, value))) }
	return map[string]interface{}{"x": clamp(x), "y": clamp(y)}, true
}
