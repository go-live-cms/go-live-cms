package db

import (
	"context"
	"database/sql"
	"testing"

	"github.com/stretchr/testify/require"
)

// The settings row is a singleton shared by every run: restore it afterwards.
func TestUpdateSiteSettings(t *testing.T) {
	ctx := context.Background()
	before, err := testQueries.GetSettings(ctx)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := testQueries.UpdateSettings(ctx, UpdateSettingsParams{
			SiteTagline:             sql.NullString{String: before.SiteTagline, Valid: true},
			SiteLanguage:            sql.NullString{String: before.SiteLanguage, Valid: true},
			SiteTimezone:            sql.NullString{String: before.SiteTimezone, Valid: true},
			DateFormat:              sql.NullString{String: before.DateFormat, Valid: true},
			EditorMarkdownShortcuts: sql.NullBool{Bool: before.EditorMarkdownShortcuts, Valid: true},
			EditorAllowedEmbeds:     append([]string{}, before.EditorAllowedEmbeds...),
		})
		require.NoError(t, err)
	})

	updated, err := testQueries.UpdateSettings(ctx, UpdateSettingsParams{
		SiteTagline:             sql.NullString{String: "Notes from the team", Valid: true},
		SiteLanguage:            sql.NullString{String: "pt-BR", Valid: true},
		SiteTimezone:            sql.NullString{String: "America/Sao_Paulo", Valid: true},
		DateFormat:              sql.NullString{String: "iso", Valid: true},
		EditorMarkdownShortcuts: sql.NullBool{Bool: false, Valid: true},
		EditorAllowedEmbeds:     []string{"youtube", "codepen"},
	})
	require.NoError(t, err)
	require.Equal(t, "Notes from the team", updated.SiteTagline)
	require.Equal(t, "pt-BR", updated.SiteLanguage)
	require.Equal(t, "America/Sao_Paulo", updated.SiteTimezone)
	require.Equal(t, "iso", updated.DateFormat)
	require.False(t, updated.EditorMarkdownShortcuts)
	require.Equal(t, []string{"youtube", "codepen"}, updated.EditorAllowedEmbeds)

	// Nothing given keeps every field, the embed list included (a nil slice is NULL).
	kept, err := testQueries.UpdateSettings(ctx, UpdateSettingsParams{})
	require.NoError(t, err)
	require.Equal(t, updated.SiteTagline, kept.SiteTagline)
	require.False(t, kept.EditorMarkdownShortcuts)
	require.Equal(t, []string{"youtube", "codepen"}, kept.EditorAllowedEmbeds)

	// An empty list clears it.
	cleared, err := testQueries.UpdateSettings(ctx, UpdateSettingsParams{EditorAllowedEmbeds: []string{}})
	require.NoError(t, err)
	require.Empty(t, cleared.EditorAllowedEmbeds)

	// The date presets are a CHECK too.
	_, err = testQueries.UpdateSettings(ctx, UpdateSettingsParams{DateFormat: sql.NullString{String: "yyyy", Valid: true}})
	require.Error(t, err)
}
