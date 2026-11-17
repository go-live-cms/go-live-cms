package db

import "context"

// SiteTemplateMediaParams is SyncSiteTemplateMedia's argument for one copy of template
// templateID (site_template_media, #496): published false for the working copy, true for
// the published one, synced to uses (a doc's media blocks, ContentMediaUse as for posts).
// No uses removes that copy's rows: a reset publish (a NULL published copy) or a doc that
// dropped its last image.
func SiteTemplateMediaParams(templateID int64, published bool, uses []ContentMediaUse) SyncSiteTemplateMediaParams {
	arg := SyncSiteTemplateMediaParams{
		TemplateID: templateID,
		Published:  published,
		MediaIds:   make([]int64, len(uses)),
		BlockIds:   make([]string, len(uses)),
		BlockTypes: make([]string, len(uses)),
	}
	for i, use := range uses {
		arg.MediaIds[i] = use.MediaID
		arg.BlockIds[i] = use.BlockID
		arg.BlockTypes[i] = use.BlockType
	}
	return arg
}

// SyncSiteTemplateContentMedia syncs one copy's "Used in" rows inside a transaction (the
// collab store, the publish's hook). See SiteTemplateMediaParams.
func SyncSiteTemplateContentMedia(ctx context.Context, q *Queries, templateID int64, published bool, uses []ContentMediaUse) error {
	return q.SyncSiteTemplateMedia(ctx, SiteTemplateMediaParams(templateID, published, uses))
}
