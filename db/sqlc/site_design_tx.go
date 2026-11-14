package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// ErrGlobalStylesChanged: the draft's revision moved between the publish's checks and
// its transaction (another admin saved). Nothing was written; the caller answers 409
// styles_changed, as a stale save does.
var ErrGlobalStylesChanged = errors.New("global styles draft changed")

type PublishGlobalStylesTxParams struct {
	ThemeSlug string
	// DraftRevision is the revision the caller validated and checked for contrast.
	DraftRevision int64
	PublishedBy   sql.NullInt64
	// Summary is the release's summary: group names and counts, never values.
	Summary json.RawMessage
}

type PublishGlobalStylesTxResult struct {
	Release SiteDesignRelease
	Version GlobalStyleVersion
	Styles  GlobalStyle
}

// PublishGlobalStylesTx is the styles part of "Publish site design" (design 8.2, step 2):
// lock the theme's row, insert the release, write the draft as the next version and as
// the published styles, and commit. Nothing else runs inside (the purge and the activity
// come after commit). #492 adds the templates and parts of the same release here.
func (store *SQLStore) PublishGlobalStylesTx(ctx context.Context, arg PublishGlobalStylesTxParams) (PublishGlobalStylesTxResult, error) {
	var result PublishGlobalStylesTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		row, err := q.GetGlobalStylesForUpdate(ctx, arg.ThemeSlug)
		if err != nil {
			return err
		}
		if row.DraftRevision != arg.DraftRevision {
			return ErrGlobalStylesChanged
		}
		release, err := q.CreateSiteDesignRelease(ctx, CreateSiteDesignReleaseParams{
			ThemeSlug:   arg.ThemeSlug,
			PublishedBy: arg.PublishedBy,
			Summary:     arg.Summary,
		})
		if err != nil {
			return err
		}
		versionNo, err := q.NextGlobalStyleVersionNo(ctx, arg.ThemeSlug)
		if err != nil {
			return err
		}
		version, err := q.CreateGlobalStyleVersion(ctx, CreateGlobalStyleVersionParams{
			ThemeSlug: arg.ThemeSlug,
			ReleaseID: release.ID,
			VersionNo: versionNo,
			Styles:    row.Draft,
		})
		if err != nil {
			return err
		}
		styles, err := q.SetPublishedGlobalStyles(ctx, SetPublishedGlobalStylesParams{
			Published:          row.Draft,
			PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
			ThemeSlug:          arg.ThemeSlug,
		})
		if err != nil {
			return err
		}
		result = PublishGlobalStylesTxResult{Release: release, Version: version, Styles: styles}
		return nil
	})
	return result, err
}
