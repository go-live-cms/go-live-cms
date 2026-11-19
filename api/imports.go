package api

// The importer (#150, 000065): Posts › Import. An admin uploads a WordPress export (WXR)
// or a zip of Markdown files; the API reads it at once (importer package: a token stream
// with no DTD for XML, checked names and capped sizes for zips) into a job with one item
// per post and page, in status "mapping". The admin matches each author to a member (or
// themselves, the importer) and each post type to a GoLive type (or skips it), then
// starts it: the job runs in the background (import_worker.go), never inside a request,
// and the Import page polls it for progress and its report.
//
// Admins only: an import creates other members' posts, media and terms. The editor's
// "blocks couldn't be kept" notice for an imported post (GET /posts/:id/import-notice) is
// for whoever moderates posts.

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/importer"
)

// importListLimit is how many recent imports the Import page lists.
const importListLimit = 20

func (server *Server) registerImportRoutes(v1 *gin.RouterGroup) {
	imports := v1.Group("/imports", server.requireAuth(), requireSiteAdmin(server))
	imports.POST("", server.uploadImport)
	imports.GET("", server.listImports)
	imports.GET("/:id", server.getImport)
	imports.GET("/:id/items", server.listImportItems)
	imports.POST("/:id/start", server.startImport)
	imports.POST("/:id/cancel", server.cancelImport)
	imports.DELETE("/:id", server.deleteImport)

	v1.GET("/posts/:id/import-notice", server.requireAuth(), requireContentEditor(server), server.getImportNotice)
	v1.POST("/posts/:id/import-notice/dismiss", server.requireAuth(), requireContentEditor(server), server.dismissImportNotice)
}

// importFileError is a refused upload: a fixed code and message.
func importFileError(c *gin.Context, status int, code, message string) {
	c.JSON(status, gin.H{"code": code, "error": message})
}

func (server *Server) importMaxBytes() int64 {
	if n, err := server.config.ImportMaxBytes(); err == nil {
		return n
	}
	return 100 << 20
}

// uploadImport handles POST /imports (multipart, field "file"): read the file into a job.
func (server *Server) uploadImport(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	maxBytes := server.importMaxBytes()
	limitUploadBody(c, maxBytes, 1)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		if isBodyTooLarge(err) {
			importFileError(c, http.StatusRequestEntityTooLarge, "too_large", "The file is larger than "+humanBytes(maxBytes))
			return
		}
		importFileError(c, http.StatusBadRequest, "no_file", "Choose a WordPress export (.xml) or a zip of Markdown files")
		return
	}
	defer file.Close()
	if header.Size > maxBytes {
		importFileError(c, http.StatusRequestEntityTooLarge, "too_large", "The file is larger than "+humanBytes(maxBytes))
		return
	}
	log := server.requestLog(c)

	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		importFileError(c, http.StatusInternalServerError, "read_failed", "The file couldn’t be read")
		return
	}
	limits := importer.Limits{MaxFileBytes: server.maxUploadBytes, MaxTotalBytes: 4 * maxBytes}
	var exp *importer.Export
	switch importer.Detect(head[:n]) {
	case importer.SourceWXR:
		exp, err = importer.ParseWXR(io.LimitReader(file, maxBytes), limits)
	case importer.SourceMarkdown:
		exp, err = importer.ParseMarkdownZip(file, header.Size, limits)
	default:
		err = importer.ErrNotAnExport
	}
	if err != nil {
		var known *importer.Error
		if errors.As(err, &known) {
			log.Info("import_refused", "reason", known.Code)
			importFileError(c, http.StatusUnprocessableEntity, known.Code, known.Message)
			return
		}
		log.Warn("import_read_failed", "error", err)
		importFileError(c, http.StatusInternalServerError, "read_failed", "The file couldn’t be read")
		return
	}

	summary, err := server.importSummary(c, exp)
	if err != nil {
		log.Warn("import_summary_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the export"})
		return
	}
	job, err := server.createImportJob(c, caller.ID, uploadedImportName(header), exp, summary)
	if err != nil {
		log.Warn("import_create_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the import"})
		return
	}
	resp, err := server.importJobResponse(c, job)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the import"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"import": resp})
}

// uploadedImportName is the upload's name as shown (never a path).
func uploadedImportName(header *multipart.FileHeader) string {
	name := strings.TrimSpace(header.Filename)
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	if name == "" {
		name = "export"
	}
	return truncateRunes(name, 255)
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30 && n%(1<<30) == 0:
		return strconv.FormatInt(n>>30, 10) + " GB"
	case n >= 1<<20:
		return strconv.FormatInt(n>>20, 10) + " MB"
	default:
		return strconv.FormatInt(n>>10, 10) + " KB"
	}
}

// importSummary is what the mapping step shows: authors (with a suggested member), post
// types (with a suggested GoLive type), counts, what isn't imported.
type importSummary struct {
	Source      string            `json:"source"`
	SiteURL     string            `json:"site_url,omitempty"`
	SiteHost    string            `json:"site_host,omitempty"`
	Title       string            `json:"title,omitempty"`
	Items       int               `json:"items"`
	Authors     []importAuthor    `json:"authors"`
	Types       []importTypeCount `json:"types"`
	Categories  int               `json:"categories"`
	Tags        int               `json:"tags"`
	OtherTerms  int               `json:"other_terms"`
	Attachments int               `json:"attachments"`
	Files       int               `json:"files"`
	Skipped     map[string]int    `json:"skipped"`
	NotImported map[string]int    `json:"not_imported"`
}

type importAuthor struct {
	Login       string `json:"login"`
	DisplayName string `json:"display_name"`
	Posts       int    `json:"posts"`
	// SuggestedUserID is a member with the same email or user name (0 = none).
	SuggestedUserID int64  `json:"suggested_user_id"`
	MatchedBy       string `json:"matched_by,omitempty"`
}

type importTypeCount struct {
	Type      string `json:"type"`
	Count     int    `json:"count"`
	Published int    `json:"published"`
	// Suggested is the GoLive type it maps to by default ("" = not imported).
	Suggested string `json:"suggested"`
}

func (server *Server) importSummary(c *gin.Context, exp *importer.Export) (importSummary, error) {
	ctx := c.Request.Context()
	s := importSummary{
		Source:      exp.Source,
		SiteURL:     exp.SiteURL,
		Title:       truncateRunes(exp.Title, 200),
		Attachments: len(exp.Attachments),
		Files:       len(exp.Files),
		Skipped:     map[string]int{},
		NotImported: exp.NotImported,
		Authors:     []importAuthor{},
		Types:       []importTypeCount{},
	}
	if u, err := url.Parse(exp.SiteURL); err == nil {
		s.SiteHost = strings.ToLower(u.Hostname())
	}
	for _, t := range exp.Terms {
		switch t.Taxonomy {
		case "category":
			s.Categories++
		case "tag":
			s.Tags++
		default:
			s.OtherTerms++
		}
	}
	postsBy := map[string]int{}
	typeIndex := map[string]int{}
	for _, it := range exp.Items {
		if it.SkipReason != "" {
			s.Skipped[it.SkipReason]++
			continue
		}
		s.Items++
		postsBy[it.Author]++
		i, ok := typeIndex[it.Type]
		if !ok {
			i = len(s.Types)
			typeIndex[it.Type] = i
			s.Types = append(s.Types, importTypeCount{Type: it.Type, Suggested: server.suggestedImportType(c, it.Type)})
		}
		s.Types[i].Count++
		if it.Status == importer.StatusPublished {
			s.Types[i].Published++
		}
	}
	authors := exp.Authors
	// Authors a post names that the export doesn't list (an old export, a Markdown file).
	known := map[string]bool{}
	for _, a := range authors {
		known[a.Login] = true
	}
	for login := range postsBy {
		if login != "" && !known[login] {
			authors = append(authors, importer.Author{Login: login, DisplayName: login})
			known[login] = true
		}
	}
	for _, a := range authors {
		if a.Login == "" {
			continue
		}
		entry := importAuthor{Login: a.Login, DisplayName: firstNonEmptyString(a.DisplayName, a.Login), Posts: postsBy[a.Login]}
		if a.Email != "" {
			if u, err := server.store.GetUserByEmail(ctx, a.Email); err == nil && hasRole(u, contentRoles...) {
				entry.SuggestedUserID, entry.MatchedBy = u.ID, "email"
			} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return s, err
			}
		}
		if entry.SuggestedUserID == 0 {
			if u, err := server.store.GetUserByUsername(ctx, a.Login); err == nil && hasRole(u, contentRoles...) {
				entry.SuggestedUserID, entry.MatchedBy = u.ID, "username"
			} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return s, err
			}
		}
		s.Authors = append(s.Authors, entry)
	}
	return s, nil
}

// suggestedImportType: WordPress's post and page map to GoLive's; another type to the
// active GoLive type of the same name, if there is one; anything else isn't imported.
func (server *Server) suggestedImportType(c *gin.Context, wpType string) string {
	if wpType == "post" || wpType == "page" {
		return wpType
	}
	if pt, err := server.store.GetPostType(c.Request.Context(), wpType); err == nil && pt.IsActive {
		return pt.Name
	}
	return ""
}

func (server *Server) createImportJob(c *gin.Context, callerID int64, fileName string, exp *importer.Export, summary importSummary) (db.ImportJob, error) {
	ctx := c.Request.Context()
	summaryJSON, err := json.Marshal(summary)
	if err != nil {
		return db.ImportJob{}, err
	}
	terms, err := json.Marshal(exp.Terms)
	if err != nil {
		return db.ImportJob{}, err
	}
	if exp.Terms == nil {
		terms = []byte("[]")
	}
	attachments, err := json.Marshal(exp.Attachments)
	if err != nil {
		return db.ImportJob{}, err
	}
	blocks, err := json.Marshal(exp.Blocks)
	if err != nil {
		return db.ImportJob{}, err
	}
	var job db.ImportJob
	err = server.store.ExecTx(ctx, func(q *db.Queries) error {
		var err error
		job, err = q.CreateImportJob(ctx, db.CreateImportJobParams{
			CreatedBy:   sql.NullInt64{Int64: callerID, Valid: true},
			Source:      exp.Source,
			FileName:    fileName,
			SiteUrl:     exp.SiteURL,
			Summary:     summaryJSON,
			Terms:       terms,
			Attachments: attachments,
			Blocks:      blocks,
		})
		if err != nil {
			return err
		}
		position := 0
		seen := map[string]bool{}
		for _, it := range exp.Items {
			if seen[it.Key] {
				continue // the same GUID twice: the first wins
			}
			seen[it.Key] = true
			payload, err := json.Marshal(it)
			if err != nil {
				return err
			}
			status, reason := db.ImportItemPending, ""
			if it.SkipReason != "" {
				status, reason = db.ImportItemSkipped, it.SkipReason
			}
			position++
			if err := q.CreateImportItem(ctx, db.CreateImportItemParams{
				JobID: job.ID, Position: int32(position), SourceKey: it.Key, WpID: it.WpID, WpType: it.Type,
				Title: truncateRunes(it.Title, 255), Payload: payload, Status: status, Reason: reason,
			}); err != nil {
				return err
			}
		}
		for path, data := range exp.Files {
			if err := q.CreateImportFile(ctx, db.CreateImportFileParams{JobID: job.ID, Path: path, Data: data}); err != nil {
				return err
			}
		}
		return nil
	})
	return job, err
}

// ImportJobResponse is one import as the Import page shows it.
type ImportJobResponse struct {
	ID         int64           `json:"id"`
	Source     string          `json:"source"`
	FileName   string          `json:"file_name"`
	SiteURL    string          `json:"site_url"`
	Status     string          `json:"status"`
	Error      string          `json:"error,omitempty"`
	Summary    json.RawMessage `json:"summary"`
	Mapping    json.RawMessage `json:"mapping,omitempty"`
	CreatedBy  *int64          `json:"created_by"`
	CreatedAt  time.Time       `json:"created_at"`
	StartedAt  *time.Time      `json:"started_at"`
	FinishedAt *time.Time      `json:"finished_at"`
	Progress   importProgress  `json:"progress"`
	// ImportedBefore: items an earlier import brought over (skipped when this one runs).
	// Only while the job waits for its mapping.
	ImportedBefore *int64 `json:"imported_before,omitempty"`
}

type importProgress struct {
	Total       int64 `json:"total"`
	Pending     int64 `json:"pending"`
	Imported    int64 `json:"imported"`
	Skipped     int64 `json:"skipped"`
	Failed      int64 `json:"failed"`
	WithDropped int64 `json:"with_dropped"`
}

func (server *Server) importJobResponse(c *gin.Context, job db.ImportJob) (ImportJobResponse, error) {
	ctx := c.Request.Context()
	resp := ImportJobResponse{
		ID: job.ID, Source: job.Source, FileName: job.FileName, SiteURL: job.SiteUrl, Status: job.Status,
		Error: job.Error, Summary: job.Summary, CreatedAt: job.CreatedAt,
		StartedAt: nullTimePtr(job.StartedAt), FinishedAt: nullTimePtr(job.FinishedAt),
	}
	if len(job.Mapping) > 0 && string(job.Mapping) != "{}" {
		resp.Mapping = job.Mapping
	}
	if job.CreatedBy.Valid {
		id := job.CreatedBy.Int64
		resp.CreatedBy = &id
	}
	counts, err := server.store.CountImportItemsByStatus(ctx, job.ID)
	if err != nil {
		return resp, err
	}
	resp.Progress = progressOf(counts)
	if job.Status == db.ImportJobMapping {
		before, err := server.store.CountImportedBefore(ctx, job.ID)
		if err != nil {
			return resp, err
		}
		resp.ImportedBefore = &before
	}
	return resp, nil
}

func progressOf(counts []db.CountImportItemsByStatusRow) importProgress {
	var p importProgress
	for _, row := range counts {
		p.Total += row.Count
		switch row.Status {
		case db.ImportItemPending:
			p.Pending = row.Count
		case db.ImportItemImported:
			p.Imported = row.Count
			p.WithDropped = row.WithDropped
		case db.ImportItemSkipped:
			p.Skipped = row.Count
		case db.ImportItemFailed:
			p.Failed = row.Count
		}
	}
	return p
}

// loadImportJob reads :id, answering 400/404/500 itself.
func (server *Server) loadImportJob(c *gin.Context) (db.ImportJob, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid import id"})
		return db.ImportJob{}, false
	}
	job, err := server.store.GetImportJob(c.Request.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "import not found"})
		return db.ImportJob{}, false
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the import"})
		return db.ImportJob{}, false
	}
	return job, true
}

func (server *Server) respondImportJob(c *gin.Context, status int, job db.ImportJob) {
	resp, err := server.importJobResponse(c, job)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the import"})
		return
	}
	c.JSON(status, gin.H{"import": resp})
}

// getImport handles GET /imports/:id (the page polls it while the job runs).
func (server *Server) getImport(c *gin.Context) {
	job, ok := server.loadImportJob(c)
	if !ok {
		return
	}
	server.respondImportJob(c, http.StatusOK, job)
}

// ImportListItem is one recent import.
type ImportListItem struct {
	ID         int64           `json:"id"`
	Source     string          `json:"source"`
	FileName   string          `json:"file_name"`
	SiteURL    string          `json:"site_url"`
	Status     string          `json:"status"`
	Error      string          `json:"error,omitempty"`
	Summary    json.RawMessage `json:"summary"`
	CreatedAt  time.Time       `json:"created_at"`
	FinishedAt *time.Time      `json:"finished_at"`
	Progress   importProgress  `json:"progress"`
}

// listImports handles GET /imports: the recent imports, newest first.
func (server *Server) listImports(c *gin.Context) {
	ctx := c.Request.Context()
	rows, err := server.store.ListImportJobs(ctx, importListLimit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list imports"})
		return
	}
	out := make([]ImportListItem, 0, len(rows))
	for _, row := range rows {
		counts, err := server.store.CountImportItemsByStatus(ctx, row.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list imports"})
			return
		}
		out = append(out, ImportListItem{
			ID: row.ID, Source: row.Source, FileName: row.FileName, SiteURL: row.SiteUrl, Status: row.Status,
			Error: row.Error, Summary: row.Summary, CreatedAt: row.CreatedAt, FinishedAt: nullTimePtr(row.FinishedAt),
			Progress: progressOf(counts),
		})
	}
	c.JSON(http.StatusOK, gin.H{"imports": out})
}

// ImportItemResponse is one row of an import's report.
type ImportItemResponse struct {
	ID          int64           `json:"id"`
	Position    int32           `json:"position"`
	Type        string          `json:"type"`
	Title       string          `json:"title"`
	Status      string          `json:"status"`
	Reason      string          `json:"reason,omitempty"`
	PostID      *int64          `json:"post_id"`
	PostType    string          `json:"post_type,omitempty"`
	PostStatus  string          `json:"post_status,omitempty"`
	Result      json.RawMessage `json:"result"`
	ProcessedAt *time.Time      `json:"processed_at"`
}

// listImportItems handles GET /imports/:id/items?status=&dropped=true&limit=&offset=.
func (server *Server) listImportItems(c *gin.Context) {
	job, ok := server.loadImportJob(c)
	if !ok {
		return
	}
	status := c.Query("status")
	switch status {
	case "", db.ImportItemPending, db.ImportItemImported, db.ImportItemSkipped, db.ImportItemFailed:
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid status"})
		return
	}
	limit, offset := 50, 0
	if v, err := strconv.Atoi(c.DefaultQuery("limit", "50")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	if v, err := strconv.Atoi(c.DefaultQuery("offset", "0")); err == nil && v >= 0 {
		offset = v
	}
	rows, err := server.store.ListImportItems(c.Request.Context(), db.ListImportItemsParams{
		JobID: job.ID, Status: status, DroppedOnly: c.Query("dropped") == "true", Lim: int32(limit), Off: int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list the report"})
		return
	}
	out := make([]ImportItemResponse, 0, len(rows))
	for _, row := range rows {
		item := ImportItemResponse{
			ID: row.ID, Position: row.Position, Type: row.WpType, Title: row.Title, Status: row.Status,
			Reason: row.Reason, Result: row.Result, ProcessedAt: nullTimePtr(row.ProcessedAt),
			PostType: row.PostType.String, PostStatus: row.PostStatus.String,
		}
		if row.PostID.Valid {
			id := row.PostID.Int64
			item.PostID = &id
		}
		out = append(out, item)
	}
	c.JSON(http.StatusOK, gin.H{"items": out, "limit": limit, "offset": offset})
}

// StartImportRequest is the mapping: each author's login → a member's id (0 = the admin
// starting the import), each export post type → a GoLive post type ("" = not imported).
type StartImportRequest struct {
	Authors map[string]int64  `json:"authors" binding:"max=1000"`
	Types   map[string]string `json:"types" binding:"required,max=100"`
}

// importMapping is the stored mapping (import_jobs.mapping).
type importMapping struct {
	Authors    map[string]int64  `json:"authors"`
	Types      map[string]string `json:"types"`
	ImporterID int64             `json:"importer_id"`
}

// startImport handles POST /imports/:id/start: save the mapping and queue the job.
func (server *Server) startImport(c *gin.Context) {
	job, ok := server.loadImportJob(c)
	if !ok {
		return
	}
	var req StartImportRequest
	if !bindJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if job.Status != db.ImportJobMapping {
		c.JSON(http.StatusConflict, gin.H{"code": "already_started", "error": "This import has already started"})
		return
	}
	mapping := importMapping{Authors: map[string]int64{}, Types: map[string]string{}, ImporterID: caller.ID}
	for login, userID := range req.Authors {
		if userID == 0 || userID == caller.ID {
			mapping.Authors[login] = 0
			continue
		}
		u, err := server.store.GetUser(ctx, userID)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !hasRole(u, contentRoles...)) {
			c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_author", "error": "Posts can only be given to a member who writes content", "fields": gin.H{"authors": login}})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check the authors"})
			return
		}
		mapping.Authors[login] = userID
	}
	for wpType, target := range req.Types {
		if target == "" {
			mapping.Types[wpType] = ""
			continue
		}
		pt, err := server.store.GetPostType(ctx, target)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !pt.IsActive) {
			c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_type", "error": "Not a post type of this site", "fields": gin.H{"types": wpType}})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check the post types"})
			return
		}
		mapping.Types[wpType] = pt.Name
	}
	encoded, err := json.Marshal(mapping)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the mapping"})
		return
	}
	started, err := server.store.SetImportJobMapping(ctx, db.SetImportJobMappingParams{ID: job.ID, Mapping: encoded})
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusConflict, gin.H{"code": "already_started", "error": "This import has already started"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start the import"})
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb: db.ActivityImportStarted, ObjectType: db.ActivityObjectImport, ObjectID: job.ID,
		Payload: map[string]any{"source": job.Source},
	})
	server.respondImportJob(c, http.StatusOK, started)
}

// cancelImport handles POST /imports/:id/cancel: stop. What's imported stays.
func (server *Server) cancelImport(c *gin.Context) {
	job, ok := server.loadImportJob(c)
	if !ok {
		return
	}
	cancelled, err := server.store.CancelImportJob(c.Request.Context(), job.ID)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusConflict, gin.H{"code": "finished", "error": "This import has already finished"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to stop the import"})
		return
	}
	_ = server.store.DeleteImportFiles(c.Request.Context(), job.ID)
	server.respondImportJob(c, http.StatusOK, cancelled)
}

// deleteImport handles DELETE /imports/:id: discard a job that isn't running (its report;
// the posts and media it made stay).
func (server *Server) deleteImport(c *gin.Context) {
	job, ok := server.loadImportJob(c)
	if !ok {
		return
	}
	n, err := server.store.DeleteImportJob(c.Request.Context(), job.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete the import"})
		return
	}
	if n == 0 {
		c.JSON(http.StatusConflict, gin.H{"code": "running", "error": "Stop the import before deleting it"})
		return
	}
	c.Status(http.StatusNoContent)
}

// importNotice is the editor's notice for an imported post.
type importNotice struct {
	ItemID      int64                `json:"item_id"`
	Dropped     []importDropped      `json:"dropped"`
	MediaFailed []importMediaFailure `json:"media_failed"`
}

// getImportNotice handles GET /posts/:id/import-notice: the blocks the import left out of
// the post (with their original) until dismissed; 404 when there are none.
func (server *Server) getImportNotice(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	if !server.authorizePost(c, postID, canReadPost) {
		return
	}
	row, err := server.store.GetImportNoticeForPost(c.Request.Context(), sql.NullInt64{Int64: postID, Valid: true})
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "no import notice"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the import notice"})
		return
	}
	var result importItemResult
	_ = json.Unmarshal(row.Result, &result)
	c.JSON(http.StatusOK, gin.H{"notice": importNotice{
		ItemID: row.ID, Dropped: orEmpty(result.Dropped), MediaFailed: orEmpty(result.MediaFailed),
	}})
}

func orEmpty[T any](list []T) []T {
	if list == nil {
		return []T{}
	}
	return list
}

// dismissImportNotice handles POST /posts/:id/import-notice/dismiss {item_id}.
func (server *Server) dismissImportNotice(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	var req struct {
		ItemID int64 `json:"item_id" binding:"required,min=1"`
	}
	if !bindJSON(c, &req) {
		return
	}
	if !server.authorizePost(c, postID, canReadPost) {
		return
	}
	if _, err := server.store.DismissImportNotice(c.Request.Context(), db.DismissImportNoticeParams{
		ID: req.ItemID, PostID: sql.NullInt64{Int64: postID, Valid: true},
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to dismiss the notice"})
		return
	}
	c.Status(http.StatusNoContent)
}

// importItemResult is import_items.result: what the import did with the item.
type importItemResult struct {
	Dropped     []importDropped      `json:"dropped,omitempty"`
	MediaFailed []importMediaFailure `json:"media_failed,omitempty"`
	Notes       []string             `json:"notes,omitempty"`
	// Redirects are the old paths now redirecting to the post.
	Redirects []string `json:"redirects,omitempty"`
	// Slug is the post's slug when it isn't the export's (taken here already).
	Slug string `json:"slug,omitempty"`
	// PostID of an earlier import, for a skipped item.
	PostID int64 `json:"post_id,omitempty"`
	// Error is a failed item's message.
	Error string `json:"error,omitempty"`
	// PublishRefused is a plugin's reason for keeping a published post a draft (#459).
	PublishRefused string `json:"publish_refused,omitempty"`
}
