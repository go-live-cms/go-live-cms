package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

var (
	menuAdmin       = db.User{ID: 1, Username: "admin", Role: RoleAdmin}
	menuEditor      = db.User{ID: 2, Username: "editor", Role: RoleEditor}
	menuContributor = db.User{ID: 3, Username: "contributor", Role: RoleContributor}
)

func testMenu(location string) db.Menu {
	return db.Menu{ID: 7, Name: "Main", Location: sql.NullString{String: location, Valid: location != ""}, CreatedAt: time.Now(), ChangedAt: time.Now()}
}

// A published post, its child (a custom link) and an archive.
func postItemRow(id int64, slug, status string) db.ListMenuItemsWithTargetsRow {
	return db.ListMenuItemsWithTargetsRow{
		ID: id, MenuID: 7, ItemType: "post", PostID: sql.NullInt64{Int64: 42, Valid: true},
		PostTitle: sql.NullString{String: "About us", Valid: true}, PostSlug: sql.NullString{String: slug, Valid: true},
		PostPostType: sql.NullString{String: "page", Valid: true}, PostStatus: sql.NullString{String: status, Valid: true},
		PostTypePublic: sql.NullBool{Bool: true, Valid: true}, PostTypeActive: sql.NullBool{Bool: true, Valid: true},
	}
}

func customItemRow(id, parent int64, label, url string) db.ListMenuItemsWithTargetsRow {
	return db.ListMenuItemsWithTargetsRow{
		ID: id, MenuID: 7, ItemType: "custom", Label: label, Url: url,
		ParentID: sql.NullInt64{Int64: parent, Valid: parent != 0},
	}
}

type menuRequest struct {
	method string
	path   string
	body   any
	user   *db.User
}

func serveMenuRequest(t *testing.T, store *mockdb.MockStore, req menuRequest) *httptest.ResponseRecorder {
	t.Helper()
	server := newTestServer(t, store)
	var body bytes.Buffer
	if req.body != nil {
		require.NoError(t, json.NewEncoder(&body).Encode(req.body))
	}
	request, err := http.NewRequest(req.method, req.path, &body)
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	if req.user != nil {
		addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, req.user.ID, req.user.Username, time.Minute)
		stubRoleLookup(store, *req.user)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func decodeMenu(t *testing.T, recorder *httptest.ResponseRecorder) MenuResponse {
	t.Helper()
	var resp struct {
		Menu MenuResponse `json:"menu"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
	return resp.Menu
}

func TestMenuPermissions(t *testing.T) {
	routes := []menuRequest{
		{method: http.MethodGet, path: "/api/v1/menus"},
		{method: http.MethodPost, path: "/api/v1/menus", body: jsonBody{"name": "Main"}},
		{method: http.MethodGet, path: "/api/v1/menus/7"},
		{method: http.MethodPut, path: "/api/v1/menus/7", body: jsonBody{"name": "Main"}},
		{method: http.MethodPut, path: "/api/v1/menus/7/items", body: jsonBody{"items": []any{}}},
		{method: http.MethodDelete, path: "/api/v1/menus/7"},
	}
	for _, route := range routes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)

			// No token: 401. A contributor: 403, and nothing below the guard runs
			// (the mock fails on any other call).
			require.Equal(t, http.StatusUnauthorized, serveMenuRequest(t, store, route).Code)
			contributor := route
			contributor.user = &menuContributor
			require.Equal(t, http.StatusForbidden, serveMenuRequest(t, store, contributor).Code)
		})
	}
}

// jsonBody is a short map literal for request bodies.
type jsonBody = map[string]any

func TestMenuCRUD(t *testing.T) {
	t.Run("list as editor", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().ListMenus(gomock.Any()).Return([]db.ListMenusRow{{ID: 7, Name: "Main", Location: sql.NullString{String: "primary", Valid: true}, ItemCount: 3}}, nil)

		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodGet, path: "/api/v1/menus", user: &menuEditor})
		require.Equal(t, http.StatusOK, rec.Code)
		var resp struct{ Menus []MenuResponse }
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
		require.Len(t, resp.Menus, 1)
		require.Equal(t, "primary", resp.Menus[0].Location)
		require.Equal(t, int64(3), *resp.Menus[0].ItemCount)
	})

	t.Run("create with a location as editor", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().SaveMenuTx(gomock.Any(), db.SaveMenuTxParams{Name: "Main", Location: sql.NullString{String: "primary", Valid: true}}).
			Return(testMenu("primary"), nil)

		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPost, path: "/api/v1/menus", body: jsonBody{"name": "  Main ", "location": "primary"}, user: &menuEditor})
		require.Equal(t, http.StatusCreated, rec.Code)
		menu := decodeMenu(t, rec)
		require.Equal(t, int64(7), menu.ID)
		require.Equal(t, "primary", menu.Location)
	})

	t.Run("create rejects a blank name and a bad location", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		for _, body := range []jsonBody{{"name": "   "}, {"name": "Main", "location": "../primary"}, {"name": "Main", "extra": true}} {
			rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPost, path: "/api/v1/menus", body: body, user: &menuAdmin})
			require.Equal(t, http.StatusBadRequest, rec.Code, body)
		}
	})

	t.Run("create conflict", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().SaveMenuTx(gomock.Any(), gomock.Any()).Return(db.Menu{}, errors.New(`duplicate key value violates unique constraint "idx_menus_location"`))
		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPost, path: "/api/v1/menus", body: jsonBody{"name": "Main", "location": "primary"}, user: &menuAdmin})
		require.Equal(t, http.StatusConflict, rec.Code)
	})

	t.Run("get with items and statuses", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenu(gomock.Any(), int64(7)).Return(testMenu("primary"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{
			postItemRow(1, "about", "draft"),
			customItemRow(2, 1, "Team", "/team"),
		}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{PostUrlStructure: "slug"}, nil)

		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodGet, path: "/api/v1/menus/7", user: &menuEditor})
		require.Equal(t, http.StatusOK, rec.Code)
		menu := decodeMenu(t, rec)
		require.Len(t, menu.Items, 1)
		require.Equal(t, menuItemUnpublished, menu.Items[0].Status)
		require.Equal(t, "About us", menu.Items[0].Title)
		require.Equal(t, "/page/about", menu.Items[0].URL)
		require.Equal(t, int64(42), menu.Items[0].TargetID)
		require.Equal(t, "page", menu.Items[0].PostType)
		require.Len(t, menu.Items[0].Children, 1)
		require.Equal(t, "Team", menu.Items[0].Children[0].Title)
	})

	t.Run("get missing and invalid id", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenu(gomock.Any(), int64(8)).Return(db.Menu{}, sql.ErrNoRows)
		require.Equal(t, http.StatusNotFound, serveMenuRequest(t, store, menuRequest{method: http.MethodGet, path: "/api/v1/menus/8", user: &menuEditor}).Code)
		require.Equal(t, http.StatusBadRequest, serveMenuRequest(t, store, menuRequest{method: http.MethodGet, path: "/api/v1/menus/abc", user: &menuEditor}).Code)
	})

	t.Run("update moves the location", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().SaveMenuTx(gomock.Any(), db.SaveMenuTxParams{ID: 7, Name: "Footer links", Location: sql.NullString{String: "footer", Valid: true}}).
			Return(testMenu("footer"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{}, nil)

		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/7", body: jsonBody{"name": "Footer links", "location": "footer"}, user: &menuEditor})
		require.Equal(t, http.StatusOK, rec.Code)
		require.Equal(t, "footer", decodeMenu(t, rec).Location)
	})

	t.Run("rename without a location keeps it", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().SaveMenuTx(gomock.Any(), db.SaveMenuTxParams{ID: 7, Name: "Renamed", KeepLocation: true}).Return(testMenu("primary"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{}, nil)
		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/7", body: jsonBody{"name": "Renamed"}, user: &menuEditor})
		require.Equal(t, http.StatusOK, rec.Code)

		// An explicit "" unassigns it.
		store = mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().SaveMenuTx(gomock.Any(), db.SaveMenuTxParams{ID: 7, Name: "Main"}).Return(testMenu(""), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{}, nil)
		rec = serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/7", body: jsonBody{"name": "Main", "location": ""}, user: &menuEditor})
		require.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("update missing", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().SaveMenuTx(gomock.Any(), gomock.Any()).Return(db.Menu{}, sql.ErrNoRows)
		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/9", body: jsonBody{"name": "X"}, user: &menuEditor})
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("delete", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().DeleteMenu(gomock.Any(), int64(7)).Return(int64(1), nil)
		store.EXPECT().DeleteMenu(gomock.Any(), int64(8)).Return(int64(0), nil)
		require.Equal(t, http.StatusNoContent, serveMenuRequest(t, store, menuRequest{method: http.MethodDelete, path: "/api/v1/menus/7", user: &menuEditor}).Code)
		require.Equal(t, http.StatusNotFound, serveMenuRequest(t, store, menuRequest{method: http.MethodDelete, path: "/api/v1/menus/8", user: &menuEditor}).Code)
	})
}

func TestSaveMenuItems(t *testing.T) {
	t.Run("saves the tree in reading order", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().ReplaceMenuItemsTx(gomock.Any(), db.ReplaceMenuItemsTxParams{MenuID: 7, Items: []db.MenuItemInput{
			{ParentIndex: -1, ItemType: "post", PostID: sql.NullInt64{Int64: 42, Valid: true}},
			{ParentIndex: 0, ItemType: "custom", Label: "Team", Url: "/team"},
			{ParentIndex: -1, ItemType: "term", Label: "News", TermID: sql.NullInt64{Int64: 5, Valid: true}},
			{ParentIndex: -1, ItemType: "archive", PostType: sql.NullString{String: "post", Valid: true}},
			{ParentIndex: -1, ItemType: "custom", Label: "GitHub", Url: "https://github.com/go-live-cms"},
		}}).Return([]db.MenuItem{}, nil)
		store.EXPECT().GetMenu(gomock.Any(), int64(7)).Return(testMenu(""), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{}, nil)

		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/7/items", user: &menuEditor, body: jsonBody{"items": []jsonBody{
			{"type": "post", "target_id": 42, "children": []jsonBody{{"type": "custom", "label": "Team", "url": "/team"}}},
			{"type": "term", "target_id": 5, "label": " News "},
			{"type": "archive", "post_type": "post"},
			{"type": "custom", "label": "GitHub", "url": "https://github.com/go-live-cms"},
		}}})
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	})

	invalid := map[string]jsonBody{
		"javascript url":      {"type": "custom", "label": "x", "url": "javascript:alert(1)"},
		"JavaScript url":      {"type": "custom", "label": "x", "url": "JavaScript:alert(1)"},
		"data url":            {"type": "custom", "label": "x", "url": "data:text/html,hi"},
		"protocol relative":   {"type": "custom", "label": "x", "url": "//evil.example"},
		"backslash relative":  {"type": "custom", "label": "x", "url": "/\\evil.example"},
		"relative no slash":   {"type": "custom", "label": "x", "url": "about"},
		"whitespace":          {"type": "custom", "label": "x", "url": "/a b"},
		"custom without label": {"type": "custom", "url": "/a"},
		"custom without url":  {"type": "custom", "label": "x"},
		"post without target": {"type": "post"},
		"post with url":       {"type": "post", "target_id": 1, "url": "/x"},
		"archive without type": {"type": "archive"},
		"archive bad type":    {"type": "archive", "post_type": "../etc"},
		"unknown type":        {"type": "file", "url": "/x"},
		"too deep":            {"type": "custom", "label": "a", "url": "/a", "children": []jsonBody{{"type": "custom", "label": "b", "url": "/b", "children": []jsonBody{{"type": "custom", "label": "c", "url": "/c"}}}}},
	}
	for name, item := range invalid {
		t.Run("rejects "+name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/7/items", user: &menuEditor, body: jsonBody{"items": []jsonBody{item}}})
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
		})
	}

	t.Run("rejects too many items", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		children := make([]jsonBody, 100)
		for i := range children {
			children[i] = jsonBody{"type": "custom", "label": "x", "url": "/x"}
		}
		items := []jsonBody{
			{"type": "custom", "label": "a", "url": "/a", "children": children},
			{"type": "custom", "label": "b", "url": "/b", "children": children},
		}
		rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/7/items", user: &menuEditor, body: jsonBody{"items": items}})
		require.Equal(t, http.StatusBadRequest, rec.Code)
		require.Contains(t, rec.Body.String(), "at most 200")
	})

	errorCases := map[string]struct {
		err  error
		code int
	}{
		"missing menu":   {sql.ErrNoRows, http.StatusNotFound},
		"missing target": {errors.New(`insert or update on table "menu_items" violates foreign key constraint "menu_items_post_id_fkey"`), http.StatusBadRequest},
		"bad parent":     {db.ErrMenuItemParent, http.StatusBadRequest},
		"db down":        {errors.New("connection refused"), http.StatusInternalServerError},
	}
	for name, tc := range errorCases {
		t.Run(name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().ReplaceMenuItemsTx(gomock.Any(), gomock.Any()).Return(nil, tc.err)
			rec := serveMenuRequest(t, store, menuRequest{method: http.MethodPut, path: "/api/v1/menus/7/items", user: &menuAdmin, body: jsonBody{"items": []jsonBody{{"type": "post", "target_id": 999}}}})
			require.Equal(t, tc.code, rec.Code)
		})
	}
}

func getPublicMenu(t *testing.T, store *mockdb.MockStore, location string) (*httptest.ResponseRecorder, PublicMenuResponse) {
	t.Helper()
	rec := serveMenuRequest(t, store, menuRequest{method: http.MethodGet, path: "/public/menus/" + location})
	var resp PublicMenuResponse
	if rec.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
	}
	return rec, resp
}

func TestPublicMenu(t *testing.T) {
	t.Run("visible items with URLs from their targets", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), sql.NullString{String: "primary", Valid: true}).Return(testMenu("primary"), nil)
		archive := db.ListMenuItemsWithTargetsRow{ID: 4, ItemType: "archive", PostType: sql.NullString{String: "post", Valid: true},
			ArchiveLabel: sql.NullString{String: "Posts", Valid: true}, ArchivePublic: sql.NullBool{Bool: true, Valid: true}, ArchiveActive: sql.NullBool{Bool: true, Valid: true}}
		term := db.ListMenuItemsWithTargetsRow{ID: 5, ItemType: "term", Label: "Guides", TermID: sql.NullInt64{Int64: 3, Valid: true},
			TermName: sql.NullString{String: "Guide", Valid: true}, TermSlug: sql.NullString{String: "guides", Valid: true},
			TaxonomyName: sql.NullString{String: "category", Valid: true}, TaxonomyPublic: sql.NullBool{Bool: true, Valid: true}}
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{
			postItemRow(1, "about", "published"),
			customItemRow(2, 1, "Team", "/team"),
			archive, term,
		}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{PostUrlStructure: "slug"}, nil)

		rec, menu := getPublicMenu(t, store, "primary")
		require.Equal(t, http.StatusOK, rec.Code)
		require.Equal(t, "primary", menu.Location)
		require.Equal(t, []PublicMenuItem{
			{ID: 1, Label: "About us", URL: "/page/about", Children: []PublicMenuItem{{ID: 2, Label: "Team", URL: "/team", Children: []PublicMenuItem{}}}},
			{ID: 4, Label: "Posts", URL: "/post", Children: []PublicMenuItem{}},
			{ID: 5, Label: "Guides", URL: "/category/guides", Children: []PublicMenuItem{}},
		}, menu.Items)
	})

	t.Run("follows a slug change", func(t *testing.T) {
		for _, slug := range []string{"about", "about-us"} {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(testMenu("primary"), nil)
			store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{postItemRow(1, slug, "published")}, nil)
			store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{PostUrlStructure: "slug"}, nil)
			_, menu := getPublicMenu(t, store, "primary")
			require.Equal(t, "/page/"+slug, menu.Items[0].URL)
		}
	})

	t.Run("id URLs when the site uses them", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(testMenu("primary"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{postItemRow(1, "about", "published")}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{PostUrlStructure: "id"}, nil)
		_, menu := getPublicMenu(t, store, "primary")
		require.Equal(t, "/page/42", menu.Items[0].URL)
	})

	t.Run("hides unpublished and non-public targets, children move up", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(testMenu("footer"), nil)
		privateType := postItemRow(3, "secret", "published")
		privateType.PostTypePublic = sql.NullBool{Bool: false, Valid: true}
		privateTerm := db.ListMenuItemsWithTargetsRow{ID: 4, ItemType: "term", TermID: sql.NullInt64{Int64: 1, Valid: true},
			TermSlug: sql.NullString{String: "x", Valid: true}, TaxonomyPublic: sql.NullBool{Bool: false, Valid: true}}
		inactiveArchive := db.ListMenuItemsWithTargetsRow{ID: 5, ItemType: "archive", PostType: sql.NullString{String: "event", Valid: true},
			ArchiveLabel: sql.NullString{String: "Events", Valid: true}, ArchivePublic: sql.NullBool{Bool: true, Valid: true}}
		// A post that is gone (only possible outside the cascade).
		gone := db.ListMenuItemsWithTargetsRow{ID: 6, ItemType: "post", PostID: sql.NullInt64{Int64: 9, Valid: true}}
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{
			postItemRow(1, "draft-page", "draft"),
			customItemRow(2, 1, "Team", "/team"),
			privateType, privateTerm, inactiveArchive, gone,
			customItemRow(8, 0, "Old", "javascript:alert(1)"),
		}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{PostUrlStructure: "slug"}, nil)

		_, menu := getPublicMenu(t, store, "footer")
		require.Equal(t, []PublicMenuItem{{ID: 2, Label: "Team", URL: "/team", Children: []PublicMenuItem{}}}, menu.Items)
	})

	t.Run("no menu at the location", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(db.Menu{}, sql.ErrNoRows)
		rec, _ := getPublicMenu(t, store, "primary")
		require.Equal(t, http.StatusNotFound, rec.Code)

		rec, _ = getPublicMenu(t, store, "Not_An-Identifier!")
		require.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("an empty menu skips the settings lookup", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(testMenu("primary"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{}, nil)
		rec, menu := getPublicMenu(t, store, "primary")
		require.Equal(t, http.StatusOK, rec.Code)
		require.Empty(t, menu.Items)
		require.Contains(t, rec.Body.String(), `"items":[]`)
	})

	t.Run("errors", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(db.Menu{}, errors.New("db down"))
		rec, _ := getPublicMenu(t, store, "primary")
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		store = mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(testMenu("primary"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{postItemRow(1, "a", "published")}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, errors.New("db down"))
		// The menu still renders, with id URLs.
		rec, menu := getPublicMenu(t, store, "primary")
		require.Equal(t, http.StatusOK, rec.Code)
		require.Equal(t, "/page/42", menu.Items[0].URL)

		store = mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(testMenu("primary"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return(nil, errors.New("db down"))
		rec, _ = getPublicMenu(t, store, "primary")
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		// No settings row: id URLs.
		store = mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetMenuByLocation(gomock.Any(), gomock.Any()).Return(testMenu("primary"), nil)
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(7)).Return([]db.ListMenuItemsWithTargetsRow{postItemRow(1, "a", "published")}, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, sql.ErrNoRows)
		_, menu = getPublicMenu(t, store, "primary")
		require.Equal(t, "/page/42", menu.Items[0].URL)
	})
}

func TestValidMenuURL(t *testing.T) {
	for _, ok := range []string{"/", "/about", "/post/hello?x=1#top", "https://example.com", "HTTP://example.com/a"} {
		require.True(t, validMenuURL(ok), ok)
	}
	for _, bad := range []string{"", "javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "vbscript:x", "mailto:a@b.c",
		"//evil.example", "/\\evil.example", "https://", "https:/path", "about", "#top", "/a\nb"} {
		require.False(t, validMenuURL(bad), bad)
	}
}

func TestMenuPostPath(t *testing.T) {
	require.Equal(t, "/post/hello", menuPostPath("post", "hello", 7, "slug"))
	require.Equal(t, "/post/7", menuPostPath("post", "hello", 7, "id"))
	require.Equal(t, "/post/7", menuPostPath("post", "", 7, "slug"))
	require.Equal(t, "/post/7", menuPostPath("post", "2026", 7, "slug"))
	require.Equal(t, "/page/s%C3%A3o-paulo", menuPostPath("page", "são-paulo", 7, "slug"))
}

func TestParseMenuLocations(t *testing.T) {
	config := `
  menuLocations: [
    { name: "primary", label: "Header", description: "The main navigation" },
    { name: 'footer', label: 'Footer' },
    { name: "primary", label: "Duplicate" },
    { name: "Bad Name", label: "Skipped" },
    { name: "aside" },
  ],
  darkMode: { strategy: "class" },
`
	require.Equal(t, []DiscoveredMenuLocation{
		{Name: "primary", Label: "Header", Description: "The main navigation"},
		{Name: "footer", Label: "Footer"},
		{Name: "aside", Label: "aside"},
	}, parseMenuLocations(config))
	require.Empty(t, parseMenuLocations(`name: "x"`))

	// The default theme's header and footer read these two.
	theme, err := parseThemeConfig("default", "../web/themes/default/theme.config.ts", "../web/themes/default")
	require.NoError(t, err)
	locations, ok := theme.Config["menu_locations"].([]DiscoveredMenuLocation)
	require.True(t, ok)
	require.Equal(t, []string{"primary", "footer"}, []string{locations[0].Name, locations[1].Name})
}
