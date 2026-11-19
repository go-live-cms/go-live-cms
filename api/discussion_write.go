// discussion_write is the public write path of reader comments (#524, design
// docs/design/reader-comments.md 3.3, 4.2, 5, 9.2): the API's first anonymous writes
// outside /auth.
//
// # Who calls these
//
// Nothing but the web's endpoints under /gl-comments/ (9.4): /public is server-side only
// (the web's production proxy forwards /api/v1 and /uploads, never /public). The endpoint
// checks the origin, maps the form to JSON, forwards the browser's address in
// X-Forwarded-For (read only from TRUSTED_PROXIES, so the limits key on the browser) and
// the gl_commenter cookie's keys as GoLive-Commenter-Key. The API never sets a cookie.
//
// # No address enumeration
//
// A comment sent without a valid browser key for its address answers the same 202
// {"outcome": "confirm_email"} whether the address is unknown, known, verified, blocked,
// in its mail cooldown or over its unconfirmed cap. Everything before the answer reads
// only the post (settings, the post and its type, the parent, the post's pending count)
// and, when keys are sent, looks them up for the typed address; everything that reads
// or writes the address (the commenter, the cap, the guard, storing, the token, the mail)
// runs after the response (runInBackground), as open signup does (#191). A key for
// another address, an expired one or an unknown one is no key. Only a browser holding a
// key for the address (which only the address's owner can get, 3.3) learns more:
// "pending" or "published".
//
// # The confirmation
//
// The mail carries nothing the sender typed (no name, no text: the form must not mail
// anyone a message), only the site's title, the post's title and URL and the link,
// PUBLIC_BASE_URL/comments/confirm#token=…. The page POSTs the token on its button (never
// on load, #191's rule, so a mail scanner can't spend it). Confirming publishes or holds
// that comment alone (4.2), verifies the address, and gives the confirming browser a key
// (set_key, which the web endpoint turns into the cookie). The address's other
// unconfirmed comments are only listed, for the person holding the link, each published
// or discarded one by one with that key (3.3 step 5): anyone can type any address, so
// they may be someone else's.
//
// # Spam and holds
//
// decideReaderComment (discussion_rules.go). The honeypot, a spam word, a blocked
// commenter and a guard's spam send a comment to spam silently: the answer is the usual
// one, and an unconfirmed one is stored as spam with no mail at all. A guard's hold is
// stored with the unconfirmed comment and applied on confirmation. The plugin guard
// itself is #530 (discussion_guard.go has the hook).
//
// # Logs
//
// Ids and outcomes only: never an address, a name, the text, a token or a key.
package api

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

const (
	// readerCommentConfirmTTL: an unconfirmed comment (and its link) expires (3.3 step 4).
	readerCommentConfirmTTL = 48 * time.Hour
	// readerCommentMailCooldown: at most one confirmation mail per address this often
	// (5.3); later comments are stored and mail nothing.
	readerCommentMailCooldown = 10 * time.Minute
	// readerCommentKeyTTL is a browser key's life (3.3 step 3), the cookie's Max-Age too.
	readerCommentKeyTTL = 365 * 24 * time.Hour
	// readerCommentUnconfirmedCap and readerCommentPendingCap are 5.3's volume caps.
	readerCommentUnconfirmedCap = 20
	readerCommentPendingCap     = 200
	// commenterKeyHeader carries the gl_commenter cookie's keys, comma-separated.
	commenterKeyHeader = "GoLive-Commenter-Key"
	// commenterKeysMax: a browser keeps keys for at most this many addresses (3.3).
	commenterKeysMax = 5
	// readerCommentConfirmPath is the reader page the mail links (11.6, #525).
	readerCommentConfirmPath = "/comments/confirm"
	// readerCommentExcerptMax: the confirm page shows the address's other comments by
	// their first 100 characters (3.3 step 5).
	readerCommentExcerptMax = 100
)

// The outcomes a write answers (9.2).
const (
	readerCommentOutcomeConfirm   = "confirm_email"
	readerCommentOutcomePending   = "pending"
	readerCommentOutcomePublished = "published"
)

// readerCommentRequest is POST /public/posts/:id/comments's body. Name and body are
// checked by the text rules (6.3) for their own codes; the binding bounds them. Website is
// the honeypot (5.2): any value sends the comment to spam.
type readerCommentRequest struct {
	Name          string `json:"name" binding:"max=200"`
	Email         string `json:"email" binding:"required,email,max=254"`
	Body          string `json:"body" binding:"max=8000"`
	ParentID      *int64 `json:"parent_id" binding:"omitempty,min=1"`
	NotifyReplies bool   `json:"notify_replies"`
	Website       string `json:"website" binding:"max=2000"`
}

// readerCommentConfirmRequest is POST /public/discussion/confirm's body.
type readerCommentConfirmRequest struct {
	Token string `json:"token" binding:"required,max=100"`
}

// readerCommentUnconfirmedRequest is POST /public/discussion/unconfirmed/:id's body.
type readerCommentUnconfirmedRequest struct {
	Action string `json:"action" binding:"required,oneof=publish discard"`
}

// readerCommentTarget is a post that takes comments now, and the thread a reply joins.
type readerCommentTarget struct {
	Settings db.Setting
	Post     db.GetReaderCommentPostRow
	ParentID sql.NullInt64
	RootID   sql.NullInt64
}

// path is the post's public path.
func (t readerCommentTarget) path() string {
	return readerCommentPostPath(t.Settings, t.Post.PostType, t.Post.Slug, t.Post.ID, t.Post.CategorySlug)
}

func readerCommentPostPath(settings db.Setting, postType, slug string, id int64, categorySlug string) string {
	return postHref(postType, slug, id, settings.PostUrlStructure, categorySlug)
}

// readerCommentDraft is a validated comment, for the work before and after the response.
type readerCommentDraft struct {
	Target        readerCommentTarget
	Name          string
	Email         string
	EmailLower    string
	Body          string
	NotifyReplies bool
	Honeypot      bool
	IP            string
	UserAgent     string
	HasKey        bool
}

func (d readerCommentDraft) candidate() readerCommentCandidate {
	return readerCommentCandidate{
		PostID: d.Target.Post.ID, ParentID: d.Target.ParentID.Int64, Name: d.Name, Email: d.Email,
		Body: d.Body, IP: d.IP, UserAgent: d.UserAgent, HasBrowserKey: d.HasKey,
	}
}

func respondDiscussionError(c *gin.Context, status int, code, message string) {
	c.Header("Cache-Control", "no-store")
	c.JSON(status, gin.H{"error": message, "code": code})
}

func respondReaderCommentField(c *gin.Context, field, code string) {
	messages := map[string]string{
		readerCommentBodyInvalid:  "the comment holds characters that can't be shown",
		readerCommentBodyTooShort: "the comment is too short",
		readerCommentBodyTooLong:  "the comment is too long",
		readerCommentNameInvalid:  "the name must be one line of plain text",
		readerCommentNameRequired: "a name is required",
		readerCommentNameTooLong:  "the name is too long",
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusBadRequest, gin.H{"error": field + " " + messages[code], "code": code, "fields": gin.H{field: messages[code]}})
}

// discussionEnabled answers 409 comments_off (or 500) unless comments are on for the site.
func (server *Server) discussionEnabled(c *gin.Context) (db.Setting, bool) {
	settings, err := server.store.GetSettings(c.Request.Context())
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		server.requestLog(c).Error("reader comment: reading settings failed", "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return settings, false
	}
	if err != nil || !settings.CommentsEnabled {
		respondDiscussionError(c, http.StatusConflict, "comments_off", "comments are off")
		return settings, false
	}
	return settings, true
}

// readerCommentPostOpen answers for a post that doesn't take comments now: 404 not_found
// for one /public doesn't serve (not published, its type not public), 409 comments_off or
// comments_closed (with closed_at when a timer closed it) from the state rule applied to
// the clock (12.4).
func (server *Server) readerCommentPostOpen(c *gin.Context, settings db.Setting, postID int64) (db.GetReaderCommentPostRow, bool) {
	ctx := c.Request.Context()
	post, err := server.store.GetReaderCommentPost(ctx, postID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && post.PostStatus != postStatusPublished) {
		respondDiscussionError(c, http.StatusNotFound, "not_found", "post not found")
		return post, false
	}
	if err != nil {
		server.requestLog(c).Error("reader comment: reading the post failed", "post_id", postID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return post, false
	}
	postType, err := server.store.GetPostType(ctx, post.PostType)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		server.requestLog(c).Error("reader comment: reading the post type failed", "post_id", postID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return post, false
	}
	if err != nil || !postType.Public || !postType.IsActive {
		respondDiscussionError(c, http.StatusNotFound, "not_found", "post not found")
		return post, false
	}
	setting := discussionSetting(discussionInputs(settings, postType, db.Post{Discussion: post.Discussion, FirstPublishedAt: post.FirstPublishedAt}))
	switch discussionState(setting, time.Now()) {
	case discussionStateOff:
		respondDiscussionError(c, http.StatusConflict, "comments_off", "comments are off for this post")
		return post, false
	case discussionStateClosed:
		c.Header("Cache-Control", "no-store")
		body := gin.H{"error": "comments on this post are closed", "code": "comments_closed"}
		if setting.ClosesAt != nil {
			body["closed_at"] = setting.ClosesAt.UTC().Format(time.RFC3339)
		}
		c.JSON(http.StatusConflict, body)
		return post, false
	}
	return post, true
}

// readerCommentQueueFull answers 429 comments_busy when the post's queue is full (5.3).
func (server *Server) readerCommentQueueFull(c *gin.Context, postID int64) bool {
	pending, err := server.store.CountPendingReaderCommentsForPost(c.Request.Context(), postID)
	if err != nil {
		server.requestLog(c).Error("reader comment: counting pending comments failed", "post_id", postID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return true
	}
	if pending >= readerCommentPendingCap {
		respondDiscussionError(c, http.StatusTooManyRequests, "comments_busy", "too many comments are waiting for review on this post")
		return true
	}
	return false
}

// readerCommentTargetFor checks everything about the post and the parent, answering
// itself when the comment can't go there. None of it reads the address. The post's
// queue (comments_busy) is checked by the caller once it knows the comment would wait
// in it, so a flooded queue never refuses a comment the rules would publish.
func (server *Server) readerCommentTargetFor(c *gin.Context, postID int64, parentID *int64) (readerCommentTarget, bool) {
	settings, ok := server.discussionEnabled(c)
	if !ok {
		return readerCommentTarget{}, false
	}
	post, ok := server.readerCommentPostOpen(c, settings, postID)
	if !ok {
		return readerCommentTarget{}, false
	}
	target := readerCommentTarget{Settings: settings, Post: post}
	if parentID != nil {
		// A reply goes under an approved, shown comment of this post only (9.2).
		parent, err := server.store.GetReaderComment(c.Request.Context(), *parentID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			server.requestLog(c).Error("reader comment: reading the parent failed", "post_id", postID, "error", err)
			respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
			return target, false
		}
		if err != nil || parent.PostID != postID || parent.Status != db.ReaderCommentApproved || parent.RemovedAt.Valid {
			respondDiscussionError(c, http.StatusNotFound, "parent_not_found", "the comment you replied to isn't available")
			return target, false
		}
		target.ParentID = sql.NullInt64{Int64: parent.ID, Valid: true}
		target.RootID = parent.RootID
		if !target.RootID.Valid {
			target.RootID = target.ParentID
		}
	}
	return target, true
}

// parseCommenterKeys reads GoLive-Commenter-Key: up to commenterKeysMax well-formed keys
// (each a 32-byte base64url value, as account tokens are), hashed for the lookup.
// Anything else is ignored.
func parseCommenterKeys(header string) [][]byte {
	var hashes [][]byte
	for _, key := range strings.Split(header, ",") {
		key = strings.TrimSpace(key)
		if hash, ok := parseAccountToken(key); ok {
			hashes = append(hashes, hash)
			if len(hashes) == commenterKeysMax {
				break
			}
		}
	}
	return hashes
}

// createPublicReaderComment stores a reader comment (9.2).
//
// Request: {"name", "email", "body", "parent_id"?, "notify_replies", "website"} and the
// GoLive-Commenter-Key header.
//
// Returns:
//   - 202 {"outcome": "confirm_email"}: no valid key for the address (the same for any
//     address, see the file header)
//   - 202 {"outcome": "pending", "comment_id"} or 201 {"outcome": "published",
//     "comment_id", "comment_url"}: a valid key
//   - 400: a field (code body_*, name_*, or the binding's), 404 not_found or
//     parent_not_found, 409 comments_off or comments_closed, 429 (rate limit, or
//     comments_busy)
func (server *Server) createPublicReaderComment(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || postID <= 0 {
		respondDiscussionError(c, http.StatusNotFound, "not_found", "post not found")
		return
	}
	var req readerCommentRequest
	if !bindJSON(c, &req) {
		return
	}
	name, code := normalizeReaderCommentName(req.Name)
	if code != "" {
		respondReaderCommentField(c, "name", code)
		return
	}
	body, code := normalizeReaderCommentBody(req.Body)
	if code != "" {
		respondReaderCommentField(c, "body", code)
		return
	}
	email := strings.TrimSpace(req.Email)
	emailLower := normEmail(email)
	// Per client and address, never the address alone (#190).
	if !server.rateLimits.commentAddress.allow(c, clientKey(c.ClientIP())+"|"+emailLower) {
		return
	}
	target, ok := server.readerCommentTargetFor(c, postID, req.ParentID)
	if !ok {
		return
	}
	draft := readerCommentDraft{
		Target: target, Name: name, Email: email, EmailLower: emailLower, Body: body,
		NotifyReplies: req.NotifyReplies, Honeypot: strings.TrimSpace(req.Website) != "",
		IP: c.ClientIP(), UserAgent: c.Request.UserAgent(),
	}

	if keys := parseCommenterKeys(c.GetHeader(commenterKeyHeader)); len(keys) > 0 {
		commenter, err := server.store.GetCommenterByKeys(c.Request.Context(), db.GetCommenterByKeysParams{KeyHashes: keys, EmailLower: emailLower})
		switch {
		case err == nil:
			draft.HasKey = true
			server.createKeyedReaderComment(c, draft, commenter)
			return
		case !errors.Is(err, sql.ErrNoRows):
			server.requestLog(c).Error("reader comment: reading browser keys failed", "post_id", postID, "error", err)
			respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
			return
		}
		// A key for another address, expired or unknown: no key.
	}

	// The queue is the post's, not the address's: checking it here says nothing about
	// the address, and spares a confirmation mail for a post that can't take it.
	if server.readerCommentQueueFull(c, postID) {
		return
	}
	logger := server.requestLog(c)
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() { server.processUnconfirmedReaderComment(logger, draft) })
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, gin.H{"outcome": readerCommentOutcomeConfirm, "post_url": target.path()})
}

// readerCommentRules gathers what decideReaderComment reads about a commenter.
func (server *Server) readerCommentRules(ctx context.Context, settings db.Setting, commenter db.Commenter, name, body string, honeypot bool, guard readerCommentGuardVerdict) (readerCommentVerdict, error) {
	hasApproved, err := server.store.CommenterHasApprovedReaderComment(ctx, sql.NullInt64{Int64: commenter.ID, Valid: true})
	if err != nil {
		return readerCommentVerdict{}, err
	}
	members, err := server.store.ListMemberNames(ctx)
	if err != nil {
		return readerCommentVerdict{}, err
	}
	return decideReaderComment(readerCommentRuleInput{
		Name: name, Body: body, Honeypot: honeypot, Settings: settings, Commenter: commenter,
		HasApproved: hasApproved, MemberName: matchesMemberName(name, members), Guard: guard, Now: time.Now(),
	}), nil
}

// readerCommentParams is the row for a draft with a verdict.
func (server *Server) readerCommentParams(logger *slog.Logger, d readerCommentDraft, commenterID int64, status string, reason, detail sql.NullString) db.CreateReaderCommentParams {
	params := db.CreateReaderCommentParams{
		PostID: d.Target.Post.ID, ParentID: d.Target.ParentID, RootID: d.Target.RootID,
		CommenterID: sql.NullInt64{Int64: commenterID, Valid: true},
		DisplayName: d.Name, Body: d.Body, Status: status, HeldReason: reason, HeldDetail: detail,
		NotifyReplies: d.NotifyReplies,
	}
	if status == db.ReaderCommentApproved {
		params.ApprovedAt = sql.NullTime{Time: time.Now(), Valid: true}
	}
	// 7.2: a keyed hash of the network, never the address. Without it the comment is
	// still stored: the hash only feeds "N other commenters from this network".
	if hash, err := discussionNetworkHash(server.config.PasetoV4LocalKeyHex, d.IP); err == nil {
		params.NetworkHash = hash
	} else {
		logger.Warn("reader comment: no network hash", "error", err)
	}
	return params
}

// createKeyedReaderComment stores a comment whose browser holds the address's key: the
// rules decide at once (4.2).
func (server *Server) createKeyedReaderComment(c *gin.Context, d readerCommentDraft, commenter db.Commenter) {
	ctx := c.Request.Context()
	logger := server.requestLog(c)
	guard := server.guardReaderComment(ctx, logger, d.candidate())
	verdict, err := server.readerCommentRules(ctx, d.Target.Settings, commenter, d.Name, d.Body, d.Honeypot, guard)
	if err != nil {
		logger.Error("reader comment: reading the rules' inputs failed", "post_id", d.Target.Post.ID, "commenter_id", commenter.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return
	}
	// Only a comment that would wait in the queue is refused when it's full (5.3).
	if verdict.Status == db.ReaderCommentPending && server.readerCommentQueueFull(c, d.Target.Post.ID) {
		return
	}
	reason, detail := verdict.heldColumns()
	comment, err := server.store.CreateReaderCommentTx(ctx, db.CreateReaderCommentTxParams{
		Comment:           server.readerCommentParams(logger, d, commenter.ID, verdict.Status, reason, detail),
		VerifiedCommenter: true,
	})
	if errors.Is(err, db.ErrReaderCommentParentGone) {
		respondDiscussionError(c, http.StatusNotFound, "parent_not_found", "the comment you replied to isn't available")
		return
	}
	if err != nil {
		logger.Error("reader comment: storing failed", "post_id", d.Target.Post.ID, "commenter_id", commenter.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return
	}
	logger.Info("reader comment stored", "comment_id", comment.ID, "post_id", comment.PostID, "commenter_id", commenter.ID, "status", comment.Status, "held_reason", reason.String)
	c.Header("Cache-Control", "no-store")
	if comment.Status == db.ReaderCommentApproved {
		server.purgeAfterDiscussionChange(ctx, logger, c.FullPath())
		c.JSON(http.StatusCreated, gin.H{
			"outcome":     readerCommentOutcomePublished,
			"post_url":    d.Target.path(),
			"comment_id":  comment.ID,
			"comment_url": readerCommentURL(d.Target.path(), comment.ID),
		})
		return
	}
	// Spam answers as pending: it is silent (5.2).
	c.JSON(http.StatusAccepted, gin.H{"outcome": readerCommentOutcomePending, "comment_id": comment.ID, "post_url": d.Target.path()})
}

// readerCommentURL is a comment's link on its post (11.3).
func readerCommentURL(postPath string, id int64) string {
	return postPath + "#comment-" + strconv.FormatInt(id, 10)
}

// processUnconfirmedReaderComment does a keyless comment's work after the response:
// it stores the comment (unconfirmed, or spam) and mails the confirmation. Errors are only
// logged: the reader was answered already. Logs carry ids only.
func (server *Server) processUnconfirmedReaderComment(logger *slog.Logger, d readerCommentDraft) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*mailSendTimeout)
	defer cancel()
	postID := d.Target.Post.ID

	commenter, err := server.store.EnsureCommenter(ctx, db.EnsureCommenterParams{Email: d.Email, EmailLower: d.EmailLower, DisplayName: d.Name})
	if err != nil {
		logger.Error("reader comment: storing the commenter failed", "post_id", postID, "error", err)
		return
	}
	waiting, err := server.store.CountUnconfirmedReaderComments(ctx, db.CountUnconfirmedReaderCommentsParams{
		CommenterID: sql.NullInt64{Int64: commenter.ID, Valid: true}, CreatedAfter: time.Now().Add(-readerCommentConfirmTTL),
	})
	if err != nil {
		logger.Error("reader comment: counting unconfirmed comments failed", "post_id", postID, "commenter_id", commenter.ID, "error", err)
		return
	}
	if waiting >= readerCommentUnconfirmedCap {
		logger.Info("reader comment dropped: the address has too many unconfirmed comments", "post_id", postID, "commenter_id", commenter.ID)
		return
	}

	guard := server.guardReaderComment(ctx, logger, d.candidate())
	// Spam routes known now (blocked, honeypot, spam word, a guard's spam) store the
	// comment as spam and mail nothing: a bot's comment must not mail anyone. Holds wait
	// for the confirmation, which applies the rules then; a guard's hold is kept.
	spam := decideReaderComment(readerCommentRuleInput{
		Name: d.Name, Body: d.Body, Honeypot: d.Honeypot, Settings: readerCommentSpamOnly(d.Target.Settings),
		Commenter: commenter, Guard: guard, HasApproved: true, Now: time.Now(),
	})
	status := db.ReaderCommentUnconfirmed
	var reason, detail sql.NullString
	switch {
	case spam.Status == db.ReaderCommentSpam:
		status = db.ReaderCommentSpam
		reason, detail = spam.heldColumns()
	case guard.Action == readerCommentGuardHold:
		reason, detail = readerCommentVerdict{Reason: heldPlugin, Detail: guard.Reason}.heldColumns()
	}
	params := server.readerCommentParams(logger, d, commenter.ID, status, reason, detail)

	// Every unconfirmed comment gets a token; the cooldown below decides whether it is
	// mailed. It is taken only once the comment is stored, so a failed store doesn't use up
	// the address's one mail for the next ten minutes. A token never mailed is never
	// known: the comment is then published from the first link's page (3.3 step 5).
	var token string
	if status == db.ReaderCommentUnconfirmed {
		var hash []byte
		if token, hash, err = newAccountToken(); err != nil {
			logger.Error("reader comment: token generation failed", "post_id", postID, "error", err)
			return
		}
		params.ConfirmTokenHash = hash
	}
	comment, err := server.store.CreateReaderCommentTx(ctx, db.CreateReaderCommentTxParams{Comment: params})
	if err != nil {
		if errors.Is(err, db.ErrReaderCommentParentGone) {
			logger.Info("reader comment dropped: its parent went meanwhile", "post_id", postID, "commenter_id", commenter.ID)
			return
		}
		logger.Error("reader comment: storing failed", "post_id", postID, "commenter_id", commenter.ID, "error", err)
		return
	}
	logger.Info("reader comment stored", "comment_id", comment.ID, "post_id", postID, "commenter_id", commenter.ID, "status", comment.Status, "held_reason", reason.String)
	if status != db.ReaderCommentUnconfirmed {
		return
	}
	if !server.rateLimits.commentMail.allowSilently(ctx, d.EmailLower) {
		logger.Info("reader comment confirmation skipped: one was mailed to the address less than 10 minutes ago", "comment_id", comment.ID)
		return
	}

	title := d.Target.Settings.SiteTitle.String
	// To the address as this request typed it: the stored spelling is whoever typed it first.
	msg, err := mailer.RenderReaderCommentConfirm(d.Email, mailer.ReaderCommentConfirm{
		SiteTitle: title,
		PostTitle: d.Target.Post.Title,
		PostURL:   server.publicURL + d.Target.path(),
		Link:      server.accountLink(readerCommentConfirmPath, token),
		ExpiresIn: readerCommentConfirmTTL,
	})
	if err == nil {
		err = server.sendMail(ctx, msg)
	}
	if err != nil {
		logger.Error("reader comment confirmation email failed", "comment_id", comment.ID, "error", err)
		return
	}
	logger.Info("reader comment confirmation email sent", "comment_id", comment.ID)
}

// readerCommentSpamOnly is settings for the spam routes alone: no hold word, no link
// limit, no moderation mode, so decideReaderComment answers spam or approved.
func readerCommentSpamOnly(settings db.Setting) db.Setting {
	settings.CommentsHoldWords = nil
	settings.CommentsMaxLinks = 1 << 30
	settings.CommentsModeration = discussionModerationNone
	return settings
}

// confirmPublicReaderComment redeems a confirmation link (3.3): POST {"token"} from the
// confirm page's button.
//
// Returns:
//   - 200 {"outcome": "published"|"pending", "comment_id", "post_url", "comment_url",
//     "set_key", "others": [{"id", "post_title", "post_url", "excerpt", "created_at"}]}
//   - 400 invalid_token for every bad link (unknown, used, expired, malformed)
//   - 404 not_found / parent_not_found, 409 comments_off / comments_closed, 429
func (server *Server) confirmPublicReaderComment(c *gin.Context) {
	var req readerCommentConfirmRequest
	if !bindJSON(c, &req) {
		return
	}
	settings, ok := server.discussionEnabled(c)
	if !ok {
		return
	}
	hash, ok := parseAccountToken(req.Token)
	if !ok {
		respondInvalidAccountToken(c)
		return
	}
	comment, err := server.store.GetUnconfirmedReaderCommentByToken(c.Request.Context(), db.GetUnconfirmedReaderCommentByTokenParams{
		TokenHash: hash, CreatedAfter: time.Now().Add(-readerCommentConfirmTTL),
	})
	if errors.Is(err, sql.ErrNoRows) {
		respondInvalidAccountToken(c)
		return
	}
	if err != nil {
		server.requestLog(c).Error("reader comment confirmation: lookup failed", "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to confirm the comment")
		return
	}
	server.publishUnconfirmedReaderComment(c, settings, comment, hash)
}

// publishUnconfirmedReaderComment applies the rules to an unconfirmed comment and stores
// the outcome. tokenHash is the confirmation link's (it is spent, and the browser gets a
// key), or nil for the confirm page's Publish of another comment, which the browser's key
// authorized.
func (server *Server) publishUnconfirmedReaderComment(c *gin.Context, settings db.Setting, comment db.ReaderComment, tokenHash []byte) {
	ctx := c.Request.Context()
	logger := server.requestLog(c)
	invalid := func() {
		if tokenHash != nil {
			respondInvalidAccountToken(c)
			return
		}
		respondDiscussionError(c, http.StatusNotFound, "not_found", "comment not found")
	}
	post, ok := server.readerCommentPostOpen(c, settings, comment.PostID)
	if !ok {
		return
	}
	if !comment.CommenterID.Valid {
		invalid()
		return
	}
	commenter, err := server.store.GetCommenter(ctx, comment.CommenterID.Int64)
	if errors.Is(err, sql.ErrNoRows) {
		invalid()
		return
	}
	if err != nil {
		logger.Error("reader comment confirmation: reading the commenter failed", "comment_id", comment.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to confirm the comment")
		return
	}
	// A guard's hold was stored with the comment (14.2): it isn't asked again.
	var guard readerCommentGuardVerdict
	if comment.HeldReason.String == heldPlugin {
		guard = readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: comment.HeldDetail.String}
	}
	verdict, err := server.readerCommentRules(ctx, settings, commenter, comment.DisplayName, comment.Body, false, guard)
	if err != nil {
		logger.Error("reader comment confirmation: reading the rules' inputs failed", "comment_id", comment.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to confirm the comment")
		return
	}
	if verdict.Status == db.ReaderCommentPending && server.readerCommentQueueFull(c, comment.PostID) {
		return
	}
	reason, detail := verdict.heldColumns()
	params := db.PublishReaderCommentTxParams{
		ID: comment.ID, TokenHash: tokenHash, CreatedAfter: time.Now().Add(-readerCommentConfirmTTL),
		Status: verdict.Status, HeldReason: reason, HeldDetail: detail,
	}
	var key string
	if tokenHash != nil {
		var keyHash []byte
		if key, keyHash, err = newAccountToken(); err != nil {
			logger.Error("reader comment confirmation: key generation failed", "comment_id", comment.ID, "error", err)
			respondDiscussionError(c, http.StatusInternalServerError, "", "failed to confirm the comment")
			return
		}
		params.NewKey = &db.CreateCommenterKeyParams{KeyHash: keyHash, ExpiresAt: time.Now().Add(readerCommentKeyTTL)}
	}
	published, err := server.store.PublishReaderCommentTx(ctx, params)
	switch {
	case errors.Is(err, db.ErrTokenInvalid):
		invalid()
		return
	case errors.Is(err, db.ErrReaderCommentParentGone):
		respondDiscussionError(c, http.StatusNotFound, "parent_not_found", "the comment this replied to isn't available any more")
		return
	case err != nil:
		logger.Error("reader comment confirmation: storing failed", "comment_id", comment.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to confirm the comment")
		return
	}
	logger.Info("reader comment confirmed", "comment_id", published.ID, "post_id", published.PostID, "commenter_id", commenter.ID, "status", published.Status, "held_reason", reason.String)

	postPath := readerCommentPostPath(settings, post.PostType, post.Slug, post.ID, post.CategorySlug)
	outcome, commentURL := readerCommentOutcomePending, postPath+"#comments"
	if published.Status == db.ReaderCommentApproved {
		outcome, commentURL = readerCommentOutcomePublished, readerCommentURL(postPath, published.ID)
		server.purgeAfterDiscussionChange(ctx, logger, c.FullPath())
	}
	response := gin.H{"outcome": outcome, "comment_id": published.ID, "post_url": postPath, "comment_url": commentURL}
	if tokenHash != nil {
		response["set_key"] = key
		others, err := server.store.ListUnconfirmedReaderCommentsForCommenter(ctx, db.ListUnconfirmedReaderCommentsForCommenterParams{
			CommenterID: comment.CommenterID, CreatedAfter: time.Now().Add(-readerCommentConfirmTTL), ExcludeID: comment.ID,
		})
		if err != nil {
			// The comment is confirmed; the list is a convenience.
			logger.Warn("reader comment confirmation: listing the address's other comments failed", "comment_id", comment.ID, "error", err)
		}
		list := make([]gin.H, 0, len(others))
		for _, o := range others {
			list = append(list, gin.H{
				"id":         o.ID,
				"post_title": o.PostTitle,
				"post_url":   readerCommentPostPath(settings, o.PostType, o.Slug, o.PostID, o.CategorySlug),
				"excerpt":    truncateRunes(o.Excerpt, readerCommentExcerptMax),
				"created_at": o.CreatedAt.UTC().Format(time.RFC3339),
			})
		}
		response["others"] = list
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, response)
}

// actOnUnconfirmedReaderComment is the confirm page's Publish and Discard for the
// address's other unconfirmed comments (3.3 step 5): POST {"action": "publish"|"discard"}
// with the browser's keys. Only a comment of a commenter one of the keys belongs to.
//
// Returns 200 as confirm (without set_key and others) for publish, 204 for discard, 404
// not_found for any comment that isn't one of the keys' unconfirmed ones.
func (server *Server) actOnUnconfirmedReaderComment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	var req readerCommentUnconfirmedRequest
	if !bindJSON(c, &req) {
		return
	}
	settings, ok := server.discussionEnabled(c)
	if !ok {
		return
	}
	notFound := func() { respondDiscussionError(c, http.StatusNotFound, "not_found", "comment not found") }
	keys := parseCommenterKeys(c.GetHeader(commenterKeyHeader))
	if err != nil || id <= 0 || len(keys) == 0 {
		notFound()
		return
	}
	ctx := c.Request.Context()
	commenterIDs, err := server.store.ListCommenterIDsByKeys(ctx, keys)
	if err != nil {
		server.requestLog(c).Error("reader comment: reading browser keys failed", "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return
	}
	if len(commenterIDs) == 0 {
		notFound()
		return
	}
	if req.Action == "discard" {
		n, err := server.store.DeleteUnconfirmedReaderComment(ctx, db.DeleteUnconfirmedReaderCommentParams{ID: id, CommenterIds: commenterIDs})
		if err != nil {
			server.requestLog(c).Error("reader comment: discarding failed", "comment_id", id, "error", err)
			respondDiscussionError(c, http.StatusInternalServerError, "", "failed to discard the comment")
			return
		}
		if n == 0 {
			notFound()
			return
		}
		server.requestLog(c).Info("reader comment discarded", "comment_id", id)
		c.Header("Cache-Control", "no-store")
		c.Status(http.StatusNoContent)
		return
	}
	comment, err := server.store.GetUnconfirmedReaderCommentForCommenters(ctx, db.GetUnconfirmedReaderCommentForCommentersParams{
		ID: id, CommenterIds: commenterIDs, CreatedAfter: time.Now().Add(-readerCommentConfirmTTL),
	})
	if errors.Is(err, sql.ErrNoRows) {
		notFound()
		return
	}
	if err != nil {
		server.requestLog(c).Error("reader comment: lookup failed", "comment_id", id, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to save the comment")
		return
	}
	server.publishUnconfirmedReaderComment(c, settings, comment, nil)
}

// purgeAfterDiscussionChange is the one entry point for purging the public cache after a
// change readers see in a thread (design section 10): a comment entering or leaving
// approved, a tombstone, a member's edit. Call it after the commit, and only when the
// change reached readers: a comment that is only pending (or waits for its confirmation)
// changes nothing public, so it doesn't purge. #523 (the thread reads) and #526 (the
// moderation screens) purge through it, so a later per-post namespace (section 10) is one
// change here. reason is the route template or the job.
func (server *Server) purgeAfterDiscussionChange(ctx context.Context, logger *slog.Logger, reason string) {
	server.purgePublicCache(ctx, logger, reason)
}
