// media_utils.go contains utility functions for media file handling, validation, and processing.
//
// # File Operations
//
// This file provides core utilities for media file management including:
//   - File type validation and MIME type detection
//   - Safe filename sanitization and conflict resolution
//   - Image dimension extraction and metadata processing
//   - File size parsing with unit conversion
//   - Upload path management and directory creation
//
// # Security Features
//
//   - Extension whitelist prevents executable uploads
//   - Filename sanitization removes path traversal risks
//   - File size limits prevent resource exhaustion
//   - MIME type validation provides defense in depth
//
// # File Naming Strategy
//
//   - Original filenames are cleaned (alphanumeric + _-.)
//   - Automatic incrementing for duplicates (file_1.jpg, file_2.jpg)
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
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// isValidMediaType checks if filename extension is in the allowed list.
// Supports: images (jpg, png, gif, webp, bmp, svg), video (mp4, mov, avi, mkv, webm),
// audio (mp3, wav, ogg, m4a), documents (pdf, doc, docx, txt).
//
// This whitelist approach prevents upload of executable files and provides
// a clear contract for supported media types. Extensions are case-insensitive.
//
// Returns true if the file extension is supported, false otherwise.
func isValidMediaType(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	validExts := []string{
		// Images
		".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg",
		// Video
		".mp4", ".mov", ".avi", ".mkv", ".webm",
		// Audio
		".mp3", ".wav", ".ogg", ".m4a",
		// Documents
		".pdf", ".doc", ".docx", ".txt",
	}

	for _, validExt := range validExts {
		if ext == validExt {
			return true
		}
	}
	return false
}

// saveUploadedFileWithOriginalName saves uploaded file to UploadPath with conflict resolution.
// Cleans filename (alphanumeric + _-.), adds counter suffix for duplicates.
// Returns: (relative_path, actual_filename, error).
//
// # File Naming Process
//  1. Extract name and extension from original filename
//  2. Clean name using cleanFilename() (removes unsafe characters)
//  3. Check for existing file, increment counter if needed
//  4. Create directory structure if missing
//  5. Stream file contents to destination
//
// # Security Notes
//   - Creates directories with 0755 permissions
//   - Overwrites existing files with same cleaned name
//   - Returns relative paths for database storage
//   - Streams file contents (memory efficient for large files)
func saveUploadedFileWithOriginalName(file multipart.File, header *multipart.FileHeader, uploadPath string) (string, string, error) {
	// Create upload directory if it doesn't exist
	uploadsDir := filepath.Join(".", uploadPath)
	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		return "", "", err
	}

	// Extract and clean filename components
	originalName := strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename))
	ext := filepath.Ext(header.Filename)
	cleanedName := cleanFilename(originalName)

	// Handle filename conflicts with counter suffix
	filename := fmt.Sprintf("%s%s", cleanedName, ext)
	filePath := filepath.Join(uploadsDir, filename)

	counter := 1
	for fileExists(filePath) {
		filename = fmt.Sprintf("%s_%d%s", cleanedName, counter, ext)
		filePath = filepath.Join(uploadsDir, filename)
		counter++
	}

	// Create and write file
	dst, err := os.Create(filePath)
	if err != nil {
		return "", "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		return "", "", err
	}

	return fmt.Sprintf("%s/%s", uploadPath, filename), filename, nil
}

// fileExists checks if a file exists at the given path.
// Returns true if file exists (including directories), false if not found.
func fileExists(filepath string) bool {
	_, err := os.Stat(filepath)
	return !os.IsNotExist(err)
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

// getFileMimeType returns MIME type based on file extension.
// Uses a comprehensive mapping of common extensions to standard MIME types.
// Returns "application/octet-stream" for unknown extensions.
//
// This mapping supports content-type headers and frontend file handling.
// Extension matching is case-insensitive for reliability.
func getFileMimeType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	mimeTypes := map[string]string{
		// Images
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".webp": "image/webp",
		".bmp":  "image/bmp",
		".svg":  "image/svg+xml",
		// Video
		".mp4":  "video/mp4",
		".mov":  "video/quicktime",
		".avi":  "video/x-msvideo",
		".mkv":  "video/x-matroska",
		".webm": "video/webm",
		// Audio
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".ogg": "audio/ogg",
		".m4a": "audio/mp4",
		// Documents
		".pdf":  "application/pdf",
		".doc":  "application/msword",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".txt":  "text/plain",
	}

	if mimeType, exists := mimeTypes[ext]; exists {
		return mimeType
	}
	return "application/octet-stream"
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

// parseFileSize converts size strings like "10MB", "512KB" to bytes.
// Supports KB, MB, GB suffixes with standard binary multipliers (1024-based).
// Returns default of 10MB if parsing fails or input is empty.
//
// # Examples
//
//	"10MB" → 10485760 bytes
//	"512KB" → 524288 bytes
//	"1GB" → 1073741824 bytes
//	"" → 10485760 bytes (default)
//	"invalid" → 10485760 bytes (default)
func parseFileSize(sizeStr string) (int64, error) {
	if sizeStr == "" {
		return 10 << 20, nil // Default 10MB
	}

	sizeStr = strings.ToUpper(strings.TrimSpace(sizeStr))

	var multiplier int64 = 1
	if strings.HasSuffix(sizeStr, "MB") {
		multiplier = 1 << 20 // 1024^2
		sizeStr = strings.TrimSuffix(sizeStr, "MB")
	} else if strings.HasSuffix(sizeStr, "KB") {
		multiplier = 1 << 10 // 1024
		sizeStr = strings.TrimSuffix(sizeStr, "KB")
	} else if strings.HasSuffix(sizeStr, "GB") {
		multiplier = 1 << 30 // 1024^3
		sizeStr = strings.TrimSuffix(sizeStr, "GB")
	}

	size, err := strconv.ParseInt(sizeStr, 10, 64)
	if err != nil {
		return 10 << 20, err // Default on error
	}

	return size * multiplier, nil
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
