package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// createTestSiteTemplate makes a template of its own theme slug (unique per test run, the
// database is shared).
func createTestSiteTemplate(t *testing.T, kind, slug string) SiteTemplate {
	t.Helper()
	theme := "gl490-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	row, err := testQueries.CreateSiteTemplate(context.Background(), CreateSiteTemplateParams{
		ThemeSlug: theme,
		Kind:      kind,
		Slug:      slug,
		Title:     "Single post",
		BlockDoc:  json.RawMessage(`{}`),
		Source:    "blank",
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = testQueries.db.ExecContext(context.Background(), `DELETE FROM site_templates WHERE theme_slug = $1`, theme)
	})
	return row
}

// TestStoreSiteTemplateCollabTx covers the template-<id> store (#490, design 7.2), as
// TestStorePostCollabTx does a post's: block_doc and the Yjs state commit together, the
// revision counts up from 1, the state is recorded against the revision it produced, a
// write around the server makes the state stale (rule 12), a store behind is refused.
func TestStoreSiteTemplateCollabTx(t *testing.T) {
	ctx := context.Background()
	template := createTestSiteTemplate(t, "template", "single-case_study")
	editor := createTestUser(t)
	require.Equal(t, int64(1), template.BlockRevision, "a new row starts where a post does")
	require.Equal(t, "custom", template.WorkingState)
	require.False(t, template.PublishedBlockDoc.Valid)

	loaded, err := testQueries.GetSiteTemplateCollab(ctx, template.ID)
	require.NoError(t, err)
	require.Equal(t, "template", loaded.Kind)
	require.Nil(t, loaded.YdocState)
	require.False(t, loaded.YdocEpoch.Valid)

	// The seed: state only, against the revision it was seeded from.
	epoch := uuid.New()
	_, err = testStore.StoreSiteTemplateCollabTx(ctx, StoreSiteTemplateCollabTxParams{TemplateID: template.ID, State: []byte{1}, Epoch: epoch})
	require.ErrorIs(t, err, ErrCollabBaseRevisionRequired)
	result, err := testStore.StoreSiteTemplateCollabTx(ctx, StoreSiteTemplateCollabTxParams{
		TemplateID: template.ID, State: []byte{1}, Epoch: epoch, BaseRevision: sql.NullInt64{Int64: 1, Valid: true},
	})
	require.NoError(t, err)
	require.Equal(t, int64(1), result.BlockRevision)
	unchanged, err := testQueries.GetSiteTemplate(ctx, template.ID)
	require.NoError(t, err)
	require.Equal(t, template.ChangedAt, unchanged.ChangedAt, "a state-only store leaves changed_at alone")

	// An edit: block_doc, revision+1, the state at the new revision, one throttled event.
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{"type":"template_part","attrs":{"slug":"header"}}}}`)
	for i := 0; i < 2; i++ {
		result, err = testStore.StoreSiteTemplateCollabTx(ctx, StoreSiteTemplateCollabTxParams{
			TemplateID: template.ID, State: []byte{2, byte(i)}, Epoch: epoch, BlockDoc: doc,
			LastEditorID: sql.NullInt64{Int64: editor.ID, Valid: true}, EditActivityWindow: time.Hour,
		})
		require.NoError(t, err)
		require.Equal(t, int64(2+i), result.BlockRevision)
	}
	loaded, err = testQueries.GetSiteTemplateCollab(ctx, template.ID)
	require.NoError(t, err)
	require.Equal(t, int64(3), loaded.BlockRevision)
	require.Equal(t, []byte{2, 1}, loaded.YdocState)
	require.Equal(t, epoch, loaded.YdocEpoch.UUID)
	require.Equal(t, int64(3), loaded.YdocBlockRevision.Int64)
	require.JSONEq(t, string(doc), string(loaded.BlockDoc))
	var events int
	require.NoError(t, testQueries.db.QueryRowContext(ctx,
		`SELECT count(*) FROM activity WHERE verb = $1 AND object_type = $2 AND object_id = $3 AND actor_id = $4`,
		ActivitySiteTemplateEdited, ActivityObjectSiteDesign, template.ID, editor.ID).Scan(&events))
	require.Equal(t, 1, events, "throttled: one per editor and template per window")
	var lastEditor sql.NullInt64
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT last_editor_id FROM site_template_ydoc_state WHERE template_id = $1`, template.ID).Scan(&lastEditor))
	require.Equal(t, editor.ID, lastEditor.Int64)

	// block_doc written around the collab server (a restored backup): the state is now
	// behind its revision, which the load-time guard detects.
	_, err = testQueries.db.ExecContext(ctx, `UPDATE site_templates SET block_doc = '{}'::jsonb, block_revision = block_revision + 1 WHERE id = $1`, template.ID)
	require.NoError(t, err)
	loaded, err = testQueries.GetSiteTemplateCollab(ctx, template.ID)
	require.NoError(t, err)
	require.Equal(t, int64(4), loaded.BlockRevision)
	require.Equal(t, int64(3), loaded.YdocBlockRevision.Int64)

	// The server's store from before the write is behind: nothing is written.
	_, err = testStore.StoreSiteTemplateCollabTx(ctx, StoreSiteTemplateCollabTxParams{
		TemplateID: template.ID, State: []byte{9}, Epoch: epoch, BlockDoc: doc, BaseRevision: sql.NullInt64{Int64: 3, Valid: true},
	})
	require.ErrorIs(t, err, ErrCollabRevisionConflict)
	loaded, err = testQueries.GetSiteTemplateCollab(ctx, template.ID)
	require.NoError(t, err)
	require.Equal(t, []byte{2, 1}, loaded.YdocState)
	require.Equal(t, int64(4), loaded.BlockRevision)

	_, err = testStore.StoreSiteTemplateCollabTx(ctx, StoreSiteTemplateCollabTxParams{TemplateID: -1, State: []byte{1}, Epoch: epoch, BlockDoc: doc})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// TestSiteTemplatesSchema checks 000058's constraints (design 5.1): slugs with `_` store,
// one row per (theme, kind, slug), the CHECKs, and what deleting a template or a version
// takes with it.
func TestSiteTemplatesSchema(t *testing.T) {
	ctx := context.Background()
	template := createTestSiteTemplate(t, "template", "single-case_study")

	// The same slug as a part is another row; as a template again it's a conflict.
	_, err := testQueries.CreateSiteTemplate(ctx, CreateSiteTemplateParams{
		ThemeSlug: template.ThemeSlug, Kind: "part", Slug: template.Slug, Title: "Part", BlockDoc: json.RawMessage(`{}`), Source: "blank",
	})
	require.NoError(t, err)
	_, err = testQueries.CreateSiteTemplate(ctx, CreateSiteTemplateParams{
		ThemeSlug: template.ThemeSlug, Kind: "template", Slug: template.Slug, Title: "Again", BlockDoc: json.RawMessage(`{}`), Source: "blank",
	})
	require.True(t, IsUniqueViolation(err), "one row per theme, kind and slug: %v", err)
	found, err := testQueries.GetSiteTemplateBySlug(ctx, GetSiteTemplateBySlugParams{ThemeSlug: template.ThemeSlug, Kind: "template", Slug: template.Slug})
	require.NoError(t, err)
	require.Equal(t, template.ID, found.ID)

	for name, params := range map[string]CreateSiteTemplateParams{
		"upper-case slug":  {Kind: "template", Slug: "Single", Title: "x", Source: "blank"},
		"slug with a path": {Kind: "template", Slug: "../x", Title: "x", Source: "blank"},
		"slug too long":    {Kind: "template", Slug: strings.Repeat("a", 81), Title: "x", Source: "blank"},
		"unknown kind":     {Kind: "page", Slug: "x", Title: "x", Source: "blank"},
		"unknown source":   {Kind: "template", Slug: "y", Title: "x", Source: "web"},
		"blank title":      {Kind: "template", Slug: "z", Title: "  ", Source: "blank"},
		"block_doc array":  {Kind: "template", Slug: "w", Title: "x", Source: "blank", BlockDoc: json.RawMessage(`[]`)},
		"empty theme slug": {Kind: "template", Slug: "v", Title: "x", Source: "blank", ThemeSlug: "-"},
	} {
		if params.ThemeSlug == "-" {
			params.ThemeSlug = ""
		} else {
			params.ThemeSlug = template.ThemeSlug
		}
		if params.BlockDoc == nil {
			params.BlockDoc = json.RawMessage(`{}`)
		}
		_, err := testQueries.CreateSiteTemplate(ctx, params)
		require.Error(t, err, name)
	}
	_, err = testQueries.CreateSiteTemplate(ctx, CreateSiteTemplateParams{
		ThemeSlug: template.ThemeSlug, Kind: "template", Slug: "custom-" + strings.Repeat("a", 64), Title: "Landing", BlockDoc: json.RawMessage(`{}`), Source: "blank",
	})
	require.NoError(t, err, "custom-<64-character name> fits")

	// A version under a release; the published pointer goes NULL when the version goes.
	var releaseID, versionID int64
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `INSERT INTO site_design_releases (theme_slug) VALUES ($1) RETURNING id`, template.ThemeSlug).Scan(&releaseID))
	t.Cleanup(func() {
		_, _ = testQueries.db.ExecContext(context.Background(), `DELETE FROM site_design_releases WHERE id = $1`, releaseID)
	})
	require.NoError(t, testQueries.db.QueryRowContext(ctx,
		`INSERT INTO site_template_versions (template_id, release_id, version_no, block_doc) VALUES ($1, $2, 1, NULL) RETURNING id`,
		template.ID, releaseID).Scan(&versionID))
	_, err = testQueries.db.ExecContext(ctx, `INSERT INTO site_template_versions (template_id, release_id, version_no) VALUES ($1, $2, 1)`, template.ID, releaseID)
	require.Error(t, err, "version numbers are unique per template")
	_, err = testQueries.db.ExecContext(ctx, `UPDATE site_templates SET published_version_id = $2 WHERE id = $1`, template.ID, versionID)
	require.NoError(t, err)
	_, err = testQueries.db.ExecContext(ctx, `DELETE FROM site_template_versions WHERE id = $1`, versionID)
	require.NoError(t, err)
	reloaded, err := testQueries.GetSiteTemplate(ctx, template.ID)
	require.NoError(t, err)
	require.False(t, reloaded.PublishedVersionID.Valid)

	// Deleting a template takes its Yjs state and versions with it.
	_, err = testStore.StoreSiteTemplateCollabTx(ctx, StoreSiteTemplateCollabTxParams{
		TemplateID: template.ID, State: []byte{1}, Epoch: uuid.New(), BaseRevision: sql.NullInt64{Int64: 1, Valid: true},
	})
	require.NoError(t, err)
	_, err = testQueries.db.ExecContext(ctx, `INSERT INTO site_template_versions (template_id, release_id, version_no) VALUES ($1, $2, 2)`, template.ID, releaseID)
	require.NoError(t, err)
	_, err = testQueries.db.ExecContext(ctx, `DELETE FROM site_templates WHERE id = $1`, template.ID)
	require.NoError(t, err)
	var left int
	require.NoError(t, testQueries.db.QueryRowContext(ctx,
		`SELECT (SELECT count(*) FROM site_template_ydoc_state WHERE template_id = $1) + (SELECT count(*) FROM site_template_versions WHERE template_id = $1)`,
		template.ID).Scan(&left))
	require.Zero(t, left)
}
