package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Global styles (#485) against the test database (skipped without one): a save, a stale
// save, the contrast question, the publish and its purge, the version, the release and
// the activity; and the draft never reaching /public or /themes.

type siteDesignDBFixture struct {
	conn   *sql.DB
	store  db.Store
	server *Server
	admin  db.User
	theme  db.Theme
}

// newSiteDesignDBFixture activates a theme of its own (the vectors' tokens), so nothing
// another test or the dev data stored for a real theme is touched; the previously active
// theme is put back afterwards.
func newSiteDesignDBFixture(t *testing.T) siteDesignDBFixture {
	t.Helper()
	conn, store, server := publicCacheDBServer(t)
	ctx := context.Background()
	slug := "gl485-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	server.themeTokens = fixtureThemeTokens(t, slug)

	previous, previousErr := store.GetActiveTheme(ctx)
	theme, err := store.CreateTheme(ctx, db.CreateThemeParams{Name: "Global styles test", Slug: slug, Version: "1.0.0", Config: json.RawMessage(`{}`)})
	require.NoError(t, err)
	require.NoError(t, store.DeactivateAllThemes(ctx))
	theme, err = store.ActivateTheme(ctx, theme.ID)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = store.DeactivateAllThemes(ctx)
		if previousErr == nil {
			_, _ = store.ActivateTheme(ctx, previous.ID)
		}
		_, _ = conn.Exec(`DELETE FROM global_styles WHERE theme_slug = $1`, slug)
		_, _ = conn.Exec(`DELETE FROM site_design_releases WHERE theme_slug = $1`, slug)
		_ = store.DeleteTheme(ctx, theme.ID)
	})
	return siteDesignDBFixture{conn: conn, store: store, server: server, admin: scheduleUser(t, store, RoleAdmin), theme: theme}
}

func (f siteDesignDBFixture) request(t *testing.T, caller *db.User, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if caller != nil {
		addAuthorization(t, request, f.server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	f.server.router.ServeHTTP(recorder, request)
	return recorder
}

func (f siteDesignDBFixture) activeThemeStyles(t *testing.T) (string, string) {
	t.Helper()
	recorder := cacheGet(t, f.server, "/api/v1/themes/active")
	requireStatus(t, recorder, http.StatusOK)
	var body struct {
		Slug         string          `json:"slug"`
		GlobalStyles json.RawMessage `json:"global_styles"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, f.theme.Slug, body.Slug)
	return string(body.GlobalStyles), recorder.Header().Get(publicCacheHeader)
}

func TestGlobalStylesSaveAndPublish(t *testing.T) {
	f := newSiteDesignDBFixture(t)
	const path = "/api/v1/site-design/global-styles"

	recorder := f.request(t, &f.admin, http.MethodGet, path, "")
	requireStatus(t, recorder, http.StatusOK)
	require.Zero(t, decodeStyles(t, recorder).DraftRevision)

	// The public read is cached before anything is saved.
	f.activeThemeStyles(t)
	styles, cached := f.activeThemeStyles(t)
	require.Equal(t, "HIT", cached)
	require.JSONEq(t, `{}`, styles)

	// A save: normalized, a new revision, no purge (the draft isn't public).
	recorder = f.request(t, &f.admin, http.MethodPut, path, `{"styles":{"colors":{"light":{"text":"#CCCCCC"}}},"base_revision":0}`)
	requireStatus(t, recorder, http.StatusOK)
	saved := decodeStyles(t, recorder)
	require.EqualValues(t, 1, saved.DraftRevision)
	require.JSONEq(t, `{"colors":{"light":{"text":"#cccccc"}}}`, string(saved.Draft))
	require.Len(t, saved.Contrast, 3)
	styles, cached = f.activeThemeStyles(t)
	require.Equal(t, "HIT", cached, "a draft save purged the public cache")
	require.JSONEq(t, `{}`, styles)

	// A save based on revision 0 is now stale: 409 with the current draft.
	recorder = f.request(t, &f.admin, http.MethodPut, path, `{"styles":{},"base_revision":0}`)
	rsp := requireCode(t, recorder, http.StatusConflict, "styles_changed")
	require.Contains(t, string(rsp["current"]), "#cccccc")

	// An unknown key is a 400 and stores nothing.
	recorder = f.request(t, &f.admin, http.MethodPut, path, `{"styles":{"colors":{"light":{"brandNew":"#123456"}}},"base_revision":1}`)
	requireCode(t, recorder, http.StatusBadRequest, globalStyleUnknownToken)

	// Publish asks about contrast first, and changes nothing until confirmed.
	recorder = f.request(t, &f.admin, http.MethodPost, "/api/v1/site-design/publish", `{}`)
	requireCode(t, recorder, http.StatusConflict, "contrast_unconfirmed")
	_, cached = f.activeThemeStyles(t)
	require.Equal(t, "HIT", cached, "an unconfirmed publish purged the public cache")

	recorder = f.request(t, &f.admin, http.MethodPost, "/api/v1/site-design/publish", `{"confirm_contrast":true}`)
	requireStatus(t, recorder, http.StatusOK)
	var published SiteDesignPublishResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &published))
	require.EqualValues(t, 1, published.GlobalStyles.VersionNo)
	require.Equal(t, 3, published.GlobalStyles.ContrastFailures)
	require.False(t, published.Styles.HasUnpublishedChanges)

	// After commit the public cache was purged, and the site reads the published styles.
	styles, cached = f.activeThemeStyles(t)
	require.Equal(t, "MISS", cached, "publishing didn't purge the public cache")
	require.JSONEq(t, `{"colors":{"light":{"text":"#cccccc"}}}`, styles)

	// Nothing left to publish.
	requireCode(t, f.request(t, &f.admin, http.MethodPost, "/api/v1/site-design/publish", `{"confirm_contrast":true}`), http.StatusConflict, "nothing_to_publish")

	// The release and its version.
	var summary json.RawMessage
	var versionNo int
	var versionStyles json.RawMessage
	require.NoError(t, f.conn.QueryRow(`
		SELECT r.summary, v.version_no, v.styles FROM site_design_releases r
		JOIN global_style_versions v ON v.release_id = r.id
		WHERE r.id = $1`, published.Release.ID).Scan(&summary, &versionNo, &versionStyles))
	require.JSONEq(t, `{"global_styles":{"groups":["colors"],"contrast_failures":3}}`, string(summary))
	require.Equal(t, 1, versionNo)
	require.JSONEq(t, `{"colors":{"light":{"text":"#cccccc"}}}`, string(versionStyles))

	// The activity: group names and counts, never a value.
	rows, err := f.conn.Query(`
		SELECT verb, object_id, payload FROM activity
		WHERE object_type = 'site_design' AND actor_id = $1 ORDER BY id`, f.admin.ID)
	require.NoError(t, err)
	defer rows.Close()
	events := []string{}
	for rows.Next() {
		var verb string
		var objectID int64
		var payload json.RawMessage
		require.NoError(t, rows.Scan(&verb, &objectID, &payload))
		require.NotContains(t, string(payload), "#cccccc")
		events = append(events, fmt.Sprintf("%s:%d %s", verb, objectID, payload))
	}
	require.NoError(t, rows.Err())
	require.Equal(t, []string{
		fmt.Sprintf(`global_styles_updated:%d {"groups": ["colors"]}`, f.theme.ID),
		fmt.Sprintf(`site_design_published:%d {"theme_slug": "%s", "contrast_failures": 3, "global_styles_groups": ["colors"]}`, published.Release.ID, f.theme.Slug),
	}, events)
}

// The route audit case of #485: a draft value is never served by any /public route or any
// /themes route, signed in or not. The published value is (so the check isn't vacuous).
func TestDraftGlobalStylesNeverPublic(t *testing.T) {
	f := newSiteDesignDBFixture(t)
	ctx := context.Background()

	// Every /public and /themes GET route, anonymous and signed in.
	audit := func() []string {
		bodies := []string{}
		for _, route := range f.server.router.Routes() {
			if route.Method != http.MethodGet {
				continue
			}
			if !strings.HasPrefix(route.Path, "/public/") && !strings.HasPrefix(route.Path, "/api/v1/themes") {
				continue
			}
			path := strings.ReplaceAll(routeExample(route.Path), "/themes/1", fmt.Sprintf("/themes/%d", f.theme.ID))
			for _, caller := range []*db.User{nil, &f.admin} {
				bodies = append(bodies, path+" "+f.request(t, caller, http.MethodGet, path, "").Body.String())
			}
		}
		return bodies
	}

	// A marker no route serves before the draft exists, so a match afterwards is the
	// draft and not a colour some other data happens to hold.
	baseline := strings.Join(audit(), "\n")
	publishedMarker := "#0a0b0c"
	draftMarker := ""
	for n := time.Now().UnixNano(); draftMarker == ""; n++ {
		candidate := fmt.Sprintf("#%06x", n&0xffffff)
		if candidate != publishedMarker && !strings.Contains(baseline, candidate) {
			draftMarker = candidate
		}
	}

	require.NoError(t, f.store.EnsureGlobalStyles(ctx, f.theme.Slug))
	_, err := f.conn.Exec(`UPDATE global_styles SET draft = $2, draft_revision = 1, published = $3 WHERE theme_slug = $1`, f.theme.Slug,
		fmt.Sprintf(`{"colors":{"light":{"primary":"%s"},"dark":{"primary":"%s"}}}`, draftMarker, draftMarker),
		fmt.Sprintf(`{"colors":{"light":{"primary":"%s"}}}`, publishedMarker))
	require.NoError(t, err)
	// Written around the API, so purge as a publish would (the baseline cached the reads).
	f.server.purgePublicCache(ctx, f.server.logger, "test")

	bodies := audit()
	for _, body := range bodies {
		require.NotContains(t, body, draftMarker, "a /public or /themes route serves the styles draft: %.200s", body)
	}
	require.Greater(t, len(bodies), 20, "the audit found too few routes")

	styles, _ := f.activeThemeStyles(t)
	require.Contains(t, styles, publishedMarker)

	// The admin's own route does serve it.
	recorder := f.request(t, &f.admin, http.MethodGet, "/api/v1/site-design/global-styles", "")
	requireStatus(t, recorder, http.StatusOK)
	require.Contains(t, recorder.Body.String(), draftMarker)
}

// PublishGlobalStylesTx refuses a revision that moved, writing nothing.
func TestPublishGlobalStylesTxStaleRevision(t *testing.T) {
	f := newSiteDesignDBFixture(t)
	ctx := context.Background()
	require.NoError(t, f.store.EnsureGlobalStyles(ctx, f.theme.Slug))
	_, err := f.store.UpdateGlobalStylesDraft(ctx, db.UpdateGlobalStylesDraftParams{
		Draft: json.RawMessage(`{"radius":{"md":"10px"}}`), ThemeSlug: f.theme.Slug, BaseRevision: 0,
	})
	require.NoError(t, err)

	_, err = f.store.PublishGlobalStylesTx(ctx, db.PublishGlobalStylesTxParams{ThemeSlug: f.theme.Slug, DraftRevision: 0, Summary: json.RawMessage(`{}`)})
	require.ErrorIs(t, err, db.ErrGlobalStylesChanged)
	var releases int
	require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM site_design_releases WHERE theme_slug = $1`, f.theme.Slug).Scan(&releases))
	require.Zero(t, releases)

	result, err := f.store.PublishGlobalStylesTx(ctx, db.PublishGlobalStylesTxParams{ThemeSlug: f.theme.Slug, DraftRevision: 1, Summary: json.RawMessage(`{}`)})
	require.NoError(t, err)
	require.EqualValues(t, 1, result.Version.VersionNo)
	require.JSONEq(t, `{"radius":{"md":"10px"}}`, string(result.Styles.Published))
	require.Equal(t, result.Version.ID, result.Styles.PublishedVersionID.Int64)

	// A second publish of the same theme is version 2.
	_, err = f.store.UpdateGlobalStylesDraft(ctx, db.UpdateGlobalStylesDraftParams{Draft: json.RawMessage(`{}`), ThemeSlug: f.theme.Slug, BaseRevision: 1})
	require.NoError(t, err)
	result, err = f.store.PublishGlobalStylesTx(ctx, db.PublishGlobalStylesTxParams{ThemeSlug: f.theme.Slug, DraftRevision: 2, Summary: json.RawMessage(`{}`)})
	require.NoError(t, err)
	require.EqualValues(t, 2, result.Version.VersionNo)

	// No row at all.
	_, err = f.store.PublishGlobalStylesTx(ctx, db.PublishGlobalStylesTxParams{ThemeSlug: f.theme.Slug + "-none", DraftRevision: 0, Summary: json.RawMessage(`{}`)})
	require.ErrorIs(t, err, sql.ErrNoRows)
}
