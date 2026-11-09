package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// #41 through the real router and queries (skipped without a test database): nobody finds
// a title they couldn't open.

func paletteSearch(t *testing.T, server *Server, caller db.User, query string) (CommandPaletteResponse, string) {
	t.Helper()
	rec := as(t, server, caller, http.MethodGet, "/api/v1/search?q="+query, nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got CommandPaletteResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	return got, rec.Body.String()
}

func TestCommandPalette_ResultsFollowPermissions(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	ctx := context.Background()

	admin := scheduleUser(t, store, RoleAdmin)
	editor := scheduleUser(t, store, RoleEditor)
	owner := scheduleUser(t, store, RoleContributor)
	viewer := scheduleUser(t, store, RoleContributor)

	word := scheduleWord()
	ownDraft := scheduleDraft(t, store, viewer, word)
	othersDraft := scheduleDraft(t, store, owner, word)
	live := publishForTest(t, store, scheduleDraft(t, store, owner, word), editor)
	trashed := scheduleDraft(t, store, viewer, word)
	_, err := conn.Exec(`UPDATE posts SET trashed_from_status = post_status, post_status = 'trash', deleted_at = now() WHERE id = $1`, trashed.ID)
	require.NoError(t, err)
	page := scheduleDraft(t, store, owner, word)
	_, err = conn.Exec(`UPDATE posts SET post_type = 'page' WHERE id = $1`, page.ID)
	require.NoError(t, err)

	_, err = conn.Exec(`UPDATE users SET full_name = $1 WHERE id = $2`, "Member "+word, viewer.ID)
	require.NoError(t, err)
	// Found only by email: the row wouldn't show why, so the palette doesn't list them.
	_, err = conn.Exec(`UPDATE users SET email = $1 WHERE id = $2`, word+"@example.test", editor.ID)
	require.NoError(t, err)

	var media db.Medium
	require.NoError(t, conn.QueryRowContext(ctx,
		`INSERT INTO media (name, description, alt, media_path, user_id) VALUES ($1, '', '', '/app/uploads/media/x.png', $2) RETURNING id`,
		"chart-"+word, owner.ID).Scan(&media.ID))

	var shown, hidden int64
	require.NoError(t, conn.QueryRowContext(ctx,
		`INSERT INTO taxonomy_terms (name, slug, taxonomy_type_id)
		 SELECT $1, $2, id FROM taxonomy_types WHERE name = 'category' RETURNING id`, "Term "+word, "term-"+word).Scan(&shown))
	var hiddenType int64
	require.NoError(t, conn.QueryRowContext(ctx,
		`INSERT INTO taxonomy_types (name, label, show_ui) VALUES ($1, 'Internal', false) RETURNING id`, "internal_"+word).Scan(&hiddenType))
	t.Cleanup(func() { _, _ = conn.Exec(`DELETE FROM taxonomy_types WHERE id = $1`, hiddenType) })
	require.NoError(t, conn.QueryRowContext(ctx,
		`INSERT INTO taxonomy_terms (name, slug, taxonomy_type_id) VALUES ($1, $2, $3) RETURNING id`, "Hidden "+word, "hidden-"+word, hiddenType).Scan(&hidden))

	ids := func(rows []CommandPalettePost) map[int64]bool {
		out := map[int64]bool{}
		for _, row := range rows {
			out[row.ID] = true
		}
		return out
	}

	// The contributor: their own draft and the published post; nobody's trash; the page
	// someone else is drafting stays out.
	got, _ := paletteSearch(t, server, viewer, word)
	require.Equal(t, map[int64]bool{ownDraft.ID: true, live.ID: true}, ids(got.Posts))
	require.Empty(t, got.Pages)
	require.Len(t, got.Media, 1)
	require.Equal(t, media.ID, got.Media[0].ID)
	require.Len(t, got.Terms, 1)
	require.Equal(t, shown, got.Terms[0].ID)
	require.Equal(t, "category", got.Terms[0].TaxonomyType)
	require.Nil(t, got.Users, "only admins list members")

	// An editor: every post but the trash, still no members.
	got, _ = paletteSearch(t, server, editor, word)
	require.Equal(t, map[int64]bool{ownDraft.ID: true, othersDraft.ID: true, live.ID: true}, ids(got.Posts))
	require.Equal(t, map[int64]bool{page.ID: true}, ids(got.Pages))
	require.Nil(t, got.Users)

	// An admin: members too, public fields only.
	got, raw := paletteSearch(t, server, admin, word)
	require.Len(t, got.Users, 1)
	require.Equal(t, viewer.ID, got.Users[0].ID)
	require.Equal(t, "Member "+word, got.Users[0].FullName)
	require.NotContains(t, raw, viewer.Email)

	// What's inside a hidden taxonomy isn't offered to anyone.
	for _, term := range got.Terms {
		require.NotEqual(t, hidden, term.ID)
	}
}
