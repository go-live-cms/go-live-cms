package api

import "encoding/json"

// SaveGlobalStylesRequest is PUT /site-design/global-styles: the whole draft (design 6.5,
// the form saves as you go) and the revision it was based on. A stale base_revision is
// 409 styles_changed with the current draft.
type SaveGlobalStylesRequest struct {
	Styles       json.RawMessage `json:"styles" binding:"required"`
	BaseRevision *int64          `json:"base_revision" binding:"required,min=0"`
}

// PublishSiteDesignRequest is POST /site-design/publish (design 8.2). ConfirmContrast is
// the publish dialog's "Publish anyway": without it, failing contrast pairs make the
// publish answer 409 contrast_unconfirmed, naming them. It never refuses them.
type PublishSiteDesignRequest struct {
	ConfirmContrast bool `json:"confirm_contrast"`
}

// maxGlobalStylesBytes caps a draft: every declared token of the default theme in both
// palettes is about 4 KiB.
const maxGlobalStylesBytes = 64 << 10
