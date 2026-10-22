// Package api – Media module entry point.
//
// # What this module does
// Upload, store, and serve media (images/video/audio/docs) with metadata and
// post-linking. Files land in util.Config.UploadPath and are served via /uploads/*.
//
// # Auth (short)
// Writes (POST/PUT/DELETE) require a Bearer access token and the editor-or-admin
// role (requireContentEditor). Admins and editors may update/delete any media;
// any other role admitted later only its own (canWriteMedia; see the ownership
// policy in media_handlers_write.go). Reads (GET) are public.
//
// # Formats
// Uploads: multipart/form-data. Updates: JSON.
// Images: JPG/PNG/GIF/WebP/BMP; Video: MP4/MOV/AVI/MKV/WebM;
// Audio: MP3/WAV/OGG/M4A; Docs: PDF/DOC/DOCX/TXT. SVG is refused (it can
// carry script). The file's bytes are sniffed and must match its extension;
// the client's Content-Type is ignored (allowedMediaTypes in media_utils.go).
//
// # Limits & Safety
// Max size: util.Config.MaxUploadSize (e.g., "10MB"), enforced on the body
// while it is read; larger uploads get 413.
// Filenames sanitized; duplicates auto-suffixed (file_2.jpg).
//
// # Images (#255)
// Image metadata (EXIF/GPS/XMP) is stripped on upload and replace, and
// thumb/medium/large variants are generated next to the original (see
// media_variants.go). Media has an optional focal point (PUT focal_point).
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
// - POST   /api/v1/media/:id/replace (swap the file in place; id, name, alt kept)
// - DELETE /api/v1/media/:id       (delete; admin/editor: any media)
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
// 400 invalid file/params | 401 no/invalid token | 403 role not editor/admin, or not owner | 404 not found | 413 too large.
//
// # Future work
// - Virus scanning integration
// - S3/cloud storage backend
// - WebP/AVIF variant output (needs an encoder; pure-Go ones are lossless only)
//
// This file intentionally contains only documentation.
// See: media_routes.go (route registration), media_bindings.go (request structs),
//
//	media_handlers_read.go (GET handlers), media_handlers_write.go (POST/PUT/DELETE),
//	media_presenters.go (response shapes), media_utils.go (MIME, filenames, dimensions,
//	file storage/removal).
package api
