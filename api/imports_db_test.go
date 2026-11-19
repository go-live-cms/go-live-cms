package api

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/importer"
	"github.com/go-live-cms/go-live-cms/util"
)

// The importer (#150) against the real database: the upload and its summary, the mapping,
// the job (posts, pages, terms, media through the upload pipeline, redirects, the report),
// running it again (nothing twice), Markdown, stopping, the claim's fencing and the roles.
// The site's images come from a local httptest server standing in for the WordPress host
// (the outbound guard's test allowance, as media_import_test.go does).

type importDBFixture struct {
	t      *testing.T
	conn   *sql.DB
	store  db.Store
	server *Server
	site   *httptest.Server
	hits   map[string]int
	hitsMu sync.Mutex
	admin  db.User
	ana    db.User
	run    string
}

func newImportDBFixture(t *testing.T, adjust func(*util.Config)) *importDBFixture {
	t.Helper()
	config, err := util.LoadConfig("..")
	if err != nil || config.DBSource == "" {
		t.Skip("no test database configured")
	}
	conn, err := sql.Open(config.DBDriver, config.DBSource)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	if err := conn.Ping(); err != nil {
		t.Skipf("test database unreachable: %v", err)
	}
	f := &importDBFixture{t: t, conn: conn, store: db.NewStore(conn), hits: map[string]int{}, run: strings.ReplaceAll(uuid.NewString(), "-", "")[:12]}

	mux := http.NewServeMux()
	serve := func(route string, body []byte) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			f.hitsMu.Lock()
			f.hits[r.URL.Path]++
			f.hitsMu.Unlock()
			_, _ = w.Write(body)
		})
	}
	serve("/wp-content/uploads/2024/05/bike.jpg", testJPEG(t, 6, 4))
	serve("/wp-content/uploads/2024/05/bike-300x200.jpg", testJPEG(t, 3, 2))
	serve("/wp-content/uploads/2024/05/bike-1024x683.jpg", testJPEG(t, 3, 2))
	serve("/wp-content/uploads/2024/05/team.png", testPNG(t, 4, 4))
	serve("/wp-content/uploads/2024/05/harbour.jpg", testJPEG(t, 5, 3))
	serve("/wp-content/uploads/2024/05/market.jpg", testJPEG(t, 4, 3))
	serve("/wp-content/uploads/2024/05/annual-report.pdf", []byte("%PDF-1.7\n%test\n"))
	serve("/wp-content/uploads/not-an-image.jpg", []byte("<html>nope</html>"))
	mux.HandleFunc("/wp-content/uploads/away.jpg", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://localhost:1/elsewhere.jpg", http.StatusFound)
	})
	f.site = httptest.NewServer(mux)
	t.Cleanup(f.site.Close)

	f.server = authFlowServer(t, f.store, adjust)
	allowed := netip.MustParseAddrPort(f.site.Listener.Addr().String())
	f.server.mediaImport = newMediaImporter(func(ap netip.AddrPort) bool { return ap == allowed })

	f.admin = f.user(RoleAdmin, "imp-admin")
	f.ana = f.user(RoleContributor, "imp-ana")
	return f
}

func (f *importDBFixture) user(role, prefix string) db.User {
	f.t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	u, err := f.store.CreateUser(context.Background(), db.CreateUserParams{
		Username: prefix + suffix, FullName: prefix, Email: prefix + suffix + "@example.test",
		HashedPassword: "x", Role: role,
	})
	require.NoError(f.t, err)
	return u
}

func (f *importDBFixture) token(u db.User) string {
	f.t.Helper()
	token, err := f.server.tokenMaker.CreateToken(u.ID, u.Username, time.Minute)
	require.NoError(f.t, err)
	return token
}

// export is the fixture with this run's site, GUIDs (imports are idempotent across the
// shared database) and Ana's email.
func (f *importDBFixture) export() []byte {
	f.t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "importer", "testdata", "wordpress-export.xml"))
	require.NoError(f.t, err)
	s := strings.ReplaceAll(string(raw), `<guid isPermaLink="false">https://example.com/`, `<guid isPermaLink="false">https://example.com/`+f.run+`/`)
	s = strings.ReplaceAll(s, "https://example.com", f.site.URL)
	s = strings.ReplaceAll(s, "ana@example.com", f.ana.Email)
	return []byte(s)
}

func (f *importDBFixture) do(u db.User, method, path string, body []byte, contentType string) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Authorization", "Bearer "+f.token(u))
	rec := httptest.NewRecorder()
	f.server.router.ServeHTTP(rec, req)
	return rec
}

func (f *importDBFixture) upload(u db.User, name string, data []byte) *httptest.ResponseRecorder {
	f.t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", name)
	require.NoError(f.t, err)
	_, _ = part.Write(data)
	require.NoError(f.t, w.Close())
	return f.do(u, http.MethodPost, "/api/v1/imports", body.Bytes(), w.FormDataContentType())
}

type importJobBody struct {
	Import struct {
		ID             int64           `json:"id"`
		Status         string          `json:"status"`
		Summary        importSummary   `json:"summary"`
		Progress       importProgress  `json:"progress"`
		ImportedBefore *int64          `json:"imported_before"`
		Mapping        json.RawMessage `json:"mapping"`
	} `json:"import"`
}

func decodeJob(t *testing.T, rec *httptest.ResponseRecorder) importJobBody {
	t.Helper()
	var body importJobBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), rec.Body.String())
	return body
}

func (f *importDBFixture) start(jobID int64, mapping string) importJobBody {
	f.t.Helper()
	rec := f.do(f.admin, http.MethodPost, fmt.Sprintf("/api/v1/imports/%d/start", jobID), []byte(mapping), "application/json")
	require.Equal(f.t, http.StatusOK, rec.Code, rec.Body.String())
	return decodeJob(f.t, rec)
}

// runUntilFinished runs import rounds until the job ends (other tests' jobs may be ahead).
func (f *importDBFixture) runUntilFinished(jobID int64) db.ImportJob {
	f.t.Helper()
	ctx := context.Background()
	for i := 0; i < 50; i++ {
		job, err := f.store.GetImportJob(ctx, jobID)
		require.NoError(f.t, err)
		if job.Status != db.ImportJobQueued && job.Status != db.ImportJobRunning {
			return job
		}
		if !f.server.runImportRound(ctx) {
			// Someone else's lease: let it run out.
			time.Sleep(50 * time.Millisecond)
		}
	}
	f.t.Fatalf("import %d didn't finish", jobID)
	return db.ImportJob{}
}

type importedItem struct {
	ID     int64
	WpID   int64
	Status string
	Reason string
	PostID sql.NullInt64
	Result importItemResult
}

func (f *importDBFixture) items(jobID int64) map[int64]importedItem {
	f.t.Helper()
	rows, err := f.conn.Query(`SELECT id, wp_id, status, reason, post_id, result FROM import_items WHERE job_id = $1`, jobID)
	require.NoError(f.t, err)
	defer rows.Close()
	out := map[int64]importedItem{}
	for rows.Next() {
		var it importedItem
		var result []byte
		require.NoError(f.t, rows.Scan(&it.ID, &it.WpID, &it.Status, &it.Reason, &it.PostID, &result))
		require.NoError(f.t, json.Unmarshal(result, &it.Result))
		out[it.WpID] = it
	}
	return out
}

func (f *importDBFixture) scalar(query string, args ...any) any {
	f.t.Helper()
	var v any
	require.NoError(f.t, f.conn.QueryRow(query, args...).Scan(&v))
	return v
}

func TestImportWordPressExport(t *testing.T) {
	f := newImportDBFixture(t, nil)
	ctx := context.Background()

	rec := f.upload(f.admin, "example.wordpress.2026-11-19.xml", f.export())
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	job := decodeJob(t, rec)
	require.Equal(t, db.ImportJobMapping, job.Import.Status)
	s := job.Import.Summary
	require.Equal(t, "wxr", s.Source)
	require.Equal(t, "127.0.0.1", s.SiteHost)
	require.Equal(t, 5, s.Items)
	require.Equal(t, 5, s.Categories)
	require.Equal(t, 2, s.Tags)
	require.Equal(t, 1, s.OtherTerms)
	require.Equal(t, 5, s.Attachments)
	require.Equal(t, map[string]int{"in_trash": 1}, s.Skipped)
	require.Equal(t, 2, s.NotImported["comments"])
	require.Equal(t, 1, s.NotImported["nav_menu_item"])
	require.Len(t, s.Authors, 2)
	require.Equal(t, importAuthor{Login: "ana", DisplayName: "Ana Costa", Posts: 2, SuggestedUserID: f.ana.ID, MatchedBy: "email"}, s.Authors[0])
	require.Equal(t, "kenji", s.Authors[1].Login)
	require.Equal(t, []importTypeCount{
		{Type: "post", Count: 2, Published: 2, Suggested: "post"},
		{Type: "page", Count: 2, Published: 1, Suggested: "page"},
		{Type: "product", Count: 1, Published: 1, Suggested: ""},
	}, s.Types)
	require.Equal(t, int64(0), *job.Import.ImportedBefore)
	jobID := job.Import.ID

	// Nothing runs before the mapping.
	require.Equal(t, db.ImportJobMapping, f.runUntilFinished(jobID).Status)

	started := f.start(jobID, fmt.Sprintf(`{"authors":{"ana":%d,"kenji":0},"types":{"post":"post","page":"page","product":""}}`, f.ana.ID))
	require.Equal(t, db.ImportJobQueued, started.Import.Status)
	rec = f.do(f.admin, http.MethodPost, fmt.Sprintf("/api/v1/imports/%d/start", jobID), []byte(`{"types":{}}`), "application/json")
	require.Equal(t, http.StatusConflict, rec.Code)

	finished := f.runUntilFinished(jobID)
	require.Equal(t, db.ImportJobDone, finished.Status)
	require.Equal(t, int64(0), f.scalar(`SELECT count(*) FROM import_files WHERE job_id = $1`, jobID))

	items := f.items(jobID)
	require.Len(t, items, 6)
	for _, wpID := range []int64{20, 21, 30, 31} {
		require.Equal(t, db.ImportItemImported, items[wpID].Status, "item %d: %+v", wpID, items[wpID])
		require.True(t, items[wpID].PostID.Valid)
	}
	require.Equal(t, importReasonTypeSkipped, items[60].Reason)
	require.Equal(t, "in_trash", items[40].Reason)

	classic, err := f.store.GetPost(ctx, items[20].PostID.Int64)
	require.NoError(t, err)
	require.Equal(t, "Hello & welcome: a classic post", classic.Title)
	require.Equal(t, f.ana.ID, classic.UserID, "Ana's posts go to the member she was matched with")
	require.Equal(t, "published", classic.PostStatus)
	require.True(t, classic.PublishedVersionID.Valid, "published like the Publish button: a version")
	require.True(t, strings.HasPrefix(classic.Slug, "hello-classic-world"))
	require.Equal(t, "A short welcome.", classic.Description)
	require.Equal(t, time.Date(2024, 5, 6, 11, 0, 0, 0, time.UTC), classic.CreatedAt.UTC())
	require.Equal(t, time.Date(2024, 5, 6, 11, 0, 0, 0, time.UTC), classic.FirstPublishedAt.Time.UTC())
	require.Equal(t, int64(0), f.scalar(`SELECT count(*) FROM post_ydoc_state WHERE post_id = $1`, classic.ID), "the importer never writes Yjs state")

	// One category (the first), both tags; the custom taxonomy isn't imported.
	var terms []string
	rows, err := f.conn.Query(`SELECT ty.name || ':' || t.slug FROM post_taxonomy_relationships r JOIN taxonomy_terms t ON t.id = r.taxonomy_term_id JOIN taxonomy_types ty ON ty.id = t.taxonomy_type_id WHERE r.post_id = $1 ORDER BY 1`, classic.ID)
	require.NoError(t, err)
	for rows.Next() {
		var s string
		require.NoError(t, rows.Scan(&s))
		terms = append(terms, s)
	}
	rows.Close()
	require.Len(t, terms, 3)
	require.Equal(t, "category:news", terms[0])
	require.Contains(t, terms[1], "tag:news", "the tag gets its own slug beside the category's")
	require.Equal(t, "tag:wordpress", terms[2])
	require.Contains(t, items[20].Result.Notes, "extra_categories")

	// Nested categories: the deepest goes under its top-level ancestor.
	require.Equal(t, f.scalar(`SELECT id FROM taxonomy_terms WHERE slug = 'guides'`), f.scalar(`SELECT parent_id FROM taxonomy_terms WHERE slug = 'migrations'`))

	// Media: the originals, through the upload pipeline, with alt text; the resized copies
	// the post showed are never fetched.
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal(classic.BlockDoc, &doc))
	image := impAttrs(blocksOfType(doc, "image")[0])
	bike, err := f.store.GetMedia(ctx, int64(image["mediaId"].(float64)))
	require.NoError(t, err)
	require.Equal(t, "A red bicycle against a wall", bike.Alt)
	require.Equal(t, "bike", bike.Name)
	require.Equal(t, "image/jpeg", bike.MimeType)
	require.Equal(t, "/uploads/media/"+filepath.Base(bike.MediaPath), image["src"])
	require.Equal(t, 1, f.hits["/wp-content/uploads/2024/05/bike.jpg"], "downloaded once, reused by the second post")
	require.Zero(t, f.hits["/wp-content/uploads/2024/05/bike-300x200.jpg"])
	require.Zero(t, f.hits["/wp-content/uploads/2024/05/bike-1024x683.jpg"])
	featured := f.scalar(`SELECT media_id FROM post_media WHERE post_id = $1 AND "order" = 0`, classic.ID).(int64)
	team, err := f.store.GetMedia(ctx, featured)
	require.NoError(t, err)
	require.Equal(t, "The team at the 2024 retreat", team.Alt)
	require.Equal(t, int64(1), f.scalar(`SELECT count(*) FROM post_media WHERE post_id = $1 AND media_id = $2 AND "order" > 0`, classic.ID, bike.ID))
	require.Len(t, items[20].Result.MediaFailed, 1)
	require.Equal(t, "other_host", items[20].Result.MediaFailed[0].Code)

	// The old permalink redirects to the new URL.
	redirect, err := f.store.GetRedirectByFromPath(ctx, "/2024/05/06/hello-classic-world")
	require.NoError(t, err)
	settings, err := f.store.GetSettings(ctx)
	require.NoError(t, err)
	require.Equal(t, postSitePath("post", classic.Slug, classic.ID, settings.PostUrlStructure, "news"), redirect.ToPath)
	require.Equal(t, int32(301), redirect.StatusCode)
	require.Equal(t, db.RedirectSourceImport, redirect.Source)
	require.Equal(t, []string{"/2024/05/06/hello-classic-world"}, items[20].Result.Redirects)

	// The block editor post: custom HTML as a snippet, dropped blocks with their original.
	blocksPost, err := f.store.GetPost(ctx, items[21].PostID.Int64)
	require.NoError(t, err)
	require.Equal(t, f.admin.ID, blocksPost.UserID, "Kenji wasn't matched: the importer owns his posts")
	require.Equal(t, int64(1), f.scalar(`SELECT count(*) FROM post_html_snippets WHERE post_id = $1`, blocksPost.ID))
	require.NotContains(t, f.scalar(`SELECT html FROM post_html_snippets WHERE post_id = $1`, blocksPost.ID), "<script")
	require.Len(t, items[21].Result.Dropped, 3)
	require.Equal(t, "cdn.other-host.net/podcast.mp3", items[21].Result.MediaFailed[0].URL)

	// Pages: the child under its parent (the export listed it first), private → draft.
	about, err := f.store.GetPost(ctx, items[30].PostID.Int64)
	require.NoError(t, err)
	team2, err := f.store.GetPost(ctx, items[31].PostID.Int64)
	require.NoError(t, err)
	require.Equal(t, "page", team2.PostType)
	require.Equal(t, "draft", team2.PostStatus)
	require.Equal(t, about.ID, team2.PostParent.Int64)
	require.Contains(t, items[31].Result.Notes, "was_private")

	// The report through the routes.
	rec = f.do(f.admin, http.MethodGet, fmt.Sprintf("/api/v1/imports/%d", jobID), nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	got := decodeJob(t, rec)
	require.Equal(t, importProgress{Total: 6, Imported: 4, Skipped: 2, WithDropped: 2, MediaFailed: 2}, got.Import.Progress)
	rec = f.do(f.admin, http.MethodGet, fmt.Sprintf("/api/v1/imports/%d/media-failures", jobID), nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	var failures struct {
		MediaFailures []ImportMediaFailureRow `json:"media_failures"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &failures))
	require.Len(t, failures.MediaFailures, 2)
	require.Equal(t, "Hello & welcome: a classic post", failures.MediaFailures[0].Post)
	require.Equal(t, "other_host", failures.MediaFailures[0].Code)
	require.Equal(t, "cdn.other-host.net/podcast.mp3", failures.MediaFailures[1].URL)
	rec = f.do(f.admin, http.MethodGet, fmt.Sprintf("/api/v1/imports/%d/items?dropped=true", jobID), nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	var report struct {
		Items []ImportItemResponse `json:"items"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &report))
	require.Len(t, report.Items, 2)
	require.Equal(t, "post", report.Items[0].PostType)
	require.Equal(t, "published", report.Items[0].PostStatus)
	rec = f.do(f.admin, http.MethodGet, "/api/v1/imports", nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), fmt.Sprintf(`"id":%d`, jobID))

	// The editor's notice: editors read it and dismiss it.
	editor := f.user(RoleEditor, "imp-editor")
	rec = f.do(editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/import-notice", blocksPost.ID), nil, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var notice struct {
		Notice importNotice `json:"notice"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &notice))
	require.Len(t, notice.Notice.Dropped, 3)
	require.Equal(t, http.StatusForbidden, f.do(f.ana, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/import-notice", blocksPost.ID), nil, "").Code)
	rec = f.do(editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/import-notice/dismiss", blocksPost.ID), []byte(fmt.Sprintf(`{"item_id":%d}`, notice.Notice.ItemID)), "application/json")
	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Equal(t, http.StatusNotFound, f.do(editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/import-notice", blocksPost.ID), nil, "").Code)

	// Activity: each post "imported", the job started and finished.
	require.Equal(t, int64(4), f.scalar(`SELECT count(*) FROM activity WHERE verb = 'imported' AND object_type = 'post' AND (payload->>'import_id')::bigint = $1`, jobID))
	require.Equal(t, int64(1), f.scalar(`SELECT count(*) FROM activity WHERE verb = 'import_finished' AND object_id = $1`, jobID))

	// Running the same file again imports nothing twice and downloads nothing.
	rec = f.upload(f.admin, "again.xml", f.export())
	require.Equal(t, http.StatusCreated, rec.Code)
	again := decodeJob(t, rec)
	require.Equal(t, int64(4), *again.Import.ImportedBefore)
	f.start(again.Import.ID, `{"authors":{},"types":{"post":"post","page":"page"}}`)
	require.Equal(t, db.ImportJobDone, f.runUntilFinished(again.Import.ID).Status)
	for wpID, it := range f.items(again.Import.ID) {
		if wpID == 40 || wpID == 60 {
			continue
		}
		require.Equal(t, importReasonImportedBefore, it.Reason, "item %d", wpID)
		require.Equal(t, items[wpID].PostID.Int64, it.Result.PostID)
	}
	require.Equal(t, 1, f.hits["/wp-content/uploads/2024/05/bike.jpg"])

	// A finished job's report can be deleted; the posts stay.
	require.Equal(t, http.StatusNoContent, f.do(f.admin, http.MethodDelete, fmt.Sprintf("/api/v1/imports/%d", again.Import.ID), nil, "").Code)
	_, err = f.store.GetPost(ctx, classic.ID)
	require.NoError(t, err)
}

func TestImportMediaRefusesOtherHosts(t *testing.T) {
	f := newImportDBFixture(t, nil)
	ctx := context.Background()
	job, err := f.store.CreateImportJob(ctx, db.CreateImportJobParams{
		CreatedBy: sql.NullInt64{Int64: f.admin.ID, Valid: true}, Source: "wxr", FileName: "x.xml", SiteUrl: f.site.URL,
		Summary: []byte(`{}`), Terms: []byte(`[]`), Attachments: []byte(`{}`), Blocks: []byte(`{}`),
	})
	require.NoError(t, err)
	media := f.server.newImportJobMedia(ctx, f.server.logger, job, f.admin.ID)

	_, failure := media.resolve(importMediaRef{Kind: importMediaImage, URL: "https://cdn.other-host.net/x.png"})
	require.Equal(t, "other_host", failure.Code)
	_, failure = media.resolve(importMediaRef{Kind: importMediaImage, URL: f.site.URL + "/wp-content/uploads/away.jpg"})
	require.Equal(t, "redirect_refused", failure.Code, "a redirect may not leave the site")
	_, failure = media.resolve(importMediaRef{Kind: importMediaImage, URL: f.site.URL + "/wp-content/uploads/not-an-image.jpg"})
	require.Equal(t, "content_mismatch", failure.Code)
	_, failure = media.resolve(importMediaRef{Kind: importMediaImage, URL: f.site.URL + "/wp-content/uploads/2024/05/annual-report.pdf"})
	require.Equal(t, "wrong_kind", failure.Code, "an image block takes images only")
	_, failure = media.resolve(importMediaRef{Kind: importMediaImage, URL: "ftp://example.com/x.png"})
	require.Equal(t, "invalid_url", failure.Code)
	_, failure = media.resolve(importMediaRef{Kind: importMediaImage})
	require.Equal(t, "no_source", failure.Code)

	// A relative URL is the site's.
	item, failure := media.resolve(importMediaRef{Kind: importMediaImage, URL: "/wp-content/uploads/2024/05/market.jpg", Alt: "Stalls"})
	require.Nil(t, failure)
	got, err := f.store.GetMedia(ctx, item.ID)
	require.NoError(t, err)
	require.Equal(t, "Stalls", got.Alt)
}

func buildImportZip(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		fw, err := w.Create(name)
		require.NoError(t, err)
		_, _ = fw.Write(body)
	}
	require.NoError(t, w.Close())
	return buf.Bytes()
}

func TestImportMarkdownZip(t *testing.T) {
	f := newImportDBFixture(t, nil)
	ctx := context.Background()
	slug := "md-" + f.run
	data := buildImportZip(t, map[string][]byte{
		"site/posts/first.md":   []byte("---\nid: " + f.run + "\ntitle: First from Markdown\nslug: " + slug + "\ndate: 2023-01-02\ntags: [notes]\ncategories: [journal]\nimage: ../images/cover.png\naliases: [/old/" + slug + "/]\ndescription: The first one.\n---\n\nHello **there**.\n\n![Cover](../images/cover.png)\n\n![Remote](https://images.example.org/x.png)\n"),
		"site/images/cover.png": testPNG(t, 3, 3),
		"site/about.md":         []byte("---\ntitle: About " + f.run + "\ntype: page\ndraft: true\nid: about-" + f.run + "\n---\nAbout us.\n"),
	})
	rec := f.upload(f.admin, "notes.zip", data)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	job := decodeJob(t, rec)
	require.Equal(t, "markdown", job.Import.Summary.Source)
	require.Equal(t, 1, job.Import.Summary.Files)
	f.start(job.Import.ID, `{"types":{"post":"post","page":"page"}}`)
	require.Equal(t, db.ImportJobDone, f.runUntilFinished(job.Import.ID).Status)

	var postID int64
	require.NoError(t, f.conn.QueryRow(`SELECT post_id FROM import_items WHERE job_id = $1 AND source_key = $2`, job.Import.ID, "md:"+f.run).Scan(&postID))
	post, err := f.store.GetPost(ctx, postID)
	require.NoError(t, err)
	require.Equal(t, "First from Markdown", post.Title)
	require.Equal(t, slug, post.Slug)
	require.Equal(t, "published", post.PostStatus)
	require.Equal(t, time.Date(2023, 1, 2, 0, 0, 0, 0, time.UTC), post.CreatedAt.UTC())
	var doc BlockDocV1
	require.NoError(t, json.Unmarshal(post.BlockDoc, &doc))
	image := impAttrs(blocksOfType(doc, "image")[0])
	require.Equal(t, "Cover", image["alt"])
	// The same file as the featured image: one media item.
	require.Equal(t, image["mediaId"], float64(f.scalar(`SELECT media_id FROM post_media WHERE post_id = $1 AND "order" = 0`, postID).(int64)))
	redirect, err := f.store.GetRedirectByFromPath(ctx, "/old/"+slug)
	require.NoError(t, err)
	settings, err := f.store.GetSettings(ctx)
	require.NoError(t, err)
	require.Equal(t, postSitePath("post", slug, postID, settings.PostUrlStructure, "journal"), redirect.ToPath)
	var rawResult []byte
	require.NoError(t, f.conn.QueryRow(`SELECT result FROM import_items WHERE post_id = $1`, postID).Scan(&rawResult))
	var result importItemResult
	require.NoError(t, json.Unmarshal(rawResult, &result))
	require.Equal(t, "remote_file", result.MediaFailed[0].Code)

	// Again: skipped, by the front matter's id.
	rec = f.upload(f.admin, "notes.zip", data)
	again := decodeJob(t, rec)
	require.Equal(t, int64(2), *again.Import.ImportedBefore)
}

func TestImportStopAndFencing(t *testing.T) {
	f := newImportDBFixture(t, nil)
	ctx := context.Background()
	rec := f.upload(f.admin, "x.xml", f.export())
	require.Equal(t, http.StatusCreated, rec.Code)
	jobID := decodeJob(t, rec).Import.ID
	f.start(jobID, `{"types":{"post":"post"}}`)

	// Claim it as a replica would, then stop it: the claim's next write fails, nothing is
	// written.
	var job db.ImportJob
	for {
		claimed, err := f.store.ClaimImportJob(ctx)
		require.NoError(t, err)
		if claimed.ID == jobID {
			job = claimed
			break
		}
		f.server.runImportJob(ctx, claimed) // someone else's
	}
	rec = f.do(f.admin, http.MethodPost, fmt.Sprintf("/api/v1/imports/%d/cancel", jobID), nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, db.ImportJobCancelled, decodeJob(t, rec).Import.Status)
	f.server.runImportJob(ctx, job)
	require.Equal(t, int64(0), f.scalar(`SELECT count(*) FROM import_items WHERE job_id = $1 AND status = 'imported'`, jobID))
	require.Equal(t, http.StatusConflict, f.do(f.admin, http.MethodPost, fmt.Sprintf("/api/v1/imports/%d/cancel", jobID), nil, "").Code)

	// A lease that ran out goes to the next claim, with a new token; the old one is fenced.
	rec = f.upload(f.admin, "y.xml", f.export())
	jobID = decodeJob(t, rec).Import.ID
	f.start(jobID, `{"types":{"post":"post"}}`)
	var first db.ImportJob
	for {
		claimed, err := f.store.ClaimImportJob(ctx)
		require.NoError(t, err)
		if claimed.ID == jobID {
			first = claimed
			break
		}
		f.server.runImportJob(ctx, claimed)
	}
	_, err := f.conn.Exec(`UPDATE import_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, jobID)
	require.NoError(t, err)
	var second db.ImportJob
	for {
		claimed, err := f.store.ClaimImportJob(ctx)
		require.NoError(t, err)
		if claimed.ID == jobID {
			second = claimed
			break
		}
		f.server.runImportJob(ctx, claimed)
	}
	require.Greater(t, second.LeaseToken, first.LeaseToken)
	f.server.runImportJob(ctx, first) // the stale claim
	require.Equal(t, int64(0), f.scalar(`SELECT count(*) FROM import_items WHERE job_id = $1 AND status = 'imported'`, jobID))
	f.server.runImportJob(ctx, second)
	require.Equal(t, int64(2), f.scalar(`SELECT count(*) FROM import_items WHERE job_id = $1 AND status = 'imported'`, jobID))
}

func TestImportRoutesAndRefusals(t *testing.T) {
	f := newImportDBFixture(t, func(c *util.Config) { c.ImportMaxSize = "64KB" })
	editor := f.user(RoleEditor, "imp-editor")

	require.Equal(t, http.StatusForbidden, f.upload(editor, "x.xml", f.export()).Code)
	require.Equal(t, http.StatusForbidden, f.do(editor, http.MethodGet, "/api/v1/imports", nil, "").Code)
	require.Equal(t, http.StatusForbidden, f.do(f.ana, http.MethodGet, "/api/v1/imports/1", nil, "").Code)

	cases := []struct {
		name   string
		data   []byte
		status int
		code   string
	}{
		{"photo.jpg", testJPEG(t, 2, 2), http.StatusUnprocessableEntity, "not_an_export"},
		{"feed.xml", []byte(`<?xml version="1.0"?><rss><channel><title>x</title></channel></rss>`), http.StatusUnprocessableEntity, "not_wordpress"},
		{"evil.xml", []byte(`<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>`), http.StatusUnprocessableEntity, "unsafe_xml"},
		{"evil.zip", buildImportZip(t, map[string][]byte{"../escape.md": []byte("x")}), http.StatusUnprocessableEntity, "unsafe_zip"},
		{"big.xml", append([]byte(`<?xml version="1.0"?><rss>`), bytes.Repeat([]byte(" "), 80<<10)...), http.StatusRequestEntityTooLarge, "too_large"},
	}
	for _, tc := range cases {
		rec := f.upload(f.admin, tc.name, tc.data)
		require.Equal(t, tc.status, rec.Code, "%s: %s", tc.name, rec.Body.String())
		require.Contains(t, rec.Body.String(), `"code":"`+tc.code+`"`, tc.name)
	}

	rec := f.upload(f.admin, "small.xml", f.export())
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	jobID := decodeJob(t, rec).Import.ID
	for body, code := range map[string]string{
		`{"types":{"post":"` + strings.Repeat("x", 60) + `"}}`:        "types",
		`{"types":{"post":"nope"}}`:                                   "invalid_type",
		fmt.Sprintf(`{"authors":{"ana":%d},"types":{}}`, int64(9e15)): "invalid_author",
	} {
		rec := f.do(f.admin, http.MethodPost, fmt.Sprintf("/api/v1/imports/%d/start", jobID), []byte(body), "application/json")
		require.Equal(t, http.StatusBadRequest, rec.Code, body)
		require.Contains(t, rec.Body.String(), code)
	}
	subscriber := f.user("subscriber", "imp-sub")
	rec = f.do(f.admin, http.MethodPost, fmt.Sprintf("/api/v1/imports/%d/start", jobID), []byte(fmt.Sprintf(`{"authors":{"ana":%d},"types":{}}`, subscriber.ID)), "application/json")
	require.Equal(t, http.StatusBadRequest, rec.Code, "posts only go to members who write content")
	require.Equal(t, http.StatusNotFound, f.do(f.admin, http.MethodGet, "/api/v1/imports/999999999", nil, "").Code)
	require.Equal(t, http.StatusBadRequest, f.do(f.admin, http.MethodGet, "/api/v1/imports/x", nil, "").Code)
	require.Equal(t, http.StatusBadRequest, f.do(f.admin, http.MethodGet, fmt.Sprintf("/api/v1/imports/%d/items?status=odd", jobID), nil, "").Code)
	// Not started: deletable.
	require.Equal(t, http.StatusNoContent, f.do(f.admin, http.MethodDelete, fmt.Sprintf("/api/v1/imports/%d", jobID), nil, "").Code)
}

// Categories nest one level (#331), also when the export's parent is an existing category
// that is itself nested here: the new one goes under that one's top-level category.
func TestImportTermsKeepOneLevel(t *testing.T) {
	f := newImportDBFixture(t, nil)
	ctx := context.Background()
	category, err := f.store.GetTaxonomyType(ctx, db.CategoryTaxonomy)
	require.NoError(t, err)
	top, err := f.store.CreateTaxonomyTerm(ctx, db.CreateTaxonomyTermParams{Name: "Top", Slug: "imp-top-" + f.run, TaxonomyTypeID: category.ID})
	require.NoError(t, err)
	mid, err := f.store.CreateTaxonomyTerm(ctx, db.CreateTaxonomyTermParams{Name: "Mid", Slug: "imp-mid-" + f.run, TaxonomyTypeID: category.ID, ParentID: sql.NullInt64{Int64: top.ID, Valid: true}})
	require.NoError(t, err)

	ids, slugs := map[string]int64{}, map[int64]string{}
	skipped, err := f.server.importTerms(ctx, []importer.Term{
		{Taxonomy: "category", Slug: mid.Slug, Name: "Mid"},
		{Taxonomy: "category", Slug: "imp-leaf-" + f.run, Name: "Leaf", Parent: mid.Slug},
		{Taxonomy: "category", Slug: "", Name: "No slug"},
	}, ids, slugs)
	require.NoError(t, err)
	require.Zero(t, skipped)
	require.Equal(t, mid.ID, ids["category:"+mid.Slug], "the existing category is reused")
	leaf, err := f.store.GetTaxonomyTerm(ctx, ids["category:imp-leaf-"+f.run])
	require.NoError(t, err)
	require.Equal(t, top.ID, leaf.ParentID.Int64, "under the top-level category, not two levels deep")
}
