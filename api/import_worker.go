package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/importer"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
	"github.com/google/uuid"
)

// The importer's background job (#150), the scheduler's pattern (scheduled_publish.go):
// RunImports runs in every replica (IMPORT_INTERVAL, 0 = off) and claims one runnable job
// at a time (ClaimImportJob: FOR UPDATE SKIP LOCKED, a 2-minute lease renewed per item, a
// new token per claim). A claim first makes the export's terms (once per job: term_ids),
// then imports the items one by one in their order, each in its own transaction
// (ImportPostTx) fenced by the token, so:
//   - a crash or shutdown leaves the item in flight pending, and the next claim (after the
//     lease, here or on another replica) carries on from it; downloads already made are
//     found again (import_media);
//   - a stopped job (POST /imports/:id/cancel) fails the next fenced write and ends;
//   - an item whose key an earlier import made into a post that still exists is skipped,
//     so running the same file again imports nothing twice.

// RunImports runs import jobs until ctx is done.
func (server *Server) RunImports(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		server.logger.Info("the importer is off in this process (IMPORT_INTERVAL=0)")
		return
	}
	server.logger.Info("importer started", "interval", interval.String())
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		for server.runImportRound(ctx) && ctx.Err() == nil {
		}
		select {
		case <-ctx.Done():
			server.logger.Info("importer stopped")
			return
		case <-ticker.C:
		}
	}
}

// runImportRound claims one runnable job and runs it; false when there was none.
func (server *Server) runImportRound(ctx context.Context) bool {
	job, err := server.store.ClaimImportJob(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		if ctx.Err() == nil {
			server.logger.Warn("import_claim_failed", "error", err)
		}
		return false
	}
	server.runImportJob(ctx, job)
	return true
}

// importRun is one claim of a job.
type importRun struct {
	server  *Server
	ctx     context.Context
	log     *slog.Logger
	job     db.ImportJob
	mapping importMapping
	terms   map[string]int64
	// structure and the categories' slugs, for the redirects' new paths.
	structure     string
	categorySlugs map[int64]string
	reusable      map[int64]string
	media         *importJobMedia
	baseURL       string
}

func (server *Server) runImportJob(ctx context.Context, job db.ImportJob) {
	log := server.logger.With("import_id", job.ID, "request_id", "import-"+uuid.NewString())
	run := &importRun{server: server, ctx: ctx, log: log, job: job, terms: map[string]int64{}, categorySlugs: map[int64]string{}, reusable: map[int64]string{}}
	if err := json.Unmarshal(job.Mapping, &run.mapping); err != nil || run.mapping.ImporterID == 0 {
		run.finish(db.ImportJobFailed, "invalid_mapping")
		return
	}
	_ = json.Unmarshal(job.Blocks, &run.reusable)
	settings, err := server.store.GetSettings(ctx)
	if err != nil {
		log.Warn("import_settings_failed", "error", err)
		return // the lease runs out and the job is tried again
	}
	run.structure = settings.PostUrlStructure
	if base, err := server.config.PublicSiteURL(); err == nil && base != "" {
		run.baseURL = base
	} else {
		run.baseURL = "http://localhost"
	}
	if err := run.ensureTerms(); err != nil {
		if errors.Is(err, db.ErrImportLeaseLost) {
			return
		}
		log.Warn("import_terms_failed", "error", err)
		return
	}
	run.media = server.newImportJobMedia(ctx, log, job, run.mapping.ImporterID)

	for ctx.Err() == nil {
		item, err := server.store.NextPendingImportItem(ctx, job.ID)
		if errors.Is(err, sql.ErrNoRows) {
			run.finish(db.ImportJobDone, "")
			return
		}
		if err != nil {
			log.Warn("import_next_item_failed", "error", err)
			return
		}
		if err := run.importItem(item); errors.Is(err, db.ErrImportLeaseLost) {
			log.Info("import_claim_lost")
			return
		} else if err != nil {
			log.Warn("import_item_failed", "item_id", item.ID, "error", err)
			return
		}
	}
}

// finish ends the job (fenced) and records it.
func (run *importRun) finish(status, code string) {
	n, err := run.server.store.FinishImportJob(run.ctx, db.FinishImportJobParams{ID: run.job.ID, LeaseToken: run.job.LeaseToken, Status: status, Error: code})
	if err != nil || n == 0 {
		return
	}
	_ = run.server.store.DeleteImportFiles(run.ctx, run.job.ID)
	counts, _ := run.server.store.CountImportItemsByStatus(run.ctx, run.job.ID)
	p := progressOf(counts)
	actor := int64(0)
	if run.job.CreatedBy.Valid {
		actor = run.job.CreatedBy.Int64
	}
	run.server.recordActivity(run.ctx, run.log, activityEvent{
		ActorID: actor, Verb: db.ActivityImportFinished, ObjectType: db.ActivityObjectImport, ObjectID: run.job.ID,
		Payload: map[string]any{"status": status, "imported": p.Imported, "skipped": p.Skipped, "failed": p.Failed},
	})
	run.log.Info("import_finished", "status", status, "imported", p.Imported, "skipped", p.Skipped, "failed", p.Failed)
}

// skip and fail end an item without a post (fenced).
func (run *importRun) end(item db.ImportItem, status, reason string, result importItemResult) error {
	encoded, _ := json.Marshal(result)
	n, err := run.server.store.FinishImportItem(run.ctx, db.FinishImportItemParams{
		ID: item.ID, Status: status, Reason: reason, Result: encoded, LeaseToken: run.job.LeaseToken,
		PostID: sql.NullInt64{Int64: result.PostID, Valid: result.PostID != 0},
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return db.ErrImportLeaseLost
	}
	return nil
}

// Reasons for skipped and failed items (import_items.reason).
const (
	importReasonImportedBefore = "imported_before"
	importReasonTypeSkipped    = "type_not_imported"
	importReasonInvalidBody    = "invalid_body"
	importReasonSaveFailed     = "save_failed"
	importReasonBadItem        = "unreadable"
)

func (run *importRun) importItem(item db.ImportItem) error {
	var it importer.Item
	if err := json.Unmarshal(item.Payload, &it); err != nil {
		return run.end(item, db.ImportItemFailed, importReasonBadItem, importItemResult{Error: "The item couldn’t be read"})
	}
	target := run.mapping.Types[it.Type]
	if target == "" {
		return run.end(item, db.ImportItemSkipped, importReasonTypeSkipped, importItemResult{})
	}
	if before, err := run.server.store.GetImportedPostBySourceKey(run.ctx, item.SourceKey); err == nil {
		return run.end(item, db.ImportItemSkipped, importReasonImportedBefore, importItemResult{PostID: before.PostID})
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if n, err := run.server.store.RenewImportJobLease(run.ctx, db.RenewImportJobLeaseParams{ID: run.job.ID, LeaseToken: run.job.LeaseToken}); err != nil {
		return err
	} else if n == 0 {
		return db.ErrImportLeaseLost
	}

	owner := run.ownerFor(it.Author)
	run.media.dir = it.Dir
	conv := convertImportedContent(it.Content, importConvertOptions{Autop: it.Autop, Media: run.media, Reusable: run.reusable})
	result := importItemResult{Dropped: conv.Dropped, MediaFailed: conv.MediaFailed, Notes: conv.Notes}

	doc, err := roundTripBlockDoc(conv.Doc)
	if err == nil {
		err = doc.prepareForStore(run.server.themeBlocks)
	}
	var blockDoc []byte
	if err == nil {
		blockDoc, err = json.Marshal(doc)
	}
	if err == nil && len(blockDoc) > int(blockDocBodyLimit) {
		err = fmt.Errorf("the body is larger than GoLive stores (%d MB)", blockDocBodyLimit>>20)
	}
	if err != nil {
		result.Error = sentenceCase(err.Error())
		return run.end(item, db.ImportItemFailed, importReasonInvalidBody, result)
	}

	// Terms: the first category the export lists (one per post, #331), every tag.
	var termIDs []int64
	categorySlug := ""
	extraCategories := 0
	for _, ref := range it.Terms {
		id, ok := run.terms[ref.Taxonomy+":"+ref.Slug]
		if !ok {
			continue
		}
		if ref.Taxonomy == db.CategoryTaxonomy {
			if categorySlug != "" {
				extraCategories++
				continue
			}
			categorySlug = run.categorySlugs[id]
		}
		termIDs = append(termIDs, id)
	}
	if extraCategories > 0 {
		result.Notes = append(result.Notes, "extra_categories")
	}
	if target != "post" {
		categorySlug = ""
	}

	featuredID, featuredPath := int64(0), ""
	if it.FeaturedID != 0 || it.FeaturedPath != "" {
		media, failure := run.media.resolve(importMediaRef{Kind: importMediaImage, AttachmentID: it.FeaturedID, URL: it.FeaturedPath})
		if failure != nil {
			failure.After = "Featured image"
			result.MediaFailed = append(result.MediaFailed, *failure)
		} else {
			featuredID, featuredPath = media.ID, media.Path
		}
	}

	title := truncateRunes(strings.TrimSpace(it.Title), 255)
	if title == "" {
		title = "(untitled)"
	}
	baseSlug := normalizePostSlug(firstNonEmptyString(it.Slug, it.Title))
	slug, err := run.server.generateUniqueSlug(run.ctx, baseSlug, 0)
	if err != nil {
		result.Error = "No free address for this post"
		return run.end(item, db.ImportItemFailed, importReasonSaveFailed, result)
	}
	if it.Slug != "" && slug != normalizePostSlug(it.Slug) {
		result.Slug = slug
	}
	postURL, err := run.server.generateUniqueURL(run.ctx, run.baseURL+"/"+target+"/"+slug)
	if err != nil {
		result.Error = "No free address for this post"
		return run.end(item, db.ImportItemFailed, importReasonSaveFailed, result)
	}
	parent := sql.NullInt64{}
	if it.ParentID != 0 {
		if id, err := run.server.store.GetImportedPostByWpID(run.ctx, db.GetImportedPostByWpIDParams{JobID: run.job.ID, WpID: it.ParentID}); err == nil {
			parent = sql.NullInt64{Int64: id, Valid: true}
		}
	}

	publish := it.Status == importer.StatusPublished
	if publish {
		refusal, err := run.server.runPublishGuards(run.ctx, run.log, func(context.Context) (pluginsdk.PublishCandidate, error) {
			return pluginsdk.PublishCandidate{PostType: target, ActorID: owner, Via: pluginsdk.PublishViaImport, BlockDoc: blockDoc}, nil
		})
		switch {
		case err != nil:
			publish = false
			result.Notes = append(result.Notes, "publish_unchecked")
		case refusal != nil:
			publish = false
			result.PublishRefused = refusal.Reason
		}
	}
	if it.StatusNote != "" {
		result.Notes = append(result.Notes, "was_"+it.StatusNote)
	}

	created := it.Date
	if created.IsZero() {
		created = time.Now().UTC()
	}
	modified := it.Modified
	if modified.IsZero() || modified.Before(created) {
		modified = created
	}
	user, err := run.server.store.GetUser(run.ctx, owner)
	if errors.Is(err, sql.ErrNoRows) {
		// The importer was removed since: nobody to own the post. Failed, not retried.
		result.Error = "The member who started the import was removed"
		return run.end(item, db.ImportItemFailed, importReasonSaveFailed, result)
	}
	if err != nil {
		return err
	}
	snippets := conv.Snippets
	contentMedia := doc.contentMediaUses()
	oldPaths := importOldPaths(it)
	tx, err := run.server.store.ImportPostTx(run.ctx, db.ImportPostTxParams{
		JobID: run.job.ID, LeaseToken: run.job.LeaseToken, ItemID: item.ID, SourceKey: item.SourceKey,
		CreatePostsParams: db.CreatePostsParams{
			Title: title, Description: truncateRunes(strings.TrimSpace(it.Excerpt), 500), UserID: user.ID, Username: user.Username,
			Url: postURL, PostType: target, PostStatus: "draft", PostParent: parent, Slug: slug, BlockDoc: blockDoc,
		},
		AuthorIDs:       []int64{user.ID},
		TermIDs:         termIDs,
		FeaturedMediaID: featuredID, FeaturedMediaPath: featuredPath,
		ContentMedia: contentMedia,
		Snippets:     snippets,
		CreatedAt:    created, ChangedAt: modified,
		Publish:        publish,
		PublishedBy:    sql.NullInt64{Int64: run.mapping.ImporterID, Valid: true},
		PublishedMedia: publishedContentMedia,
		Redirects: func(post db.Post) []db.AddRedirectParams {
			to := postSitePath(post.PostType, post.Slug, post.ID, run.structure, categorySlug)
			var out []db.AddRedirectParams
			for _, from := range oldPaths {
				if from != to {
					out = append(out, db.AddRedirectParams{FromPath: from, ToPath: to, StatusCode: 301, Source: db.RedirectSourceImport, CreatedBy: run.mapping.ImporterID})
				}
			}
			return out
		},
		Result: func(post db.Post, redirects []db.Redirect) json.RawMessage {
			for _, r := range redirects {
				result.Redirects = append(result.Redirects, r.FromPath)
			}
			encoded, _ := json.Marshal(result)
			return encoded
		},
	})
	var before db.ErrImportedBefore
	switch {
	case errors.As(err, &before):
		return run.end(item, db.ImportItemSkipped, importReasonImportedBefore, importItemResult{PostID: before.PostID})
	case errors.Is(err, db.ErrImportLeaseLost):
		return err
	case err != nil && isUniqueViolation(err):
		result.Error = "Another post took this address meanwhile"
		return run.end(item, db.ImportItemFailed, importReasonSaveFailed, result)
	case err != nil:
		run.log.Warn("import_post_failed", "item_id", item.ID, "error", err)
		result.Error = "The post couldn’t be saved"
		return run.end(item, db.ImportItemFailed, importReasonSaveFailed, result)
	}
	if publish {
		// After the commit, like the scheduler's (public_cache.go, #185): lists and feeds
		// show the post now.
		run.server.purgePublicCache(run.ctx, run.log, "import")
	}
	run.server.recordActivity(run.ctx, run.log, activityEvent{
		ActorID: run.mapping.ImporterID, Verb: db.ActivityImported, ObjectType: db.ActivityObjectPost, ObjectID: tx.Post.ID,
		Payload: map[string]any{"post_type": tx.Post.PostType, "import_id": run.job.ID, "published": publish},
	})
	return nil
}

// ownerFor is the member an author's posts go to: the mapping's, else the importer. A
// member removed (or demoted) since the mapping gives the importer too.
func (run *importRun) ownerFor(login string) int64 {
	if id := run.mapping.Authors[login]; id != 0 {
		if u, err := run.server.store.GetUser(run.ctx, id); err == nil && hasRole(u, contentRoles...) {
			return id
		}
	}
	return run.mapping.ImporterID
}

// roundTripBlockDoc gives the converted doc the shapes JSON decoding gives every stored
// doc (numbers float64, lists []interface{}), which the sanitizer and checks expect.
func roundTripBlockDoc(doc BlockDocV1) (BlockDocV1, error) {
	raw, err := json.Marshal(doc)
	if err != nil {
		return BlockDocV1{}, err
	}
	var out BlockDocV1
	if err := json.Unmarshal(raw, &out); err != nil {
		return BlockDocV1{}, err
	}
	if out.BlocksOrder == nil {
		out.BlocksOrder = []string{}
	}
	if out.Blocks == nil {
		out.Blocks = map[string]interface{}{}
	}
	return out, nil
}

func sentenceCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// importOldPaths are the item's old site paths (its permalink, its aliases), normalized
// like a redirect's from_path. A link by query (?p=12) has no path to redirect.
func importOldPaths(it importer.Item) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range append([]string{it.Link}, it.Aliases...) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil {
			continue
		}
		from, problem := normalizeSitePath(u.Path)
		if problem != "" || from == "/" || seen[from] {
			continue
		}
		seen[from] = true
		out = append(out, from)
	}
	return out
}

// ensureTerms makes (or finds) the export's categories and tags, once per job.
func (run *importRun) ensureTerms() error {
	if len(run.job.TermIds.RawMessage) > 0 && run.job.TermIds.Valid {
		var stored struct {
			IDs   map[string]int64  `json:"ids"`
			Slugs map[string]string `json:"slugs"`
		}
		if err := json.Unmarshal(run.job.TermIds.RawMessage, &stored); err == nil {
			run.terms = stored.IDs
			for id, slug := range stored.Slugs {
				if n, err := strconv.ParseInt(id, 10, 64); err == nil {
					run.categorySlugs[n] = slug
				}
			}
			return nil
		}
	}
	var terms []importer.Term
	_ = json.Unmarshal(run.job.Terms, &terms)
	if err := run.server.importTerms(run.ctx, terms, run.terms, run.categorySlugs); err != nil {
		return err
	}
	slugs := map[string]string{}
	for id, slug := range run.categorySlugs {
		slugs[strconv.FormatInt(id, 10)] = slug
	}
	encoded, err := json.Marshal(map[string]any{"ids": run.terms, "slugs": slugs})
	if err != nil {
		return err
	}
	n, err := run.server.store.SetImportJobTermIDs(run.ctx, db.SetImportJobTermIDsParams{ID: run.job.ID, LeaseToken: run.job.LeaseToken, TermIds: nullJSON(encoded)})
	if err != nil {
		return err
	}
	if n == 0 {
		return db.ErrImportLeaseLost
	}
	return nil
}
