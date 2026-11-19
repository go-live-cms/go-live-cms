package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// The test stand-ins for the internet: `public` is a local httptest server the importer
// is allowed to reach (the test-only allowance, outbound_http.go); `private` is another
// local server that gets the real policy, like any internal service would. Every other
// address (169.254.169.254 included) gets the real policy too.

const importTestLimit = "8KB"

var importISOMedia = append([]byte{0, 0, 0, 0x18}, []byte("ftypisom\x00\x00\x02\x00isomiso2")...)

type importFixture struct {
	server      *Server
	store       *mockdb.MockStore
	public      *httptest.Server
	private     *httptest.Server
	privateHits atomic.Int32
	caller      db.User
	nextID      atomic.Int64
}

func newImportFixture(t *testing.T, configure func(*util.Config)) *importFixture {
	t.Helper()
	f := &importFixture{caller: db.User{ID: 9401, Username: "importer", Role: RoleContributor}}

	f.private = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.privateHits.Add(1)
		_, _ = w.Write(testPNG(t, 2, 2))
	}))
	t.Cleanup(f.private.Close)

	big := append(testPNG(t, 2, 2), bytes.Repeat([]byte{0}, 16<<10)...)
	mux := http.NewServeMux()
	serve := func(route string, body []byte) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) })
	}
	redirect := func(route, to string) {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, to, http.StatusFound) })
	}
	serve("/photo.png", testPNG(t, 4, 3))
	serve("/images/hero", testJPEG(t, 2, 2)) // no extension: sniffed
	serve("/clip.mp4", importISOMedia)
	serve("/report.pdf", []byte("%PDF-1.7\n%test\n"))
	serve("/big.png", big) // with a Content-Length over the limit
	serve("/page.html", []byte("<!DOCTYPE html><html><body>hi</body></html>"))
	serve("/fake.png", []byte("not an image at all"))
	serve("/drawing.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))
	serve("/empty", nil)
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="Annual Report.pdf"`)
		_, _ = w.Write([]byte("%PDF-1.4\n"))
	})
	mux.HandleFunc("/stream.png", func(w http.ResponseWriter, r *http.Request) {
		// No Content-Length (chunked): only the streamed cap can stop it.
		_, _ = w.Write(testPNG(t, 2, 2))
		w.(http.Flusher).Flush()
		for i := 0; i < 16; i++ {
			_, _ = w.Write(bytes.Repeat([]byte{0}, 1<<10))
			w.(http.Flusher).Flush()
		}
	})
	mux.HandleFunc("/missing", http.NotFound)
	redirect("/hop", "/photo.png")
	redirect("/loop", "/loop")
	redirect("/to-private", f.private.URL+"/secret.png")
	redirect("/to-metadata", "http://169.254.169.254/latest/meta-data/")
	redirect("/to-ftp", "ftp://files.example.com/photo.png")
	f.public = httptest.NewServer(mux)
	t.Cleanup(f.public.Close)

	allowed := netip.MustParseAddrPort(f.public.Listener.Addr().String())

	ctrl := gomock.NewController(t)
	f.store = mockdb.NewMockStore(ctrl)
	f.server = newRateLimitedTestServer(t, f.store, func(config *util.Config) {
		config.MaxUploadSize = importTestLimit
		if configure != nil {
			configure(config)
		}
	})
	f.server.mediaImport = newMediaImporter(func(ap netip.AddrPort) bool { return ap == allowed })
	stubRoleLookup(f.store, f.caller)
	f.store.EXPECT().CreateMedia(gomock.Any(), gomock.Any()).AnyTimes().DoAndReturn(func(_ any, arg db.CreateMediaParams) (db.Medium, error) {
		return db.Medium{
			ID: f.nextID.Add(1), Name: arg.Name, Description: arg.Description, Alt: arg.Alt, MediaPath: arg.MediaPath,
			UserID: arg.UserID, FileSize: arg.FileSize, MimeType: arg.MimeType, Width: arg.Width, Height: arg.Height,
			OriginalFilename: arg.OriginalFilename, CreatedAt: time.Now(), ChangedAt: time.Now(),
		}, nil
	})
	return f
}

type importResponse struct {
	Results []struct {
		URL    string         `json:"url"`
		Status string         `json:"status"`
		Media  *MediaResponse `json:"media"`
		Code   string         `json:"code"`
		Error  string         `json:"error"`
	} `json:"results"`
	Meta struct {
		Total      int `json:"total"`
		Successful int `json:"successful"`
		Failed     int `json:"failed"`
	} `json:"meta"`
}

func (f *importFixture) post(t *testing.T, body any, signedIn bool) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/media/import", bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	if signedIn {
		addAuthorization(t, request, f.server.tokenMaker, authorizationTypeBearer, f.caller.ID, f.caller.Username, time.Minute)
	}
	recorder := httptest.NewRecorder()
	f.server.router.ServeHTTP(recorder, request)
	return recorder
}

func (f *importFixture) importURLs(t *testing.T, urls ...string) importResponse {
	t.Helper()
	recorder := f.post(t, gin.H{"urls": urls}, true)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var rsp importResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Len(t, rsp.Results, len(urls))
	return rsp
}

func TestImportMediaCreatesNormalMedia(t *testing.T) {
	f := newImportFixture(t, nil)
	rsp := f.importURLs(t,
		f.public.URL+"/photo.png?token=s3cret",
		f.public.URL+"/images/hero",
		f.public.URL+"/clip.mp4",
		f.public.URL+"/report.pdf",
		f.public.URL+"/download?id=7",
		f.public.URL+"/hop",
	)
	require.Equal(t, 6, rsp.Meta.Successful, rsp)
	require.Zero(t, rsp.Meta.Failed)

	want := []struct{ mime, filename string }{
		{"image/png", "photo.png"},
		{"image/jpeg", "hero.jpg"}, // the extension its content sniffs as
		{"video/mp4", "clip.mp4"},
		{"application/pdf", "report.pdf"},
		{"application/pdf", "Annual_Report.pdf"}, // Content-Disposition's name, cleaned
		{"image/png", "photo.png"},               // the name after the redirect
	}
	for i, w := range want {
		r := rsp.Results[i]
		require.Equal(t, "added", r.Status, r.Error)
		require.NotNil(t, r.Media)
		require.Equal(t, w.mime, r.Media.MimeType)
		require.Equal(t, w.filename, r.Media.OriginalFilename)
		require.Equal(t, f.caller.ID, r.Media.UserID)
		require.Empty(t, r.Media.Alt)
		require.Equal(t, "Imported from 127.0.0.1", r.Media.Description)
		// Stored like an upload: under /uploads with an unguessable name (#399).
		require.True(t, strings.HasPrefix(r.Media.MediaPath, "/uploads/media/"), r.Media.MediaPath)
		require.Regexp(t, `-[0-9a-f]{32}\.[a-z0-9]+$`, r.Media.MediaPath)
	}
	require.Equal(t, int32(4), *rsp.Results[0].Media.Width)
	require.Equal(t, int32(3), *rsp.Results[0].Media.Height)
	require.Len(t, uploadedFiles(t, f.server), 6)

	// One "imported" event per file, with the kind and the host only: never the path or
	// the query (which here holds a token).
	events := activityOf(t, f.server).events
	require.Len(t, events, 6)
	for _, e := range events {
		require.Equal(t, db.ActivityImported, e.Verb)
		require.Equal(t, db.ActivityObjectMedia, e.ObjectType)
		var payload map[string]any
		require.NoError(t, json.Unmarshal(e.Payload, &payload))
		require.Equal(t, "127.0.0.1", payload["host"])
		require.NotContains(t, string(e.Payload), "s3cret")
		require.NotContains(t, string(e.Payload), "photo")
		require.Len(t, payload, 2)
	}
}

func TestImportMediaRefusals(t *testing.T) {
	f := newImportFixture(t, nil)
	testCases := []struct {
		name string
		url  string
		code string
	}{
		{"PrivateAddress", f.private.URL + "/secret.png", "address_refused"},
		{"LoopbackName", strings.Replace(f.private.URL, "127.0.0.1", "localhost", 1) + "/secret.png", "address_refused"},
		{"MetadataAddress", "http://169.254.169.254/latest/meta-data/", "address_refused"},
		{"RedirectToPrivate", f.public.URL + "/to-private", "address_refused"},
		{"RedirectToMetadata", f.public.URL + "/to-metadata", "address_refused"},
		{"RedirectToFTP", f.public.URL + "/to-ftp", "redirect_refused"},
		{"RedirectLoop", f.public.URL + "/loop", "too_many_redirects"},
		{"Oversized", f.public.URL + "/big.png", "too_large"},
		{"OversizedStreamed", f.public.URL + "/stream.png", "too_large"},
		{"WrongTypeHTML", f.public.URL + "/page.html", "unsupported_type"},
		{"WrongTypeSVG", f.public.URL + "/drawing.svg", "unsupported_type"},
		{"ContentMismatch", f.public.URL + "/fake.png", "content_mismatch"},
		{"Empty", f.public.URL + "/empty", "empty_file"},
		{"NotFound", f.public.URL + "/missing", "status"},
		{"NotHTTP", "ftp://files.example.com/photo.png", "invalid_url"},
		{"FileScheme", "file:///etc/passwd", "invalid_url"},
		{"NotAURL", "photo.png", "invalid_url"},
		{"Credentials", strings.Replace(f.public.URL, "http://", "http://user:pw@", 1) + "/photo.png", "credentials_in_url"},
	}
	urls := make([]string, 0, len(testCases))
	for _, tc := range testCases {
		urls = append(urls, tc.url)
	}
	// Ten links a request at most.
	for start := 0; start < len(urls); start += mediaImportMaxURLs {
		end := min(start+mediaImportMaxURLs, len(urls))
		rsp := f.importURLs(t, urls[start:end]...)
		for i, r := range rsp.Results {
			tc := testCases[start+i]
			require.Equal(t, "failed", r.Status, tc.name)
			require.Equal(t, tc.code, r.Code, tc.name)
			require.NotEmpty(t, r.Error, tc.name)
			require.Nil(t, r.Media, tc.name)
			// The message never repeats the link.
			require.NotContains(t, r.Error, "127.0.0.1", tc.name)
		}
	}
	require.Zero(t, f.privateHits.Load(), "the private server was reached")
	require.Empty(t, uploadedFiles(t, f.server), "a refused download left a file")
	require.Empty(t, activityOf(t, f.server).events)
}

func TestImportMediaPerURLResults(t *testing.T) {
	f := newImportFixture(t, nil)
	good := f.public.URL + "/photo.png"
	rsp := f.importURLs(t, good, f.private.URL+"/x.png", "  "+good+"  ")
	require.Equal(t, 3, rsp.Meta.Total)
	require.Equal(t, 2, rsp.Meta.Successful)
	require.Equal(t, 1, rsp.Meta.Failed)
	require.Equal(t, "added", rsp.Results[0].Status)
	require.Equal(t, "failed", rsp.Results[1].Status)
	// A repeated link is fetched once and shares its result.
	require.Equal(t, "added", rsp.Results[2].Status)
	require.Equal(t, rsp.Results[0].Media.ID, rsp.Results[2].Media.ID)
	require.Len(t, uploadedFiles(t, f.server), 1)
}

func TestImportMediaRealPolicyRefusesLocalServers(t *testing.T) {
	// Without the test allowance (NewServer's importer), the "public" server is just
	// another loopback address.
	f := newImportFixture(t, nil)
	f.server.mediaImport = newMediaImporter(nil)
	rsp := f.importURLs(t, f.public.URL+"/photo.png")
	require.Equal(t, "address_refused", rsp.Results[0].Code)
}

func TestImportMediaRequestValidation(t *testing.T) {
	f := newImportFixture(t, nil)
	require.Equal(t, http.StatusUnauthorized, f.post(t, gin.H{"urls": []string{f.public.URL + "/photo.png"}}, false).Code)
	require.Equal(t, http.StatusBadRequest, f.post(t, gin.H{"urls": []string{}}, true).Code)
	require.Equal(t, http.StatusBadRequest, f.post(t, gin.H{}, true).Code)
	require.Equal(t, http.StatusBadRequest, f.post(t, gin.H{"urls": make([]string, mediaImportMaxURLs+1)}, true).Code)
	require.Equal(t, http.StatusBadRequest, f.post(t, gin.H{"urls": []string{"https://example.com/" + strings.Repeat("a", 2048)}}, true).Code)
	require.Equal(t, http.StatusBadRequest, f.post(t, gin.H{"urls": []string{"https://example.com/a.png"}, "hotlink": true}, true).Code)
	require.Empty(t, uploadedFiles(t, f.server))
}

func TestImportMediaRateLimit(t *testing.T) {
	f := newImportFixture(t, func(config *util.Config) { config.RateLimitMediaImportPerMinute = 1 })
	f.importURLs(t, f.public.URL+"/photo.png")
	recorder := f.post(t, gin.H{"urls": []string{f.public.URL + "/photo.png"}}, true)
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	require.NotEmpty(t, recorder.Header().Get("Retry-After"))
	require.Len(t, uploadedFiles(t, f.server), 1)
}

func TestSniffedImportExtension(t *testing.T) {
	iso := func(brand string) []byte {
		return append([]byte{0, 0, 0, 0x18}, []byte("ftyp"+brand+"\x00\x00\x02\x00isom")...)
	}
	testCases := map[string][]byte{
		".jpg":  testJPEG(t, 2, 2),
		".png":  testPNG(t, 2, 2),
		".gif":  []byte("GIF89a\x01\x00\x01\x00"),
		".pdf":  []byte("%PDF-1.7\n"),
		".mp4":  iso("isom"),
		".mov":  iso("qt  "),
		".m4a":  iso("M4A "),
		".mp3":  []byte("ID3\x04\x00\x00\x00\x00\x00\x00"),
		".webm": []byte("\x1A\x45\xDF\xA3\x01\x00\x00\x00"),
		".vtt":  []byte("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n"),
		".doc":  []byte("\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1rest"),
		"":      []byte("plain words need their .txt extension"),
	}
	for want, head := range testCases {
		require.Equal(t, want, sniffedImportExtension(head), want)
	}

	// An allowed extension must agree with the content; any other name is sniffed.
	ext, err := importExtension("photo.php", testPNG(t, 2, 2))
	require.NoError(t, err)
	require.Equal(t, ".png", ext)
	_, err = importExtension("photo.jpg", testPNG(t, 2, 2))
	require.ErrorIs(t, err, importMismatch)
	_, err = importExtension("archive.zip", []byte("PK\x03\x04"))
	require.ErrorIs(t, err, importUnsupported)
	ext, err = importExtension("notes.txt", []byte("hello"))
	require.NoError(t, err)
	require.Equal(t, ".txt", ext)
}
