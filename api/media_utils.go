// media_utils.go contains utility functions for media file handling, validation, and processing.
//
// # File Operations
//
// This file provides core utilities for media file management including:
//   - File type validation and MIME type detection
//   - Safe filename sanitization and unguessable stored names
//   - Image dimension extraction and metadata processing
//   - Upload size limits and in-place file replacement
//   - Upload path management and directory creation
//
// # Security Features
//
//   - Extension allowlist prevents executable uploads (allowedMediaTypes)
//   - Filename sanitization removes path traversal risks
//   - File size limits prevent resource exhaustion
//   - File bytes are sniffed and must match the extension; SVG is refused
//
// # File Naming Strategy
//
//   - Original filenames are cleaned (alphanumeric + _-.) and kept in
//     original_filename
//   - Stored names add 128 random bits (file-<32 hex>.jpg, #399), so
//     /uploads URLs can't be guessed
//   - Maximum filename length enforcement (100 chars)
//   - Extension preservation for proper MIME handling
//
// # Integration Points
//
//   - Used by upload handlers for validation and storage
//   - MIME types support frontend content type detection
//   - Image dimensions enable responsive image features
//   - Sorting utilities support API query parameters
package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// mediaKind is one accepted upload type: the MIME type stored for it and the
// check its leading bytes must pass.
type mediaKind struct {
	mime  string
	sniff func(head []byte) bool
}

// allowedMediaTypes is the upload allowlist, keyed by lowercase extension.
// The extension picks the kind and the file's own bytes must then match it,
// so neither the client's Content-Type nor a renamed file decides what is
// stored. SVG is deliberately absent: it can carry script, and /uploads is
// served from the site's origin.
var allowedMediaTypes = map[string]mediaKind{
	// Images
	".jpg":  {"image/jpeg", sniffedAs("image/jpeg")},
	".jpeg": {"image/jpeg", sniffedAs("image/jpeg")},
	".png":  {"image/png", sniffedAs("image/png")},
	".gif":  {"image/gif", sniffedAs("image/gif")},
	".webp": {"image/webp", sniffedAs("image/webp")},
	".bmp":  {"image/bmp", sniffedAs("image/bmp")},
	// Video. MP4, MOV and M4A are all ISO base media files ("ftyp" box);
	// http.DetectContentType only names the mp4 brands, so check the box.
	".mp4":  {"video/mp4", isISOBaseMedia},
	".mov":  {"video/quicktime", isISOBaseMedia},
	".avi":  {"video/x-msvideo", sniffedAs("video/avi")},
	".mkv":  {"video/x-matroska", sniffedAs("video/webm")}, // EBML header, same as WebM
	".webm": {"video/webm", sniffedAs("video/webm")},
	// Audio
	".mp3": {"audio/mpeg", isMP3},
	".wav": {"audio/wav", sniffedAs("audio/wave")},
	".ogg": {"audio/ogg", sniffedAs("application/ogg")},
	".m4a": {"audio/mp4", isISOBaseMedia},
	// Documents
	".pdf":  {"application/pdf", sniffedAs("application/pdf")},
	".doc":  {"application/msword", hasPrefix("\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1")}, // OLE2 compound file
	".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document", hasPrefix("PK\x03\x04")},
	// Plain text only: content that sniffs as HTML or XML is refused.
	".txt": {"text/plain", sniffedAs("text/plain")},
}

// sniffLen is how much of a file is read to identify it, the most
// http.DetectContentType looks at.
const sniffLen = 512

// sniffedAs matches when http.DetectContentType (parameters dropped) is mime.
func sniffedAs(mime string) func([]byte) bool {
	return func(head []byte) bool {
		detected, _, _ := strings.Cut(http.DetectContentType(head), ";")
		return detected == mime
	}
}

// hasPrefix matches files starting with the given magic bytes.
func hasPrefix(magic string) func([]byte) bool {
	return func(head []byte) bool { return strings.HasPrefix(string(head), magic) }
}

// isISOBaseMedia matches ISO base media files (MP4, MOV, M4A), whose first
// box is "ftyp".
func isISOBaseMedia(head []byte) bool {
	return len(head) >= 12 && string(head[4:8]) == "ftyp"
}

// isMP3 matches an ID3 tag or a bare MPEG audio frame sync.
func isMP3(head []byte) bool {
	return strings.HasPrefix(string(head), "ID3") ||
		(len(head) >= 2 && head[0] == 0xFF && head[1]&0xE0 == 0xE0)
}

// Upload validation failures. Handlers map them to responses with
// uploadErrorStatus; the bulk handler reports them per file instead.
var (
	errUnsupportedMediaType = errors.New("unsupported file type")
	errMediaContentMismatch = errors.New("file content does not match its extension")
	errMediaTooLarge        = errors.New("file too large")
)

// validateMediaUpload checks an uploaded file against the allowlist and the
// size limit and returns the MIME type to store for it. The size comes from
// the multipart header, which the parser sets from the bytes it actually
// read; the type comes from the extension and must agree with the file's
// leading bytes. file is rewound afterwards.
func validateMediaUpload(file multipart.File, header *multipart.FileHeader, maxBytes int64) (string, error) {
	kind, ok := allowedMediaTypes[strings.ToLower(filepath.Ext(header.Filename))]
	if !ok {
		return "", errUnsupportedMediaType
	}
	if header.Size > maxBytes {
		return "", errMediaTooLarge
	}

	head := make([]byte, sniffLen)
	n, err := io.ReadFull(file, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return "", err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	if n == 0 || !kind.sniff(head[:n]) {
		return "", errMediaContentMismatch
	}
	return kind.mime, nil
}

// allowedMediaExtensions lists the accepted extensions, sorted, for error
// messages.
func allowedMediaExtensions() string {
	exts := make([]string, 0, len(allowedMediaTypes))
	for ext := range allowedMediaTypes {
		exts = append(exts, ext)
	}
	sort.Strings(exts)
	return strings.Join(exts, ", ")
}

// multipartOverhead is the allowance on top of the file bytes for the rest
// of a multipart body (boundaries, part headers, small form fields).
const multipartOverhead int64 = 1 << 20

// limitUploadBody caps the request body at what a form of up to files files
// of maxBytes each can need. Without it ParseMultipartForm spools any size
// to disk before the per-file check runs; with it an oversized body fails
// while parsing (see isBodyTooLarge).
func limitUploadBody(c *gin.Context, maxBytes int64, files int) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes*int64(files)+multipartOverhead)
}

// isBodyTooLarge reports whether a multipart parse failed on limitUploadBody's cap.
func isBodyTooLarge(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.As(err, &maxErr) || (err != nil && strings.Contains(err.Error(), "request body too large"))
}

// respondUploadError writes the response for a validateMediaUpload error:
// 413 when too large, 400 for a refused type, 500 otherwise.
func (server *Server) respondUploadError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, errMediaTooLarge):
		server.respondUploadTooLarge(c)
	case errors.Is(err, errUnsupportedMediaType):
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file type. Allowed: " + allowedMediaExtensions()})
	case errors.Is(err, errMediaContentMismatch):
		c.JSON(http.StatusBadRequest, gin.H{"error": "file content does not match its extension"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read uploaded file"})
	}
}

// respondUploadTooLarge writes the 413 for a file over MaxUploadSize.
func (server *Server) respondUploadTooLarge(c *gin.Context) {
	limit := server.config.MaxUploadSize
	if limit == "" {
		limit = "10MB"
	}
	c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("file too large. Maximum size is %s", limit)})
}

// storedNameTokenBytes is how much randomness a stored file's name carries
// (#399). /uploads is a public static route, so the name is the only thing
// keeping a draft-only image private: it must not be guessable.
const storedNameTokenBytes = 16

// storedNameAttempts bounds the retries when a generated name already exists,
// which with 128 random bits only a broken random source would cause.
const storedNameAttempts = 5

// cleanUploadFilename is the uploader's file name as stored in
// original_filename: the base name cleaned (cleanFilename) plus its extension
// (validateMediaUpload has already checked it against the allowlist).
func cleanUploadFilename(filename string) string {
	ext := filepath.Ext(filename)
	return cleanFilename(strings.TrimSuffix(filename, ext)) + ext
}

// storedFileName is the name an upload is stored under:
// "<cleaned name>-<32 hex chars><ext>", e.g. "launch-announcement-3f9a…c1.jpg".
// The readable part keeps download names and image SEO; the random part makes
// the /uploads URL unguessable, so an image only a draft uses isn't public
// (#399). Variants live under _variants/<stored name>/, so they inherit it.
func storedFileName(originalFilename string) (string, error) {
	token := make([]byte, storedNameTokenBytes)
	if _, err := rand.Read(token); err != nil {
		return "", err
	}
	ext := filepath.Ext(originalFilename)
	return fmt.Sprintf("%s-%s%s", strings.TrimSuffix(originalFilename, ext), hex.EncodeToString(token), ext), nil
}

// saveUploadedFile writes an upload into uploadPath under a new
// storedFileName and returns its media_path ("<uploadPath>/<stored name>",
// the form every media row uses). originalFilename should already be cleaned
// (cleanUploadFilename). The file is created exclusively, so an upload never
// overwrites another one, and a failed write leaves no partial file.
func saveUploadedFile(file io.Reader, originalFilename, uploadPath string) (string, error) {
	// Use uploadPath directly so absolute paths (e.g. in tests) work on all platforms.
	if err := os.MkdirAll(uploadPath, 0755); err != nil {
		return "", err
	}

	for attempt := 0; attempt < storedNameAttempts; attempt++ {
		filename, err := storedFileName(originalFilename)
		if err != nil {
			return "", err
		}
		filePath := filepath.Join(uploadPath, filename)
		dst, err := os.OpenFile(filePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, err = io.Copy(dst, file)
		if closeErr := dst.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			os.Remove(filePath)
			return "", err
		}
		return fmt.Sprintf("%s/%s", uploadPath, filename), nil
	}
	return "", errors.New("could not find a free name for the upload")
}

// errOutsideUploadDir is returned by removeMediaFile for a media_path that
// does not resolve inside the upload directory.
var errOutsideUploadDir = errors.New("media path is outside the upload directory")

// removeMediaFile deletes the stored file behind a media row.
//
// media_path is server-owned now (PUT /media/:id rejects it), but rows written
// before that, by the dummy-data seeder, or directly in the database may hold
// anything, so it is still not trusted: only a path that resolves strictly
// inside uploadPath is removed, never an arbitrary file the API process can
// delete (app.env, source files). An already-missing file is not an error.
func removeMediaFile(uploadPath, mediaPath string) error {
	target, err := resolveInUploadDir(uploadPath, mediaPath)
	if err != nil {
		return err
	}

	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// resolveInUploadDir returns mediaPath as an absolute path, or
// errOutsideUploadDir unless it lies strictly inside uploadPath.
func resolveInUploadDir(uploadPath, mediaPath string) (string, error) {
	base, err := filepath.Abs(uploadPath)
	if err != nil {
		return "", err
	}
	target, err := filepath.Abs(mediaPath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, target)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errOutsideUploadDir
	}
	return target, nil
}

// publicMediaPath returns the URL path /uploads serves a stored file at. The
// file router serves the parent of uploadPath at /uploads, so with
// UPLOAD_PATH=/app/uploads/media the file /app/uploads/media/x.jpg is
// /uploads/media/x.jpg. media_path is stored as a filesystem path (it is what
// replace and delete act on), but clients use the response's media_path as
// the image URL, so the stored one 404s whenever UPLOAD_PATH is absolute.
// A path outside uploadPath (legacy rows) is returned unchanged.
func publicMediaPath(uploadPath, mediaPath string) string {
	target, err := resolveInUploadDir(uploadPath, mediaPath)
	if err != nil {
		return mediaPath
	}
	served, err := filepath.Abs(filepath.Dir(uploadPath))
	if err != nil {
		return mediaPath
	}
	rel, err := filepath.Rel(served, target)
	if err != nil {
		return mediaPath
	}
	return "/uploads/" + filepath.ToSlash(rel)
}

// mediaResponse is toMediaResponse with media_path as its public URL path
// (publicMediaPath).
func (server *Server) mediaResponse(media db.Medium) MediaResponse {
	return server.withPublicMediaPath(toMediaResponse(media))
}

// withPublicMediaPath replaces a presented row's stored media_path with its
// public URL path (publicMediaPath). Every handler returning media uses it.
func (server *Server) withPublicMediaPath(response MediaResponse) MediaResponse {
	response.MediaPath = publicMediaPath(server.config.UploadPath, response.MediaPath)
	response.Variants = publicVariants(server.config.UploadPath, response.Variants)
	return response
}

// fileSwap is a replacement file moved into place over an existing one,
// with the original kept aside until the swap is committed or rolled back.
type fileSwap struct {
	target string // the path being replaced, where the new file now is
	backup string // the original's temporary name; "" if there was none
}

// swapInFile writes src to a temp file next to target, then moves the
// current file at target aside and the new one into its place. Nothing is
// lost if this fails: on error target is as it was. Call commit once the
// database agrees, or rollback to put the original back.
func swapInFile(target string, src io.Reader) (*fileSwap, error) {
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".replace-*.tmp")
	if err != nil {
		return nil, err
	}
	// CreateTemp makes the file 0600; a replaced file should be as readable
	// as a fresh upload (os.Create, 0666 less umask).
	chmodErr := tmp.Chmod(0644)
	_, copyErr := io.Copy(tmp, src)
	closeErr := tmp.Close()
	if err := errors.Join(chmodErr, copyErr, closeErr); err != nil {
		os.Remove(tmp.Name())
		return nil, err
	}

	swap := &fileSwap{target: target, backup: tmp.Name() + ".orig"}
	if err := os.Rename(target, swap.backup); err != nil {
		if !os.IsNotExist(err) {
			os.Remove(tmp.Name())
			return nil, err
		}
		swap.backup = "" // the original file was already gone
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		os.Remove(tmp.Name())
		// If putting the original back fails too, the caller needs to know
		// target may now be missing, not just that the swap failed.
		return nil, errors.Join(err, swap.restore())
	}
	return swap, nil
}

// commit drops the original.
func (s *fileSwap) commit() error {
	if s.backup == "" {
		return nil
	}
	return os.Remove(s.backup)
}

// rollback puts the original back over the new file (or removes the new
// file if there was no original).
func (s *fileSwap) rollback() error {
	if s.backup == "" {
		return os.Remove(s.target)
	}
	return s.restore()
}

func (s *fileSwap) restore() error {
	if s.backup == "" {
		return nil
	}
	return os.Rename(s.backup, s.target)
}

// cleanFilename sanitizes filenames for safe filesystem storage.
// Removes special characters, collapses multiple underscores, and enforces length limits.
//
// # Cleaning Rules
//   - Keep only alphanumeric, dots, hyphens, and underscores
//   - Replace other characters with underscores
//   - Collapse consecutive underscores into single underscore
//   - Trim leading/trailing underscores
//   - Default to "untitled" if result is empty
//   - Truncate to 100 characters maximum
//
// # Security Benefits
//   - Prevents path traversal attacks (removes ../ sequences)
//   - Eliminates shell metacharacters
//   - Avoids filesystem reserved names
//   - Ensures consistent cross-platform compatibility
func cleanFilename(filename string) string {
	// Replace non-alphanumeric chars (except .-_) with underscore
	re := regexp.MustCompile(`[^a-zA-Z0-9._-]`)
	cleaned := re.ReplaceAllString(filename, "_")

	// Collapse multiple underscores
	re2 := regexp.MustCompile(`_+`)
	cleaned = re2.ReplaceAllString(cleaned, "_")

	// Trim underscores from start/end
	cleaned = strings.Trim(cleaned, "_")

	// Default name if empty
	if cleaned == "" {
		cleaned = "untitled"
	}

	// Enforce length limit
	if len(cleaned) > 100 {
		cleaned = cleaned[:100]
	}

	return cleaned
}

// getImageDimensions extracts width and height from image files.
// Uses Go's image package for efficient metadata reading without full decode.
// Returns (0, 0, error) for non-images or read failures.
//
// # Supported Formats
// Automatically detects: JPEG, PNG, GIF (via imported decoders)
// Add more formats by importing additional image/* packages.
//
// # Performance
// Only reads image headers, not full image data, for fast dimension extraction.
func getImageDimensions(filePath string) (int32, int32, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()

	config, _, err := image.DecodeConfig(file)
	if err != nil {
		return 0, 0, err
	}

	return int32(config.Width), int32(config.Height), nil
}

// isImageFile checks if filename has an image extension.
// Used to determine if dimension extraction should be attempted.
// Extension checking is case-insensitive.
func isImageFile(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	imageExts := []string{".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
	for _, imgExt := range imageExts {
		if ext == imgExt {
			return true
		}
	}
	return false
}

// isValidSortOption validates sort parameter values to prevent SQL injection.
// Supports common sorting patterns for media listings with direction suffixes.
//
// # Allowed Values
//   - date_asc, date_desc: Sort by creation time
//   - name_asc, name_desc: Sort alphabetically by filename
//   - size_asc, size_desc: Sort by file size
//   - type_asc, type_desc: Sort by MIME type
//   - posts_asc, posts_desc: Sort by usage count
//
// Empty string is considered valid (defaults to server-side default).
func isValidSortOption(sort string) bool {
	validSorts := []string{
		"date_asc", "date_desc",
		"name_asc", "name_desc",
		"size_asc", "size_desc",
		"type_asc", "type_desc",
		"posts_asc", "posts_desc",
	}

	if sort == "" {
		return true
	}

	for _, valid := range validSorts {
		if sort == valid {
			return true
		}
	}
	return false
}

// getMimeTypeFilter converts friendly type names to MIME type prefixes for database filtering.
// Used by search and listing endpoints to filter by content category.
//
// # Type Mappings
//   - "image" → "image/"
//   - "video" → "video/"
//   - "audio" → "audio/"
//   - "document" → "application/"
//   - "text" → "text/"
//   - other → "" (no filter)
//
// Returns empty string for unknown types, which disables MIME filtering.
func getMimeTypeFilter(fileType string) string {
	switch fileType {
	case "image":
		return "image/"
	case "video":
		return "video/"
	case "audio":
		return "audio/"
	case "document":
		return "application/"
	case "text":
		return "text/"
	default:
		return ""
	}
}
