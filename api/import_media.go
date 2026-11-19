package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/importer"
)

// The importer's media (#150). A post's images (and video, audio, files) become library
// items through #29's download path and the upload pipeline (saveImportBody: the type is
// the file's bytes, MAX_UPLOAD_SIZE, unguessable names; createImportedMedia: metadata
// stripped, variants), never hotlinked:
//   - WordPress: only from the export's own site (its host, with or without "www."), over
//     the shared outbound guard (outbound_http.go: public addresses only, at connect time),
//     and a redirect may only stay on that host. An image is fetched at its original size
//     (the attachment's URL), not the resized copy the post shows.
//   - Markdown: only the zip's own files (import_files), found from the post's folder.
// Each file is recorded in import_media by where it came from, so a resumed or repeated
// import reuses it. A failure is a fixed code and message in the post's report, never
// fatal; the URL is in the report (the admin's own export) but never in a log line.

var (
	importOtherHost       = importFailure{"other_host", "Images are only downloaded from the export’s own site"}
	importNotInZip        = importFailure{"not_in_zip", "The zip doesn’t have this file"}
	importRemoteFile      = importFailure{"remote_file", "Files from other sites aren’t downloaded: add them from the media library"}
	importWrongKind       = importFailure{"wrong_kind", "The file isn’t the kind the block shows"}
	importNoSource        = importFailure{"no_source", "The export doesn’t say where this file is"}
	importOffSiteRedirect = importFailure{"redirect_refused", "The link redirects to another site"}
)

// siteHost is a host compared without a leading "www.".
func siteHost(host string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSuffix(host, ".")), "www.")
}

// siteImporter is the media importer's client, but a redirect must stay on host.
func (server *Server) siteImporter(host string) *mediaImporter {
	base := server.importer().client
	return &mediaImporter{client: &http.Client{
		Transport: base.Transport,
		Timeout:   base.Timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if err := checkImportRedirect(req, via); err != nil {
				return err
			}
			if siteHost(req.URL.Hostname()) != host {
				return importOffSiteRedirect
			}
			return nil
		},
	}}
}

// importJobMedia resolves one job's files. It is used by one goroutine at a time.
type importJobMedia struct {
	server *Server
	ctx    context.Context
	log    *slog.Logger
	job    db.ImportJob
	// userID owns the media rows (the member who started the import).
	userID      int64
	site        *url.URL
	host        string
	attachments map[int64]importer.Attachment
	// byURL finds an attachment from a URL a post shows (its own, or a resized copy's).
	byURL map[string]int64
	// dir is the current Markdown file's folder.
	dir string
}

var resizedSuffix = regexp.MustCompile(`-\d{1,5}x\d{1,5}(\.[A-Za-z0-9]{2,5})$`)

func (server *Server) newImportJobMedia(ctx context.Context, log *slog.Logger, job db.ImportJob, userID int64) *importJobMedia {
	m := &importJobMedia{server: server, ctx: ctx, log: log, job: job, userID: userID, attachments: map[int64]importer.Attachment{}, byURL: map[string]int64{}}
	_ = json.Unmarshal(job.Attachments, &m.attachments)
	if u, err := url.Parse(job.SiteUrl); err == nil && u.Hostname() != "" {
		m.site, m.host = u, siteHost(u.Hostname())
	}
	for id, a := range m.attachments {
		if a.URL != "" {
			m.byURL[normalizeMediaURL(a.URL)] = id
		}
	}
	return m
}

// normalizeMediaURL compares URLs without their scheme, query and a "www." host.
func normalizeMediaURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return raw
	}
	return siteHost(u.Hostname()) + u.EscapedPath()
}

func (m *importJobMedia) resolve(ref importMediaRef) (importedMediaItem, *importMediaFailure) {
	if m.job.Source == importer.SourceMarkdown {
		return m.resolveZip(ref)
	}
	return m.resolveSite(ref)
}

func failureOf(raw string, err error) *importMediaFailure {
	var f importFailure
	if !errors.As(err, &f) {
		f = importSaveFailed
	}
	return &importMediaFailure{URL: displayURL(raw), Code: f.Code, Reason: f.Message}
}

// displayURL is a URL as the report shows it: host and path, no query (it may hold a token).
func displayURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return truncateRunes(raw, 300)
	}
	return truncateRunes(u.Host+u.Path, 300)
}

func (m *importJobMedia) resolveSite(ref importMediaRef) (importedMediaItem, *importMediaFailure) {
	alt := ref.Alt
	raw := ref.URL
	id := ref.AttachmentID
	if id == 0 && raw != "" {
		key := normalizeMediaURL(raw)
		if found, ok := m.byURL[key]; ok {
			id = found
		} else if found, ok := m.byURL[resizedSuffix.ReplaceAllString(key, "$1")]; ok {
			id = found
		}
	}
	name := ""
	if a, ok := m.attachments[id]; ok && id != 0 {
		if a.URL != "" {
			raw = a.URL
		}
		alt = firstNonEmptyString(alt, a.Alt)
		name = a.Title
	}
	if raw == "" {
		return importedMediaItem{}, &importMediaFailure{Code: importNoSource.Code, Reason: importNoSource.Message}
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return importedMediaItem{}, failureOf(raw, importInvalidURL)
	}
	if m.site != nil && !u.IsAbs() {
		u = m.site.ResolveReference(u)
	}
	if err := importURLProblem(u); err != nil {
		return importedMediaItem{}, failureOf(raw, err)
	}
	if m.host == "" || siteHost(u.Hostname()) != m.host {
		return importedMediaItem{}, failureOf(u.String(), importOtherHost)
	}
	key := u.Scheme + "://" + strings.ToLower(u.Host) + u.EscapedPath()
	if u.RawQuery != "" {
		key += "?" + u.RawQuery
	}
	if media, err := m.server.store.GetImportMedia(m.ctx, key); err == nil {
		return m.item(media, ref.Kind, alt)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return importedMediaItem{}, failureOf(u.String(), importSaveFailed)
	}
	file, err := m.server.siteImporter(m.host).download(m.ctx, u, m.server.config.UploadPath, m.server.maxUploadBytes, m.server.importTooLarge())
	if err != nil {
		var f importFailure
		if errors.As(err, &f) {
			m.log.Info("import_media_failed", "reason", f.Code)
		}
		return importedMediaItem{}, failureOf(u.String(), err)
	}
	return m.store(file, key, ref.Kind, name, alt, "Imported from "+u.Hostname(), u.String())
}

// zipCandidates are where a Markdown file's reference may be in the zip.
func (m *importJobMedia) zipCandidates(ref string) []string {
	ref = strings.SplitN(strings.SplitN(ref, "#", 2)[0], "?", 2)[0]
	if decoded, err := url.PathUnescape(ref); err == nil {
		ref = decoded
	}
	if strings.HasPrefix(ref, "/") {
		root := strings.TrimPrefix(ref, "/")
		return []string{path.Clean(root), path.Clean("static/" + root), path.Clean("public/" + root), path.Clean(path.Join(m.dir, root))}
	}
	return []string{path.Clean(path.Join(m.dir, ref)), path.Clean(ref)}
}

func (m *importJobMedia) resolveZip(ref importMediaRef) (importedMediaItem, *importMediaFailure) {
	raw := strings.TrimSpace(ref.URL)
	if raw == "" {
		return importedMediaItem{}, &importMediaFailure{Code: importNoSource.Code, Reason: importNoSource.Message}
	}
	if u, err := url.Parse(raw); err == nil && u.Scheme != "" {
		return importedMediaItem{}, failureOf(raw, importRemoteFile)
	}
	for _, candidate := range m.zipCandidates(raw) {
		if candidate == "." || strings.HasPrefix(candidate, "../") || candidate == ".." {
			continue
		}
		data, err := m.server.store.GetImportFile(m.ctx, db.GetImportFileParams{JobID: m.job.ID, Path: candidate})
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return importedMediaItem{}, failureOf(raw, importSaveFailed)
		}
		sum := sha256.Sum256(data)
		key := "sha256:" + hex.EncodeToString(sum[:])
		if media, err := m.server.store.GetImportMedia(m.ctx, key); err == nil {
			return m.item(media, ref.Kind, ref.Alt)
		}
		file, err := saveImportBody(bytes.NewReader(data), path.Base(candidate), m.server.config.UploadPath, m.server.maxUploadBytes, m.server.importTooLarge())
		if err != nil {
			return importedMediaItem{}, failureOf(raw, err)
		}
		return m.store(file, key, ref.Kind, "", ref.Alt, "Imported from "+m.job.FileName, raw)
	}
	return importedMediaItem{}, failureOf(raw, importNotInZip)
}

// store makes the media row for a saved file and records where it came from.
func (m *importJobMedia) store(file importedFile, key, kind, name, alt, description, raw string) (importedMediaItem, *importMediaFailure) {
	if !mimeFitsKind(file.mimeType, kind) {
		removeImportedFile(m.server.config.UploadPath, file.mediaPath)
		return importedMediaItem{}, failureOf(raw, importWrongKind)
	}
	media, err := m.server.createImportedMedia(m.ctx, m.log, file, importedMediaDetails{
		Name: truncateRunes(strings.TrimSpace(name), 255), Description: description,
		Alt: truncateRunes(strings.TrimSpace(alt), mediaAltMaxRunes), UserID: m.userID,
	})
	if err != nil {
		return importedMediaItem{}, failureOf(raw, err)
	}
	if err := m.server.store.CreateImportMedia(m.ctx, db.CreateImportMediaParams{
		SourceKey: key, MediaID: media.ID, JobID: sql.NullInt64{Int64: m.job.ID, Valid: true},
	}); err != nil {
		m.log.Warn("import_media_record_failed", "media_id", media.ID, "error", err)
	}
	return importedMediaItem{ID: media.ID, Path: publicMediaPath(m.server.config.UploadPath, media.MediaPath), Alt: media.Alt}, nil
}

// item is a library item found again; its kind must fit the block.
func (m *importJobMedia) item(media db.Medium, kind, alt string) (importedMediaItem, *importMediaFailure) {
	if !mimeFitsKind(media.MimeType, kind) {
		return importedMediaItem{}, &importMediaFailure{Code: importWrongKind.Code, Reason: importWrongKind.Message}
	}
	return importedMediaItem{ID: media.ID, Path: publicMediaPath(m.server.config.UploadPath, media.MediaPath), Alt: firstNonEmptyString(alt, media.Alt)}, nil
}

func mimeFitsKind(mime, kind string) bool {
	switch kind {
	case importMediaImage:
		return strings.HasPrefix(mime, "image/")
	case importMediaVideo:
		return strings.HasPrefix(mime, "video/")
	case importMediaAudio:
		return strings.HasPrefix(mime, "audio/")
	}
	return true
}

// removeImportedFile removes a saved file that won't become a media row.
func removeImportedFile(uploadPath, mediaPath string) {
	_ = removeMediaFile(uploadPath, mediaPath)
	_ = removeMediaVariants(uploadPath, mediaPath)
}
