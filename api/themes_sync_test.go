package api

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// writeTheme creates a theme directory under root with the given config and,
// when withLayouts is set, the layouts ScanThemesDirectory requires.
func writeTheme(t *testing.T, root, slug, config string, withLayouts bool) {
	t.Helper()
	dir := filepath.Join(root, slug)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	if config != "" {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "theme.config.ts"), []byte(config), 0o644))
	}
	if withLayouts {
		for _, kind := range []string{"post", "page"} {
			layoutDir := filepath.Join(dir, "layouts", kind)
			require.NoError(t, os.MkdirAll(layoutDir, 0o755))
			require.NoError(t, os.WriteFile(filepath.Join(layoutDir, "default.astro"), []byte("---\n---\n"), 0o644))
		}
	}
}

func TestScanThemesDirectory(t *testing.T) {
	root := t.TempDir()

	writeTheme(t, root, "complete", `export default {
  name: "Complete Theme",
  description: 'Has everything',
  version: "2.1.0",
  author: "Someone",
  layouts: { post: { default: "default" } },
  postTypes: [
    { name: "recipe", label: "Recipes", supports: ["title", "content"] },
  ],
}`, true)
	writeTheme(t, root, "bare", `export default {}`, true)
	writeTheme(t, root, "no-layouts", `export default { name: "Broken" }`, false)
	writeTheme(t, root, "no-config", "", true)
	writeTheme(t, root, ".hidden", `export default { name: "Hidden" }`, true)
	writeTheme(t, root, "system-theme", `export default { name: "System" }`, true)
	require.NoError(t, os.WriteFile(filepath.Join(root, "README.md"), []byte("not a theme"), 0o644))

	themes, err := ScanThemesDirectory(root)
	require.NoError(t, err)

	bySlug := map[string]DiscoveredTheme{}
	for _, th := range themes {
		bySlug[th.Slug] = th
	}
	require.Len(t, bySlug, 2, "only complete themes with config and layouts are discovered")

	complete := bySlug["complete"]
	require.Equal(t, "Complete Theme", complete.Name)
	require.Equal(t, "Has everything", complete.Description)
	require.Equal(t, "2.1.0", complete.Version)
	require.Equal(t, "Someone", complete.Author)
	require.Contains(t, complete.Config, "layouts")
	require.Equal(t, filepath.Join(root, "complete"), complete.Path)
	require.Len(t, complete.PostTypes, 1)
	require.Equal(t, "recipe", complete.PostTypes[0].Name)

	// Missing fields fall back to the directory name and 1.0.0.
	bare := bySlug["bare"]
	require.Equal(t, "bare", bare.Name)
	require.Equal(t, "1.0.0", bare.Version)
	require.Nil(t, bare.Config)
	require.Empty(t, bare.PostTypes)

	_, err = ScanThemesDirectory(filepath.Join(root, "does-not-exist"))
	require.Error(t, err)
}

// TestSyncThemesToDatabase checks the startup sync: themes gone from disk are
// removed unless active, new themes start inactive, existing ones keep their
// active flag, and theme post types are only enabled for the active theme.
func TestSyncThemesToDatabase(t *testing.T) {
	activeOnDisk := db.Theme{ID: 1, Slug: "active-on-disk", Name: "Active", Active: true}
	activeGone := db.Theme{ID: 2, Slug: "active-gone", Name: "Active but deleted", Active: true}
	inactiveGone := db.Theme{ID: 3, Slug: "inactive-gone", Name: "Orphan"}

	discovered := []DiscoveredTheme{
		{
			Slug: activeOnDisk.Slug, Name: "Active (renamed)", Version: "",
			PostTypes: []DiscoveredPostType{{Name: "recipe", Label: "Recipes", Supports: []string{"title"}, MenuPosition: 5}},
		},
		{
			Slug: "brand-new", Name: "Brand New", Version: "3.0.0", Description: "fresh",
			PostTypes: []DiscoveredPostType{{Name: "event", Label: "Events", Supports: []string{"title"}}},
		},
	}
	brandNew := db.Theme{ID: 4, Slug: "brand-new", Name: "Brand New"}

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)

	store.EXPECT().ListThemes(gomock.Any()).Times(1).Return([]db.Theme{activeOnDisk, activeGone, inactiveGone}, nil)
	store.EXPECT().DeleteTheme(gomock.Any(), gomock.Eq(inactiveGone.ID)).Times(1).Return(nil)
	store.EXPECT().DeleteTheme(gomock.Any(), gomock.Eq(activeGone.ID)).Times(0)
	store.EXPECT().DeleteTheme(gomock.Any(), gomock.Eq(activeOnDisk.ID)).Times(0)

	// Existing theme: metadata updated (no Active field to touch), version defaulted.
	store.EXPECT().GetThemeBySlug(gomock.Any(), gomock.Eq(activeOnDisk.Slug)).Times(2).Return(activeOnDisk, nil)
	store.EXPECT().
		UpdateTheme(gomock.Any(), gomock.Any()).
		Times(1).
		DoAndReturn(func(_ any, arg db.UpdateThemeParams) (db.Theme, error) {
			require.Equal(t, activeOnDisk.ID, arg.ID)
			require.Equal(t, "Active (renamed)", arg.Name.String)
			require.Equal(t, "1.0.0", arg.Version.String)
			return activeOnDisk, nil
		})

	// New theme: created inactive.
	gomock.InOrder(
		store.EXPECT().GetThemeBySlug(gomock.Any(), gomock.Eq("brand-new")).Times(1).Return(db.Theme{}, sql.ErrNoRows),
		store.EXPECT().GetThemeBySlug(gomock.Any(), gomock.Eq("brand-new")).Times(1).Return(brandNew, nil),
	)
	store.EXPECT().
		CreateTheme(gomock.Any(), gomock.Any()).
		Times(1).
		DoAndReturn(func(_ any, arg db.CreateThemeParams) (db.Theme, error) {
			require.Equal(t, "brand-new", arg.Slug)
			require.False(t, arg.Active)
			require.Equal(t, "3.0.0", arg.Version)
			require.Equal(t, "fresh", arg.Description.String)
			return brandNew, nil
		})

	store.EXPECT().
		UpsertPostType(gomock.Any(), gomock.Any()).
		Times(2).
		DoAndReturn(func(_ any, arg db.UpsertPostTypeParams) (db.PostType, error) {
			switch arg.Name {
			case "recipe":
				require.True(t, arg.IsActive, "post types of the active theme are enabled")
				require.Equal(t, "theme:active-on-disk", arg.RegisteredBy)
				require.Equal(t, sql.NullInt32{Int32: 5, Valid: true}, arg.MenuPosition)
			case "event":
				require.False(t, arg.IsActive, "post types of an inactive theme stay disabled")
				require.Equal(t, "theme:brand-new", arg.RegisteredBy)
				require.False(t, arg.MenuPosition.Valid)
			default:
				t.Fatalf("unexpected post type %q", arg.Name)
			}
			return db.PostType{Name: arg.Name}, nil
		})

	server := newTestServer(t, store)
	require.NoError(t, server.SyncThemesToDatabase(discovered))
}

// A failing theme listing must not stop the rest of the sync (startup keeps going).
func TestSyncThemesToDatabaseListFailure(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)

	store.EXPECT().ListThemes(gomock.Any()).Times(1).Return(nil, errors.New("db down"))
	store.EXPECT().DeleteTheme(gomock.Any(), gomock.Any()).Times(0)
	store.EXPECT().GetThemeBySlug(gomock.Any(), gomock.Eq("solo")).Times(2).Return(db.Theme{}, sql.ErrNoRows)
	store.EXPECT().CreateTheme(gomock.Any(), gomock.Any()).Times(1).Return(db.Theme{}, errors.New("still down"))

	server := newTestServer(t, store)
	require.NoError(t, server.SyncThemesToDatabase([]DiscoveredTheme{{Slug: "solo", Name: "Solo"}}))
}

func TestGetPostTypeAPI(t *testing.T) {
	postType := db.PostType{ID: 9, Name: "recipe", Label: "Recipes", Supports: []byte(`["title"]`)}

	testCases := []struct {
		name       string
		buildStubs func(store *mockdb.MockStore)
		wantCode   int
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostType(gomock.Any(), gomock.Eq("recipe")).Times(1).Return(postType, nil)
			},
			wantCode: http.StatusOK,
		},
		{
			name: "NotFound",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostType(gomock.Any(), gomock.Eq("recipe")).Times(1).Return(db.PostType{}, sql.ErrNoRows)
			},
			wantCode: http.StatusNotFound,
		},
		{
			name: "InternalError",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetPostType(gomock.Any(), gomock.Eq("recipe")).Times(1).Return(db.PostType{}, sql.ErrConnDone)
			},
			wantCode: http.StatusInternalServerError,
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			request, err := http.NewRequest(http.MethodGet, "/api/v1/post-types/recipe", nil)
			require.NoError(t, err)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)

			require.Equal(t, tc.wantCode, recorder.Code, recorder.Body.String())
			if tc.wantCode == http.StatusOK {
				require.Contains(t, recorder.Body.String(), `"name":"recipe"`)
				require.Contains(t, recorder.Body.String(), `"label":"Recipes"`)
			}
		})
	}
}
