package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/sqlc-dev/pqtype"
)

// ErrGlobalStylesChanged: the draft's revision moved between the publish's checks and
// its transaction (another admin saved). Nothing was written; the caller answers 409
// styles_changed, as a stale save does.
var ErrGlobalStylesChanged = errors.New("global styles draft changed")

// ErrSiteDesignChanged: a template or part of the theme changed between the publish's
// flush and validation and its transaction (a store, a reset, a new or deleted row).
// Nothing was written; the caller answers 409 design_changed and the admin publishes
// again, which flushes and validates what is there now.
var ErrSiteDesignChanged = errors.New("site design changed")

// SiteTemplateStamp is what the publish validated of one template or part row: if any of
// it differs under the transaction's lock, ErrSiteDesignChanged.
type SiteTemplateStamp struct {
	ID                 int64
	BlockRevision      int64
	WorkingState       string
	PublishedVersionID sql.NullInt64
}

// StampOf is a row's stamp.
func StampOf(row SiteTemplate) SiteTemplateStamp {
	return SiteTemplateStamp{ID: row.ID, BlockRevision: row.BlockRevision, WorkingState: row.WorkingState, PublishedVersionID: row.PublishedVersionID}
}

type PublishSiteDesignTxParams struct {
	ThemeSlug   string
	PublishedBy sql.NullInt64
	// Summary is the release's summary: slugs, group names and counts, never values.
	Summary json.RawMessage

	// Styles publishes the global styles draft at this revision; nil when the styles
	// have no unpublished changes.
	StylesDraftRevision *int64

	// Rows are the stamps of every row of the theme the caller flushed and validated
	// against: a row added, deleted or changed since is ErrSiteDesignChanged, because
	// the part resolution (design 4.2) counted all of them.
	Rows []SiteTemplateStamp
	// Publish are the ids of the rows this release publishes (each in Rows): a "custom"
	// row's working copy becomes its published copy, a "reset" row's published copy
	// becomes NULL (section 9). Each gets a version under the release.
	Publish []int64

	// PublishedTemplate runs inside the transaction after each row's published copy is
	// written (the row as it now is). It's the hook for what follows the published copy
	// (#496 syncs site_template_media's published rows here, design 8.2). Nil: nothing.
	// It must not wait on anything but this transaction's queries.
	PublishedTemplate func(ctx context.Context, q *Queries, row SiteTemplate) error
}

// PublishedSiteTemplate is one item a release published.
type PublishedSiteTemplate struct {
	Template SiteTemplate
	Version  SiteTemplateVersion
}

type PublishSiteDesignTxResult struct {
	Release SiteDesignRelease
	// StylesVersion and Styles are set when the release published the styles.
	StylesVersion *GlobalStyleVersion
	Styles        *GlobalStyle
	Templates     []PublishedSiteTemplate
}

// PublishSiteDesignTx is "Publish site design" step 2 (design 8.2): lock the theme's rows
// (the styles row, then every template and part in id order), check that nothing the
// caller validated moved, insert the release, write each changed item's version and
// published copy (a reset publishes NULL) and the styles', and commit. The flush, the
// validation, the purge and the activity are the caller's, outside: nothing in here waits
// on a network call (plugin-system 7.3).
func (store *SQLStore) PublishSiteDesignTx(ctx context.Context, arg PublishSiteDesignTxParams) (PublishSiteDesignTxResult, error) {
	var result PublishSiteDesignTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		result = PublishSiteDesignTxResult{}
		var styles GlobalStyle
		if arg.StylesDraftRevision != nil {
			row, err := q.GetGlobalStylesForUpdate(ctx, arg.ThemeSlug)
			if err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return ErrGlobalStylesChanged
				}
				return err
			}
			if row.DraftRevision != *arg.StylesDraftRevision {
				return ErrGlobalStylesChanged
			}
			styles = row
		}

		rows, err := q.LockSiteTemplatesByTheme(ctx, arg.ThemeSlug)
		if err != nil {
			return err
		}
		if len(rows) != len(arg.Rows) {
			return ErrSiteDesignChanged
		}
		expected := make(map[int64]SiteTemplateStamp, len(arg.Rows))
		for _, stamp := range arg.Rows {
			expected[stamp.ID] = stamp
		}
		byID := make(map[int64]SiteTemplate, len(rows))
		for _, row := range rows {
			if stamp, ok := expected[row.ID]; !ok || stamp != StampOf(row) {
				return ErrSiteDesignChanged
			}
			byID[row.ID] = row
		}
		for _, id := range arg.Publish {
			if _, ok := byID[id]; !ok {
				return ErrSiteDesignChanged
			}
		}
		if arg.StylesDraftRevision == nil && len(arg.Publish) == 0 {
			return errors.New("publish site design: nothing to publish")
		}

		release, err := q.CreateSiteDesignRelease(ctx, CreateSiteDesignReleaseParams{
			ThemeSlug:   arg.ThemeSlug,
			PublishedBy: arg.PublishedBy,
			Summary:     arg.Summary,
		})
		if err != nil {
			return err
		}
		result.Release = release

		for _, id := range arg.Publish {
			row := byID[id]
			// The working copy the caller validated (its revision is checked above), or
			// NULL for a reset: the theme's default renders again.
			var doc pqtype.NullRawMessage
			if row.WorkingState != "reset" {
				doc = pqtype.NullRawMessage{RawMessage: row.BlockDoc, Valid: true}
			}
			versionNo, err := q.NextSiteTemplateVersionNo(ctx, row.ID)
			if err != nil {
				return err
			}
			version, err := q.CreateSiteTemplateVersion(ctx, CreateSiteTemplateVersionParams{
				TemplateID: row.ID,
				ReleaseID:  release.ID,
				VersionNo:  versionNo,
				BlockDoc:   doc,
			})
			if err != nil {
				return err
			}
			published, err := q.SetSiteTemplatePublished(ctx, SetSiteTemplatePublishedParams{
				PublishedBlockDoc:  doc,
				PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
				ID:                 row.ID,
			})
			if err != nil {
				return err
			}
			if arg.PublishedTemplate != nil {
				if err := arg.PublishedTemplate(ctx, q, published); err != nil {
					return err
				}
			}
			result.Templates = append(result.Templates, PublishedSiteTemplate{Template: published, Version: version})
		}

		if arg.StylesDraftRevision != nil {
			versionNo, err := q.NextGlobalStyleVersionNo(ctx, arg.ThemeSlug)
			if err != nil {
				return err
			}
			version, err := q.CreateGlobalStyleVersion(ctx, CreateGlobalStyleVersionParams{
				ThemeSlug: arg.ThemeSlug,
				ReleaseID: release.ID,
				VersionNo: versionNo,
				Styles:    styles.Draft,
			})
			if err != nil {
				return err
			}
			published, err := q.SetPublishedGlobalStyles(ctx, SetPublishedGlobalStylesParams{
				Published:          styles.Draft,
				PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
				ThemeSlug:          arg.ThemeSlug,
			})
			if err != nil {
				return err
			}
			result.StylesVersion = &version
			result.Styles = &published
		}
		return nil
	})
	return result, err
}
