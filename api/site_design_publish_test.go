package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Publish site design (#492) on a mock store: the order of the three phases (every flush
// before the transaction, none inside it), what's refused before it, and the helpers.

const (
	publishTemplateDoc = `{"doc_version":1,"blocks_order":["blk-heading-0001","blk-part-0000001"],"blocks":{"blk-heading-0001":{"id":"blk-heading-0001","type":"heading","version":1,"attrs":{"level":2,"text":"Hi"}},"blk-part-0000001":{"id":"blk-part-0000001","type":"template_part","version":1,"attrs":{"slug":"header"}}}}`
	publishPartDoc     = `{"doc_version":1,"blocks_order":["blk-title-00001"],"blocks":{"blk-title-00001":{"id":"blk-title-00001","type":"site_title","version":1,"attrs":{"level":2}}}}`
)

func publishRow(id int64, kind, slug, doc string, published *string, state string) db.SiteTemplate {
	row := db.SiteTemplate{ID: id, ThemeSlug: siteDesignTheme.Slug, Kind: kind, Slug: slug, Title: slug, BlockDoc: json.RawMessage(doc),
		BlockRevision: 3, WorkingState: state, Source: "starter"}
	if published != nil {
		row.PublishedBlockDoc = pqtype.NullRawMessage{RawMessage: json.RawMessage(*published), Valid: true}
		row.PublishedVersionID = sql.NullInt64{Int64: id * 10, Valid: true}
	}
	return row
}

// flushRecorder is a fake collab server that records each flush and can be told to fail.
type flushRecorder struct {
	mu      sync.Mutex
	paths   []string
	failing bool
}

func (f *flushRecorder) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.paths = append(f.paths, r.URL.Path)
		if f.failing {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (f *flushRecorder) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.paths...)
}

func publishServer(t *testing.T, collab *flushRecorder) (*Server, *mockdb.MockStore) {
	t.Helper()
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newCollabTestServer(t, store, collab.server(t).URL)
	server.themeTokens = fixtureThemeTokens(t, globalStylesFixtureSlug)
	return server, store
}

func TestPublishSiteDesignFlushesBeforeTheTransaction(t *testing.T) {
	collab := &flushRecorder{}
	server, store := publishServer(t, collab)
	header := `{"doc_version":1,"blocks_order":[],"blocks":{}}`
	rows := []db.SiteTemplate{
		publishRow(1, "template", "single", publishTemplateDoc, nil, "custom"),
		publishRow(2, "part", "header", publishPartDoc, &header, "custom"),
		publishRow(3, "part", "footer", publishPartDoc, &header, "reset"),
		publishRow(4, "part", "aside", publishPartDoc, nil, "reset"), // reset, never published: nothing to do
	}
	expectPublishReads(store, rows, stylesRow(`{}`, `{}`, 0))
	store.EXPECT().PublishSiteDesignTx(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.PublishSiteDesignTxParams) (db.PublishSiteDesignTxResult, error) {
		// Every custom row was flushed before, the reset ones never; and nothing is
		// flushed while the transaction runs.
		require.ElementsMatch(t, []string{"/internal/documents/template-1/flush", "/internal/documents/template-2/flush"}, collab.calls())
		require.Nil(t, arg.StylesDraftRevision, "the styles had no changes")
		require.Equal(t, []int64{1, 3, 2}, arg.Publish, "templates first, then parts by slug")
		require.Len(t, arg.Rows, 4)
		require.JSONEq(t, `{"templates":[{"id":1,"kind":"template","slug":"single","reset":false},{"id":3,"kind":"part","slug":"footer","reset":true},{"id":2,"kind":"part","slug":"header","reset":false}]}`, string(arg.Summary))
		result := db.PublishSiteDesignTxResult{Release: db.SiteDesignRelease{ID: 90, ThemeSlug: arg.ThemeSlug, PublishedAt: time.Now()}}
		for _, id := range arg.Publish {
			row := rows[id-1]
			version := db.SiteTemplateVersion{TemplateID: id, VersionNo: 2}
			if row.WorkingState == "custom" {
				version.BlockDoc = pqtype.NullRawMessage{RawMessage: row.BlockDoc, Valid: true}
			}
			result.Templates = append(result.Templates, db.PublishedSiteTemplate{Template: row, Version: version})
		}
		return result, nil
	})
	store.EXPECT().GetActiveTheme(gomock.Any()).AnyTimes().Return(siteDesignTheme, nil)
	recorder := siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", "")
	requireStatus(t, recorder, http.StatusOK)
	require.Len(t, collab.calls(), 2, "no flush after the transaction")
	var rsp SiteDesignPublishResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Nil(t, rsp.GlobalStyles)
	require.Len(t, rsp.Templates, 3)
	require.True(t, rsp.Templates[1].Reset)

	rec := activityOf(t, server)
	require.Equal(t, []string{"site_design_published site_design:90"}, rec.verbs())
	require.JSONEq(t, `{"theme_slug":"vectors","templates":1,"parts":2,"resets":1,"slugs":["template:single","part:footer","part:header"]}`, string(rec.events[0].Payload))
}

func TestPublishSiteDesignRefusals(t *testing.T) {
	t.Run("a failed flush stops the publish, naming the item", func(t *testing.T) {
		collab := &flushRecorder{failing: true}
		server, store := publishServer(t, collab)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
		store.EXPECT().ListSiteTemplatesByTheme(gomock.Any(), siteDesignTheme.Slug).Return([]db.SiteTemplate{publishRow(1, "template", "single", publishTemplateDoc, nil, "custom")}, nil)
		rsp := requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusServiceUnavailable, codeCollabSaveFailed)
		require.JSONEq(t, `"single"`, string(rsp["slug"]))
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("the rows changed under the transaction", func(t *testing.T) {
		server, store := publishServer(t, &flushRecorder{})
		expectPublishReads(store, []db.SiteTemplate{publishRow(1, "template", "single", publishTemplateDoc, nil, "custom")}, nil)
		store.EXPECT().PublishSiteDesignTx(gomock.Any(), gomock.Any()).Return(db.PublishSiteDesignTxResult{}, db.ErrSiteDesignChanged)
		requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "design_changed")
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("a block this build no longer has", func(t *testing.T) {
		server, store := publishServer(t, &flushRecorder{})
		bad := `{"doc_version":1,"blocks_order":["blk-content-001","blk-content-002"],"blocks":{"blk-content-001":{"id":"blk-content-001","type":"post_content","version":1,"attrs":{}},"blk-content-002":{"id":"blk-content-002","type":"post_content","version":1,"attrs":{}}}}`
		expectPublishReads(store, []db.SiteTemplate{publishRow(1, "template", "single", bad, nil, "custom")}, nil)
		rsp := requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "design_invalid")
		require.Contains(t, string(rsp["problems"]), `"code":"template_invalid"`)
		require.Contains(t, string(rsp["error"]), "can't be published")
	})

	t.Run("several problems are all listed", func(t *testing.T) {
		server, store := publishServer(t, &flushRecorder{})
		expectPublishReads(store, []db.SiteTemplate{
			publishRow(1, "template", "archive", `{}`, nil, "custom"),
			publishRow(2, "template", "single", `{"doc_version":1,"blocks_order":["blk-part-0000001"],"blocks":{"blk-part-0000001":{"id":"blk-part-0000001","type":"template_part","version":1,"attrs":{"slug":"nowhere"}}}}`, nil, "custom"),
		}, nil)
		rsp := requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "design_invalid")
		var problems []SiteDesignProblem
		require.NoError(t, json.Unmarshal(rsp["problems"], &problems))
		require.Len(t, problems, 2)
		require.Contains(t, string(rsp["error"]), "(and 1 more)")
	})

	t.Run("a part reset by this publish leaves a live template without it", func(t *testing.T) {
		server, store := publishServer(t, &flushRecorder{})
		live := `{"doc_version":1,"blocks_order":["blk-part-0000001"],"blocks":{"blk-part-0000001":{"id":"blk-part-0000001","type":"template_part","version":1,"attrs":{"slug":"promo"}}}}`
		expectPublishReads(store, []db.SiteTemplate{
			publishRow(1, "template", "single", live, &live, "custom"),
			publishRow(2, "part", "promo", publishPartDoc, &[]string{publishPartDoc}[0], "reset"),
		}, nil)
		rsp := requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "design_invalid")
		require.Contains(t, string(rsp["problems"]), `"part":"promo"`)
	})

	t.Run("a live template broken by something else doesn't block an unrelated publish", func(t *testing.T) {
		server, store := publishServer(t, &flushRecorder{})
		broken := `{"doc_version":1,"blocks_order":["blk-part-0000001"],"blocks":{"blk-part-0000001":{"id":"blk-part-0000001","type":"template_part","version":1,"attrs":{"slug":"gone"}}}}`
		expectPublishReads(store, []db.SiteTemplate{publishRow(1, "template", "single", broken, &broken, "custom")}, stylesRow(`{"radius":{"md":"10px"}}`, `{}`, 1))
		store.EXPECT().PublishSiteDesignTx(gomock.Any(), gomock.Any()).Return(db.PublishSiteDesignTxResult{
			Release:       db.SiteDesignRelease{ID: 91, ThemeSlug: siteDesignTheme.Slug, PublishedAt: time.Now()},
			StylesVersion: &db.GlobalStyleVersion{VersionNo: 1},
			Styles:        stylesRow(`{"radius":{"md":"10px"}}`, `{"radius":{"md":"10px"}}`, 1),
		}, nil)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusOK)
	})

	t.Run("database errors", func(t *testing.T) {
		server, store := publishServer(t, &flushRecorder{})
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusNotFound)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusInternalServerError)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
		store.EXPECT().ListSiteTemplatesByTheme(gomock.Any(), gomock.Any()).Return(nil, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusInternalServerError)
	})
}

func TestSiteDesignHelpers(t *testing.T) {
	published := `{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{"id":"a"}}}`
	reordered := `{"blocks":{"a":{"id":"a"}},"blocks_order":["a"],"doc_version":1}`
	require.Equal(t, "publish", siteTemplateChange(publishRow(1, "template", "x", published, nil, "custom")))
	require.Equal(t, "", siteTemplateChange(publishRow(1, "template", "x", reordered, &published, "custom")), "key order is no change")
	require.Equal(t, "reset", siteTemplateChange(publishRow(1, "template", "x", reordered, &published, "reset")))
	require.Equal(t, "", siteTemplateChange(publishRow(1, "template", "x", reordered, nil, "reset")))
	require.False(t, sameJSON(json.RawMessage(`{`), json.RawMessage(`{}`)))

	empty := func(raw string) bool {
		doc, err := parseStoredBlockDoc(json.RawMessage(raw))
		require.NoError(t, err)
		return blockDocIsEmpty(doc)
	}
	require.True(t, empty(`{}`))
	require.True(t, empty(`{"doc_version":1,"blocks_order":["p"],"blocks":{"p":{"type":"paragraph","attrs":{"text":"","pm":{"type":"paragraph"}}}}}`))
	require.False(t, empty(`{"doc_version":1,"blocks_order":["p"],"blocks":{"p":{"type":"paragraph","attrs":{"text":"hi"}}}}`))
	require.False(t, empty(`{"doc_version":1,"blocks_order":["p"],"blocks":{"p":{"type":"paragraph","attrs":{"pm":{"content":[{"type":"hardBreak"}]}}}}}`))
	require.False(t, empty(`{"doc_version":1,"blocks_order":["s"],"blocks":{"s":{"type":"site_title"}}}`))
	require.True(t, empty(`{"doc_version":1,"blocks_order":["g"],"blocks":{"g":{"type":"group","children":["c"]},"c":{"type":"columns","children":["k"]},"k":{"type":"column","children":["p"]},"p":{"type":"paragraph","attrs":{"text":""}}}}`), "groups and columns of blank lines")
	require.False(t, empty(`{"doc_version":1,"blocks_order":["g"],"blocks":{"g":{"type":"group","children":["h"]},"h":{"type":"heading","attrs":{"text":"Hi"}}}}`))
	require.False(t, empty(`{"doc_version":1,"blocks_order":["g"],"blocks":{"g":{"type":"group","children":[7]}}}`))
	require.True(t, empty(`{"doc_version":1,"blocks_order":["g"],"blocks":{"g":{"type":"group","children":["g"]}}}`), "a cycle ends")

	doc, err := parseStoredBlockDoc(json.RawMessage(`{"doc_version":1,"blocks_order":["g"],"blocks":{"g":{"type":"group","children":["b","c"]},"b":{"type":"template_part","attrs":{"slug":"footer"}},"c":{"type":"template_part","attrs":{"slug":"aside"}},"d":{"type":"template_part","attrs":{"slug":"footer"}}}}`))
	require.NoError(t, err)
	require.Equal(t, []string{"aside", "footer"}, templatePartSlugs(doc), "nested ones too, sorted, once")
}

func TestSiteTemplateRoutesOnMock(t *testing.T) {
	t.Run("bad ids and missing rows", func(t *testing.T) {
		server, store := siteDesignServer(t)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/templates/abc", ""), http.StatusBadRequest)
		store.EXPECT().GetSiteTemplate(gomock.Any(), int64(5)).Return(db.SiteTemplate{}, sql.ErrNoRows)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/templates/5/reset", ""), http.StatusNotFound)
		store.EXPECT().GetSiteTemplate(gomock.Any(), int64(5)).Return(db.SiteTemplate{}, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/templates/5/versions", ""), http.StatusInternalServerError)
		row := publishRow(5, "template", "single", publishTemplateDoc, nil, "custom")
		store.EXPECT().GetSiteTemplate(gomock.Any(), int64(5)).Return(row, nil)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/templates/5/versions/x", ""), http.StatusBadRequest)
		store.EXPECT().GetSiteTemplate(gomock.Any(), int64(5)).Return(row, nil)
		store.EXPECT().GetSiteTemplateVersion(gomock.Any(), gomock.Any()).Return(db.SiteTemplateVersion{}, sql.ErrNoRows)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/templates/5/versions/9/restore", ""), http.StatusNotFound)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/templates/5/default?from=other", ""), http.StatusBadRequest)
	})

	t.Run("reset twice records once", func(t *testing.T) {
		server, store := siteDesignServer(t)
		row := publishRow(5, "template", "single", publishTemplateDoc, nil, "reset")
		store.EXPECT().GetSiteTemplate(gomock.Any(), int64(5)).Return(row, nil)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/templates/5/reset", ""), http.StatusOK)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("delete of a row another publish just published", func(t *testing.T) {
		server, store := siteDesignServer(t)
		row := publishRow(5, "part", "header", publishPartDoc, nil, "custom")
		store.EXPECT().GetSiteTemplate(gomock.Any(), int64(5)).Times(2).Return(row, nil)
		store.EXPECT().DeleteUnpublishedSiteTemplate(gomock.Any(), int64(5)).Return(int64(0), nil)
		requireCode(t, siteDesignRequest(t, server, store, http.MethodDelete, "/api/v1/site-design/templates/5", ""), http.StatusConflict, "template_published")
	})

	t.Run("releases paging", func(t *testing.T) {
		server, store := siteDesignServer(t)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/releases?limit=0", ""), http.StatusBadRequest)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/releases?before=x", ""), http.StatusBadRequest)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
		store.EXPECT().ListSiteDesignReleases(gomock.Any(), gomock.Any()).Return(nil, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/releases", ""), http.StatusInternalServerError)
	})

	t.Run("a styles version the theme no longer fits", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{}`, `{}`, 4))
		store.EXPECT().GetGlobalStyleVersion(gomock.Any(), gomock.Any()).Return(db.GlobalStyleVersion{VersionNo: 1, Styles: json.RawMessage(`{"colors":{"light":{"retired":"#123456"}}}`)}, nil)
		requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/global-styles/versions/1/restore", `{"base_revision":4}`), http.StatusConflict, "styles_invalid")
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/global-styles/discard", `{}`), http.StatusBadRequest)
	})
}
