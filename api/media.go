// Package api – Media module entry point.
//
// # What this module does
// Upload, store, and serve media (images/video/audio/docs) with metadata and
// post-linking. Files land in util.Config.UploadPath and are served via /uploads/*.
//
// # Auth (short)
// Writes (POST/PUT/DELETE) require Bearer access tokens; reads (GET) are public.
//
// # Formats
// Uploads: multipart/form-data. Updates: JSON.
// Images: JPG/PNG/GIF/WebP/BMP/SVG; Video: MP4/MOV/AVI/MKV/WebM;
// Audio: MP3/WAV/OGG/M4A; Docs: PDF/DOC/DOCX/TXT.
//
// # Limits & Safety
// Max size: util.Config.MaxUploadSize (e.g., "10MB"). Extension + MIME checks.
// Filenames sanitized; duplicates auto-suffixed (file_2.jpg).
//
// # Endpoints (index)
// - POST   /api/v1/media           (create single)
// - POST   /api/v1/media/batch     (create batch - original path)
// - POST   /api/v1/media/bulk      (create batch - alias for compatibility)
// - GET    /api/v1/media           (list/filter/sort/paginate)
// - GET    /api/v1/media/:id       (get by id)
// - GET    /api/v1/media/popular   (usage-ranked)
// - GET    /api/v1/media/search    (q=)
// - GET    /api/v1/media/user/:id  (owner's media)
// - GET    /api/v1/media/post/:id  (media for post)
// - GET    /api/v1/media/:id/posts (posts using media)
// - PUT    /api/v1/media/:id       (update metadata)
// - DELETE /api/v1/media/:id       (delete; ownership check)
//
// # Quickstart (single upload)
//
//	curl -H "Authorization: Bearer <token>" -F "file=@hero.jpg" \
//	  -F "name=Hero" -F "description=Homepage banner" \
//	  -F "alt=Blue logo" https://example.com/api/v1/media
//
// # Config
// - UploadPath: directory for files (served via router.Static("/uploads", "./uploads")).
// - MaxUploadSize: string like "10MB" (binary, 1024-based).
//
// # Errors (common)
// 400 invalid file/params | 401 no/invalid token | 403 not owner | 404 not found | 413 too large.
//
// # See also
// - media_utils.go: MIME, filename, dimensions
// - media_handlers_*: GET/POST/PUT/DELETE handlers
// - media_presenters.go: response shapes
//
// # Future work
// - Virus scanning integration
// - S3/cloud storage backend
// - Automatic thumbnail generation
//
// TODO: keep migrating handlers to media_handlers_read.go and media_handlers_write.go.
package api
