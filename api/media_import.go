package api

// POST /media/import (#29): "Add from URL" in the media library and the media picker.
// The API downloads each file and stores it exactly like an upload (the type allowlist
// with sniffed content, MAX_UPLOAD_SIZE, unguessable stored names, metadata stripping
// and variants), so an imported file is a normal media item. Nothing is hotlinked: a
// link would skip that processing and the backups, and break when its source goes.
//
// This is an outbound request made on a user's behalf with a URL the user chooses, so
// it is SSRF surface from end to end:
//
//   - http and https only, no user name or password in the URL, at most 2048 characters,
//     at most mediaImportMaxURLs per request.
//   - The dialer is the shared guard's (outbound_http.go): every connection, the first
//     and every redirect's, is refused unless its address (after DNS) is public. So a
//     name that resolves to a private, loopback, link-local, CGNAT or metadata address,
//     and a redirect to one, never connects, and DNS rebinding can't get around it.
//   - At most mediaImportMaxRedirects redirects, each to http(s) and checked like the
//     first URL. No proxy from the environment, no cookies, no keep-alives.
//   - mediaImportConnectTimeout for the dial and TLS, mediaImportHeaderTimeout for the
//     answer's headers, mediaImportTimeout for the whole download, capped headers.
//   - The body is streamed into the upload directory and cut off past MAX_UPLOAD_SIZE
//     (a Content-Length over it is refused before reading); a partial file never stays.
//   - The type is the file's own bytes: the link's extension (or the Content-Disposition
//     name's) picks a kind that the content must match, as for uploads; a name without
//     an allowed extension gets the one its content sniffs as, if any. The server's
//     Content-Type is never used.
//   - Rate limited per member and client (RATE_LIMIT_MEDIA_IMPORT_PER_MINUTE).
//   - Neither the URL nor Go's error text (which holds it) is logged or stored: each
//     failure is a fixed code and message, and the activity log keeps the host only.
//
// Each URL gets its own result (added with the media, or failed with a reason), so one
// bad link doesn't sink the rest.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	// mediaImportMaxURLs is the most links one request may carry (the dialog says so;
	// ImportMediaRequest's binding has the same 10, and 2048 characters a link).
	mediaImportMaxURLs = 10
	// mediaImportParallel is how many links of one request download at once.
	mediaImportParallel = 4
	// mediaImportMaxRedirects is how many redirects one link may follow.
	mediaImportMaxRedirects = 5

	mediaImportConnectTimeout = 5 * time.Second
	mediaImportHeaderTimeout  = 15 * time.Second
	// mediaImportTimeout bounds one link's whole exchange, the body included.
	mediaImportTimeout        = 60 * time.Second
	mediaImportMaxHeaderBytes = 64 << 10
	mediaImportUserAgent      = "GoLive-CMS (media import)"
)

// importFailure is a link that couldn't be added: a fixed code the admin may branch on
// and a message it shows. Neither holds the URL, so both are safe to log and return.
type importFailure struct {
	Code    string
	Message string
}

func (f importFailure) Error() string { return f.Message }

var (
	importInvalidURL     = importFailure{"invalid_url", "Not a link starting with http:// or https://"}
	importCredentials    = importFailure{"credentials_in_url", "Links with a user name or password can't be added"}
	importAddressRefused = importFailure{"address_refused", "The link points to a private or local address"}
	importTooManyHops    = importFailure{"too_many_redirects", "The link redirects too many times"}
	importBadRedirect    = importFailure{"redirect_refused", "The link redirects to an address that isn't http or https"}
	importTimedOut       = importFailure{"timeout", "The download timed out"}
	importNetwork        = importFailure{"network", "The file couldn't be downloaded"}
	importUnsupported    = importFailure{"unsupported_type", "This kind of file can't be added"}
	importMismatch       = importFailure{"content_mismatch", "The file's content doesn't match its type"}
	importEmpty          = importFailure{"empty_file", "The link returned an empty file"}
	importSaveFailed     = importFailure{"save_failed", "The file couldn't be saved"}
)

func importStatusFailure(status int) importFailure {
	return importFailure{"status", fmt.Sprintf("The server answered %d", status)}
}

func (server *Server) importTooLarge() importFailure {
	limit := server.config.MaxUploadSize
	if limit == "" {
		limit = "10MB"
	}
	return importFailure{"too_large", "The file is larger than " + limit}
}

// mediaImporter is the import's HTTP client under the policy above.
type mediaImporter struct {
	client *http.Client
}

// newMediaImporter builds the importer. allowAddress is for tests only (a local
// httptest server standing in for a public host, outbound_http.go); NewServer passes nil.
func newMediaImporter(allowAddress func(netip.AddrPort) bool) *mediaImporter {
	transport := newPublicOnlyTransport(outboundTransportOptions{
		connectTimeout: mediaImportConnectTimeout,
		headerTimeout:  mediaImportHeaderTimeout,
		maxHeaderBytes: mediaImportMaxHeaderBytes,
		allowAddress:   allowAddress,
	})
	return &mediaImporter{client: &http.Client{
		Transport:     transport,
		Timeout:       mediaImportTimeout,
		CheckRedirect: checkImportRedirect,
	}}
}

// defaultMediaImporter is the strict importer, for a Server built by hand (tests).
var defaultMediaImporter = sync.OnceValue(func() *mediaImporter { return newMediaImporter(nil) })

func (server *Server) importer() *mediaImporter {
	if server.mediaImport != nil {
		return server.mediaImport
	}
	return defaultMediaImporter()
}

// importURLProblem checks a link (the first or a redirect's) before anything is sent.
// The address it resolves to is the dialer's to check, at connect time.
func importURLProblem(u *url.URL) error {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.Opaque != "" {
		return importInvalidURL
	}
	if u.User != nil {
		return importCredentials
	}
	return nil
}

func checkImportRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > mediaImportMaxRedirects {
		return importTooManyHops
	}
	switch err := importURLProblem(req.URL); {
	case err == nil:
		return nil
	case errors.Is(err, importCredentials):
		return importCredentials
	default:
		return importBadRedirect
	}
}

// requestFailure maps a failed client.Do to its fixed failure.
func requestFailure(err error) importFailure {
	var failure importFailure
	switch {
	case errors.As(err, &failure):
		return failure
	case errors.Is(err, errAddressRefused):
		return importAddressRefused
	case isTimeout(err):
		return importTimedOut
	default:
		return importNetwork
	}
}

// importedFile is a download stored in the upload directory, not yet a media row.
type importedFile struct {
	mediaPath        string
	originalFilename string
	mimeType         string
	size             int64
}

// download fetches one link into uploadPath, validated like an upload.
func (im *mediaImporter) download(ctx context.Context, u *url.URL, uploadPath string, maxBytes int64, tooLarge importFailure) (importedFile, error) {
	// The client's Timeout (mediaImportTimeout) bounds the whole exchange, body included.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return importedFile{}, importInvalidURL
	}
	req.Header.Set("User-Agent", mediaImportUserAgent)
	req.Header.Set("Accept", "*/*")

	resp, err := im.client.Do(req)
	if err != nil {
		return importedFile{}, requestFailure(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return importedFile{}, importStatusFailure(resp.StatusCode)
	}
	if resp.ContentLength > maxBytes {
		return importedFile{}, tooLarge
	}

	head := make([]byte, sniffLen)
	n, err := io.ReadFull(resp.Body, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return importedFile{}, requestFailure(err)
	}
	head = head[:n]
	if n == 0 {
		return importedFile{}, importEmpty
	}

	name := importFileName(resp)
	ext, err := importExtension(name, head)
	if err != nil {
		return importedFile{}, err
	}
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	if stem == "" {
		stem = "imported"
	}
	originalFilename := cleanUploadFilename(stem + ext)

	// One byte past the limit is read, so a body that is too long is told apart from one
	// exactly at it.
	body := &readErrorTracker{r: io.MultiReader(bytes.NewReader(head), io.LimitReader(resp.Body, maxBytes-int64(n)+1))}
	mediaPath, err := saveUploadedFile(body, originalFilename, uploadPath)
	if err != nil {
		// saveUploadedFile leaves nothing behind on a failed write. A failed read is the
		// download's fault (cut off, timed out); anything else is the disk's.
		if body.err != nil {
			return importedFile{}, requestFailure(body.err)
		}
		return importedFile{}, importSaveFailed
	}
	info, err := os.Stat(mediaPath)
	if err != nil {
		os.Remove(mediaPath)
		return importedFile{}, importSaveFailed
	}
	if info.Size() > maxBytes {
		os.Remove(mediaPath)
		return importedFile{}, tooLarge
	}
	return importedFile{
		mediaPath:        mediaPath,
		originalFilename: originalFilename,
		mimeType:         allowedMediaTypes[strings.ToLower(ext)].mime,
		size:             info.Size(),
	}, nil
}

// readErrorTracker remembers the error a read failed with (io.EOF is no error).
type readErrorTracker struct {
	r   io.Reader
	err error
}

func (t *readErrorTracker) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		t.err = err
	}
	return n, err
}

// importFileName is the file's readable name: Content-Disposition's filename, else the
// last segment of the final URL's path (after redirects). Only a name: the type comes
// from the content (importExtension), and the stored name is made unguessable.
func importFileName(resp *http.Response) string {
	if _, params, err := mime.ParseMediaType(resp.Header.Get("Content-Disposition")); err == nil {
		if name := path.Base(strings.ReplaceAll(params["filename"], `\`, "/")); name != "" && name != "." && name != "/" {
			return name
		}
	}
	if resp.Request != nil && resp.Request.URL != nil {
		if name := path.Base(resp.Request.URL.Path); name != "" && name != "." && name != "/" {
			return name
		}
	}
	return ""
}

// importExtension is the extension to store the file under. An allowed extension on the
// name must agree with the content, as for an upload; a name without one gets the
// extension its content sniffs as (sniffedImportExtension), if it is unambiguous.
func importExtension(name string, head []byte) (string, error) {
	ext := strings.ToLower(filepath.Ext(name))
	if kind, ok := allowedMediaTypes[ext]; ok {
		if !kind.sniff(head) {
			return "", importMismatch
		}
		return ext, nil
	}
	sniffed := sniffedImportExtension(head)
	if sniffed == "" {
		return "", importUnsupported
	}
	if kind := allowedMediaTypes[sniffed]; !kind.sniff(head) {
		return "", importUnsupported
	}
	return sniffed, nil
}

// sniffedImportExtension names the allowed extension a file's leading bytes identify,
// or "" when they don't identify one for sure: plain text (anything readable), DOCX (any
// ZIP) and MKV (WebM's header) need their extension in the link.
func sniffedImportExtension(head []byte) string {
	if isISOBaseMedia(head) {
		switch string(head[8:12]) {
		case "qt  ":
			return ".mov"
		case "M4A ", "M4B ":
			return ".m4a"
		default:
			return ".mp4"
		}
	}
	if isWebVTT(head) {
		return ".vtt"
	}
	if allowedMediaTypes[".doc"].sniff(head) {
		return ".doc"
	}
	if bytes.HasPrefix(head, []byte("ID3")) {
		return ".mp3"
	}
	detected, _, _ := strings.Cut(http.DetectContentType(head), ";")
	switch detected {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	case "application/pdf":
		return ".pdf"
	case "video/webm":
		return ".webm"
	case "video/avi":
		return ".avi"
	case "audio/wave":
		return ".wav"
	case "application/ogg":
		return ".ogg"
	}
	return ""
}

// ImportMediaRequest is POST /media/import's body. Each link is checked on its own (a bad
// one is a failed result, not a 400 for all of them).
type ImportMediaRequest struct {
	URLs []string `json:"urls" binding:"required,min=1,max=10,dive,max=2048"`
}

// importResult is one link's outcome.
type importResult struct {
	URL    string         `json:"url"`
	Status string         `json:"status"` // "added" | "failed"
	Media  *MediaResponse `json:"media,omitempty"`
	Code   string         `json:"code,omitempty"`
	Error  string         `json:"error,omitempty"`
}

// importMedia handles POST /media/import: {urls} → {results, meta}, one result per link
// in the order given (a repeated link is fetched once and shares its result). 200 even
// when every link failed: the request itself was fine.
func (server *Server) importMedia(c *gin.Context) {
	var req ImportMediaRequest
	if !bindJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	// Per member and client, like edit access requests: each link is a download.
	if !server.rateLimits.mediaImport.allow(c, strconv.FormatInt(caller.ID, 10)+"|"+clientKey(c.ClientIP())) {
		return
	}

	log := server.requestLog(c)
	ctx := c.Request.Context()

	unique := make([]string, 0, len(req.URLs))
	seen := map[string]int{}
	for _, raw := range req.URLs {
		raw = strings.TrimSpace(raw)
		if _, dup := seen[raw]; !dup {
			seen[raw] = len(unique)
			unique = append(unique, raw)
		}
	}

	type outcome struct {
		media db.Medium
		host  string
		err   error
	}
	outcomes := make([]outcome, len(unique))
	slots := make(chan struct{}, mediaImportParallel)
	var wg sync.WaitGroup
	for i, raw := range unique {
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			media, host, err := server.importOne(ctx, log, raw, caller.ID)
			outcomes[i] = outcome{media, host, err}
		}()
	}
	wg.Wait()

	results := make([]importResult, len(req.URLs))
	added := 0
	for i, raw := range req.URLs {
		o := outcomes[seen[strings.TrimSpace(raw)]]
		results[i] = importResult{URL: raw}
		if o.err != nil {
			var failure importFailure
			if !errors.As(o.err, &failure) {
				failure = importSaveFailed
			}
			results[i].Status, results[i].Code, results[i].Error = "failed", failure.Code, failure.Message
			continue
		}
		response := server.mediaResponse(o.media)
		results[i].Status, results[i].Media = "added", &response
		added++
	}
	// After every download, from this goroutine: one event per file added, with its kind
	// and the host it came from, never the URL (its path and query may carry a token).
	for _, o := range outcomes {
		if o.err == nil {
			server.recordRequestActivity(c, activityEvent{
				Verb:       db.ActivityImported,
				ObjectType: db.ActivityObjectMedia,
				ObjectID:   o.media.ID,
				Payload:    map[string]any{"mime_type": o.media.MimeType, "host": o.host},
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"results": results,
		"meta": gin.H{
			"total":      len(results),
			"successful": added,
			"failed":     len(results) - added,
		},
	})
}

// importOne downloads one link and creates its media row. The host is returned for the
// activity log. Failures are logged by code only.
func (server *Server) importOne(ctx context.Context, log *slog.Logger, raw string, userID int64) (db.Medium, string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return db.Medium{}, "", importInvalidURL
	}
	if err := importURLProblem(u); err != nil {
		return db.Medium{}, "", err
	}
	host := strings.ToLower(u.Hostname())

	file, err := server.importer().download(ctx, u, server.config.UploadPath, server.maxUploadBytes, server.importTooLarge())
	if err != nil {
		var failure importFailure
		if errors.As(err, &failure) {
			log.Info("media_import_failed", "reason", failure.Code)
		}
		return db.Medium{}, host, err
	}

	var width, height int32
	if isImageFile(file.mediaPath) {
		if w, h, err := getImageDimensions(file.mediaPath); err == nil {
			width, height = w, h
		}
	}
	// Metadata stripped and variants generated, as for an upload (#255).
	fileSize, staged := prepareStoredImage(log, server.config.UploadPath, file.mediaPath, file.mimeType, file.size, nil)

	media, err := server.store.CreateMedia(ctx, db.CreateMediaParams{
		Name:        strings.TrimSuffix(file.originalFilename, filepath.Ext(file.originalFilename)),
		Description: "Imported from " + host,
		// No alt text (#325): the link says nothing about the image.
		Alt:              "",
		MediaPath:        file.mediaPath,
		FileSize:         fileSize,
		MimeType:         file.mimeType,
		Width:            width,
		Height:           height,
		UserID:           userID,
		OriginalFilename: file.originalFilename,
		Variants:         staged.commitForNewRow(log),
	})
	if err != nil {
		os.Remove(file.mediaPath)
		if rmErr := removeMediaVariants(server.config.UploadPath, file.mediaPath); rmErr != nil {
			log.Warn("media not created but variants not removed", "media_path", file.mediaPath, "error", rmErr)
		}
		log.Warn("media_import_failed", "reason", "create_media", "error", err)
		return db.Medium{}, host, importSaveFailed
	}
	return media, host, nil
}
