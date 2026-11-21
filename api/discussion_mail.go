package api

// Reader comment notifications (#528, docs/design/reader-comments.md 8.1 to 8.4).
//
// # The outbox
//
// discussion_mail holds one row per recipient and mail, recipients by id (a commenter or a
// member), never an address. Reply and author rows are written by 000068's trigger on
// reader_comments in the transaction that approves a comment, whatever the path
// (moderation, bulk, a member's comment, a confirmation, a keyed comment, a restore), so an
// approval that commits always has its mail and one that rolls back has none. A comment
// joins its recipient's open row instead of adding one (reply mails per comment answered,
// since an unsubscribe token turns off one comment, 8.2): reply and "each one" author rows
// are due five minutes after the first comment, digests at the next 08:00 in the site's
// zone (decision 8), so a busy thread sends one mail, not twenty.
//
// Moderation rows are not queued per comment: they describe the queue, which is itself
// durable, so each round of the sender queues "Comments await moderation" for every
// editor and admin who wants it (8.3), when a pending comment no mail of theirs counted
// is waiting and they had none in the last hour (EnqueueModerationMail).
//
// # Sending
//
// RunDiscussionMail (main.go, DISCUSSION_MAIL_INTERVAL, 30s, every replica) claims due rows
// FOR UPDATE SKIP LOCKED with a lease, as reminders are claimed (#320), and builds each
// from the current data: a comment no longer approved (trashed, spam, unapproved, a
// tombstone), on a post the site no longer shows, by the recipient, or no longer answering
// what the reader asked about is left out, and a mail left empty is dropped. So is one to
// a recipient who can't have it now: an erased commenter (whose rows went with them, ON
// DELETE CASCADE) or a removed member, a blocked commenter, a reply the reader
// unsubscribed from, a member whose preference is off or who left the byline. Failures
// retry with the scheduler's backoff, at most discussionMailMaxAttempts. Finished rows are
// pruned after 7 days by RunDiscussionMaintenance.
//
// # Privacy (7.3)
//
// Logs carry the row, recipient and comment ids, kinds, counts and outcomes, never an
// address, a name, a text or a token. A failed send logs the error's type only: an SMTP
// rejection quotes the recipient. TestDiscussionMailLogsHoldNoAddress checks every line.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

const (
	discussionMailKindReply      = "reply"
	discussionMailKindAuthor     = "author"
	discussionMailKindModeration = "moderation"

	discussionMailSent    = "sent"
	discussionMailDropped = "dropped"
	discussionMailFailed  = "failed"

	// discussionMailMaxPerRound bounds one round: a slow relay (mailSendTimeout each) must
	// not keep a round going while due rows pile up behind it; the next round continues.
	discussionMailMaxPerRound = 25
	discussionMailMaxAttempts = 8
	discussionMailLease       = 2 * time.Minute
	// discussionMailKeep: finished rows are pruned after this (8.4).
	discussionMailKeep = 7 * 24 * time.Hour
	// moderationMailPosts: "Comments await moderation" names the newest three posts (8.1).
	moderationMailPosts = 3

	// Members' preferences (8.3; users columns, 000068): each | digest | off, hourly | off.
	notifyPostCommentsDigest    = "digest"
	notifyPostCommentsOff       = "off"
	notifyCommentModerationOn   = "hourly"
	readerCommentUnsubscribeURL = "/comments/unsubscribe"
	// readerCommentOneClickPath is the web's RFC 8058 endpoint (9.4), token in the path.
	readerCommentOneClickPath = "/gl-comments/unsubscribe/"
	adminDiscussionPath       = "/gl-admin/discussion"
	adminProfilePath          = "/gl-admin/profile"
)

// RunDiscussionMail sends due notifications every interval until ctx is done (main.go).
// interval <= 0 turns it off in this process (DISCUSSION_MAIL_INTERVAL=0): the outbox
// keeps its rows for a replica that sends.
func (server *Server) RunDiscussionMail(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		server.logger.Info("discussion mail is off in this process (DISCUSSION_MAIL_INTERVAL=0)")
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		server.sendDiscussionMailRound(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// sendDiscussionMailRound is one round: queue moderation mail, then claim and send due
// rows one at a time until none is due, ctx is done or the round's cap is reached.
// Returns how many mails it sent.
func (server *Server) sendDiscussionMailRound(ctx context.Context) int {
	settings, err := server.store.GetSettings(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		if ctx.Err() == nil {
			server.logger.Error("discussion mail: reading settings failed", "error", err)
		}
		return 0
	}
	if !settings.CommentsEnabled {
		// Comments off for the site: nothing a mail would link to is shown. The rows wait,
		// and are built from the data as it is once comments are back on.
		return 0
	}
	if queued, err := server.store.EnqueueModerationMail(ctx); err != nil {
		if ctx.Err() == nil {
			server.logger.Error("discussion mail: queueing moderation mail failed", "error", err)
		}
	} else if queued > 0 {
		server.logger.Info("discussion mail: moderation mail queued", "count", queued)
	}

	sent := 0
	for i := 0; i < discussionMailMaxPerRound && ctx.Err() == nil; i++ {
		claims, err := server.store.ClaimDueDiscussionMail(ctx, db.ClaimDueDiscussionMailParams{
			LeaseSeconds: discussionMailLease.Seconds(),
			MaxRows:      1,
		})
		if err != nil {
			if ctx.Err() == nil {
				server.logger.Error("discussion mail: claiming due mail failed", "error", err)
			}
			return sent
		}
		if len(claims) == 0 {
			return sent
		}
		if server.sendDiscussionMail(ctx, claims[0], settings) {
			sent++
		}
	}
	return sent
}

// discussionMail is a built mail, or nothing to send (msg nil: the row is dropped).
// commentIDs replaces the row's when set (a moderation mail's count). tokenHash is a reply
// mail's unsubscribe token, deleted when the send fails (nobody got it).
type discussionMail struct {
	msg        *mailer.Message
	comments   int
	commentIDs []int64
	tokenHash  []byte
}

// sendDiscussionMail builds and sends one claimed row and ends its claim. True when sent.
func (server *Server) sendDiscussionMail(ctx context.Context, claim db.ClaimDueDiscussionMailRow, settings db.Setting) bool {
	logger := server.logger.With("mail_id", claim.ID, "kind", claim.Kind)
	if claim.CommenterID.Valid {
		logger = logger.With("commenter_id", claim.CommenterID.Int64)
	}
	if claim.UserID.Valid {
		logger = logger.With("user_id", claim.UserID.Int64)
	}
	finish := func(outcome string, ids []int64) {
		if !claim.Claim.Valid {
			return
		}
		if _, err := server.store.FinishDiscussionMail(ctx, db.FinishDiscussionMailParams{
			Outcome: outcome, CommentIds: ids, ID: claim.ID, Claim: claim.Claim.Time,
		}); err != nil {
			logger.Error("discussion mail: recording the outcome failed", "outcome", outcome, "error", err)
		}
	}

	var built discussionMail
	var err error
	switch claim.Kind {
	case discussionMailKindReply:
		built, err = server.buildReplyMail(ctx, claim, settings)
	case discussionMailKindAuthor:
		built, err = server.buildAuthorMail(ctx, claim, settings)
	case discussionMailKindModeration:
		built, err = server.buildModerationMail(ctx, claim, settings)
	}
	if err != nil {
		logger.Error("discussion mail: building failed", "attempts", claim.Attempts, "error", err)
		server.retryDiscussionMail(ctx, claim, logger)
		return false
	}
	if built.msg == nil {
		finish(discussionMailDropped, built.commentIDs)
		logger.Info("discussion mail dropped: nothing left to send")
		return false
	}

	if err := server.sendMail(context.WithoutCancel(ctx), *built.msg); err != nil {
		// The type only: a relay's rejection quotes the recipient's address.
		logger.Error("discussion mail failed", "attempts", claim.Attempts, "error_type", fmt.Sprintf("%T", err))
		if built.tokenHash != nil {
			if err := server.store.DeleteReaderCommentUnsubscribeToken(ctx, built.tokenHash); err != nil {
				logger.Error("discussion mail: deleting the unused unsubscribe token failed", "error", err)
			}
		}
		server.retryDiscussionMail(ctx, claim, logger)
		return false
	}
	finish(discussionMailSent, built.commentIDs)
	logger.Info("discussion mail sent", "comments", built.comments)
	return true
}

// retryDiscussionMail gives a claimed row back for the next attempt, after #147's backoff,
// or ends it once it is out of attempts.
func (server *Server) retryDiscussionMail(ctx context.Context, claim db.ClaimDueDiscussionMailRow, logger *slog.Logger) {
	if !claim.Claim.Valid {
		return
	}
	if claim.Attempts >= discussionMailMaxAttempts {
		if _, err := server.store.FinishDiscussionMail(ctx, db.FinishDiscussionMailParams{
			Outcome: discussionMailFailed, ID: claim.ID, Claim: claim.Claim.Time,
		}); err != nil {
			logger.Error("discussion mail: recording the outcome failed", "outcome", discussionMailFailed, "error", err)
		}
		return
	}
	retryAt := time.Now().Add(scheduledPublishRetryAfter(claim.Attempts))
	if _, err := server.store.ReleaseDiscussionMail(ctx, db.ReleaseDiscussionMailParams{RetryAt: retryAt, ID: claim.ID, Claim: claim.Claim.Time}); err != nil {
		logger.Error("discussion mail: scheduling the retry failed", "error", err)
	}
}

// mailPosts caches what a mail's comments' posts need: whether the site shows their
// thread (published, a public and active type, discussion not off) and their public path.
type mailPosts struct {
	server   *Server
	settings db.Setting
	types    map[string]*db.PostType
}

func newMailPosts(server *Server, settings db.Setting) *mailPosts {
	return &mailPosts{server: server, settings: settings, types: map[string]*db.PostType{}}
}

// shown says whether the site shows row's thread now. A type that no longer exists is not
// public.
func (p *mailPosts) shown(ctx context.Context, row db.ListDiscussionMailCommentsRow) (bool, error) {
	if row.PostStatus != postStatusPublished {
		return false, nil
	}
	typ, ok := p.types[row.PostType]
	if !ok {
		t, err := p.server.store.GetPostType(ctx, row.PostType)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
		if err == nil {
			typ = &t
		}
		p.types[row.PostType] = typ
	}
	if typ == nil || !typ.Public || !typ.IsActive {
		return false, nil
	}
	setting := discussionSetting(discussionInputs(p.settings, *typ, db.Post{Discussion: row.Discussion, FirstPublishedAt: row.FirstPublishedAt}))
	return setting.State != discussionStateOff, nil
}

// commentURL is the comment's absolute link on its post (11.3).
func (p *mailPosts) commentURL(row db.ListDiscussionMailCommentsRow) string {
	path := readerCommentPostPath(p.settings, row.PostType, row.Slug, row.PostID, row.CategorySlug)
	return p.server.publicURL + readerCommentURL(path, row.ID)
}

// mailComments reads a row's comments and keeps those keep says are still due and whose
// thread the site shows. Order: oldest first.
func (server *Server) mailComments(ctx context.Context, posts *mailPosts, ids []int64, memberID int64, keep func(db.ListDiscussionMailCommentsRow) bool) ([]db.ListDiscussionMailCommentsRow, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := server.store.ListDiscussionMailComments(ctx, db.ListDiscussionMailCommentsParams{MemberID: memberID, Ids: ids})
	if err != nil {
		return nil, err
	}
	out := rows[:0]
	for _, row := range rows {
		if row.Status != db.ReaderCommentApproved || row.Removed || !keep(row) {
			continue
		}
		shown, err := posts.shown(ctx, row)
		if err != nil {
			return nil, err
		}
		if shown {
			out = append(out, row)
		}
	}
	return out, nil
}

// buildReplyMail is "New reply" (8.1): the approved replies to the comment the reader
// asked about, by someone else. Nothing for an erased or blocked commenter, or a comment
// unsubscribed, removed or no longer theirs. Each mail mints its own unsubscribe token (only
// hashes are kept): the visible link's and the RFC 8058 header's.
func (server *Server) buildReplyMail(ctx context.Context, claim db.ClaimDueDiscussionMailRow, settings db.Setting) (discussionMail, error) {
	if !claim.CommenterID.Valid || !claim.AnsweredID.Valid {
		return discussionMail{}, nil
	}
	commenter, err := server.store.GetCommenter(ctx, claim.CommenterID.Int64)
	if errors.Is(err, sql.ErrNoRows) {
		return discussionMail{}, nil // erased
	}
	if err != nil {
		return discussionMail{}, err
	}
	if commenter.BlockedAt.Valid || commenter.Email == "" {
		return discussionMail{}, nil
	}
	answered, err := server.store.GetReaderComment(ctx, claim.AnsweredID.Int64)
	if errors.Is(err, sql.ErrNoRows) {
		return discussionMail{}, nil
	}
	if err != nil {
		return discussionMail{}, err
	}
	if !answered.NotifyReplies || answered.RemovedAt.Valid || answered.Status != db.ReaderCommentApproved ||
		answered.CommenterID != claim.CommenterID {
		return discussionMail{}, nil
	}

	posts := newMailPosts(server, settings)
	replies, err := server.mailComments(ctx, posts, claim.CommentIds, 0, func(row db.ListDiscussionMailCommentsRow) bool {
		return row.ParentID.Valid && row.ParentID.Int64 == answered.ID && row.CommenterID != claim.CommenterID
	})
	if err != nil || len(replies) == 0 {
		return discussionMail{}, err
	}

	token, hash, err := newAccountToken()
	if err != nil {
		return discussionMail{}, err
	}
	if err := server.store.CreateReaderCommentUnsubscribeToken(ctx, db.CreateReaderCommentUnsubscribeTokenParams{TokenHash: hash, CommentID: answered.ID}); err != nil {
		return discussionMail{}, err
	}
	items := make([]mailer.CommentItem, len(replies))
	for i, row := range replies {
		items[i] = mailer.CommentItem{Name: row.Name, Excerpt: row.Body, URL: posts.commentURL(row), PostTitle: row.PostTitle}
	}
	msg, err := mailer.RenderReaderCommentReply(commenter.Email, mailer.ReaderCommentReply{
		SiteTitle:       settings.SiteTitle.String,
		PostTitle:       replies[0].PostTitle,
		Replies:         items,
		UnsubscribeLink: server.accountLink(readerCommentUnsubscribeURL, token),
		OneClick:        server.publicURL + readerCommentOneClickPath + url.PathEscape(token),
		ManageLink:      server.publicURL + readerCommentDataPath,
	})
	if err != nil {
		return discussionMail{}, err
	}
	return discussionMail{msg: &msg, comments: len(replies), tokenHash: hash}, nil
}

// buildAuthorMail is "New comments on your post" (8.1): approved comments on posts whose
// published byline names the member, not their own, each one or as the daily digest, by
// their preference now. Contributors have no Discussion (decision 3): their mail has no
// link to it.
func (server *Server) buildAuthorMail(ctx context.Context, claim db.ClaimDueDiscussionMailRow, settings db.Setting) (discussionMail, error) {
	member, ok, err := server.mailMember(ctx, claim)
	if err != nil || !ok || member.NotifyPostComments == notifyPostCommentsOff {
		return discussionMail{}, err
	}
	posts := newMailPosts(server, settings)
	comments, err := server.mailComments(ctx, posts, claim.CommentIds, member.ID, func(row db.ListDiscussionMailCommentsRow) bool {
		return row.OnByline && (!row.AuthorUserID.Valid || row.AuthorUserID.Int64 != member.ID)
	})
	if err != nil || len(comments) == 0 {
		return discussionMail{}, err
	}
	items := make([]mailer.CommentItem, len(comments))
	samePost := true
	for i, row := range comments {
		items[i] = mailer.CommentItem{Name: row.Name, Excerpt: row.Body, URL: posts.commentURL(row), PostTitle: row.PostTitle}
		samePost = samePost && row.PostID == comments[0].PostID
	}
	var discussion string
	if member.Role == RoleAdmin || member.Role == RoleEditor {
		discussion = server.publicURL + adminDiscussionPath + "?status=approved"
		if samePost {
			discussion += "&post=" + strconv.FormatInt(comments[0].PostID, 10)
		}
	}
	msg, err := mailer.RenderReaderCommentAuthor(member.Email, mailer.ReaderCommentAuthor{
		SiteTitle:      settings.SiteTitle.String,
		Digest:         member.NotifyPostComments == notifyPostCommentsDigest,
		Comments:       items,
		DiscussionLink: discussion,
		ProfileLink:    server.publicURL + adminProfilePath,
	})
	if err != nil {
		return discussionMail{}, err
	}
	return discussionMail{msg: &msg, comments: len(comments)}, nil
}

// buildModerationMail is "Comments await moderation" (8.1): the queue's count now and the
// newest three posts' titles, to an editor or admin who still wants it. It records the
// pending ids it counted, so the next one waits for a comment this one didn't count.
// Never a commenter's details.
func (server *Server) buildModerationMail(ctx context.Context, claim db.ClaimDueDiscussionMailRow, settings db.Setting) (discussionMail, error) {
	member, ok, err := server.mailMember(ctx, claim)
	if err != nil || !ok || member.NotifyCommentModeration != notifyCommentModerationOn ||
		(member.Role != RoleAdmin && member.Role != RoleEditor) {
		return discussionMail{}, err
	}
	ids, err := server.store.ListPendingReaderCommentIDs(ctx)
	if err != nil || len(ids) == 0 {
		return discussionMail{commentIDs: ids}, err
	}
	newest, err := server.store.ListNewestPendingCommentPosts(ctx, moderationMailPosts)
	if err != nil {
		return discussionMail{}, err
	}
	titles := make([]string, len(newest))
	for i, post := range newest {
		titles[i] = post.Title
	}
	msg, err := mailer.RenderReaderCommentModeration(member.Email, mailer.ReaderCommentModeration{
		SiteTitle:   settings.SiteTitle.String,
		Count:       len(ids),
		PostTitles:  titles,
		Link:        server.publicURL + adminDiscussionPath + "?status=pending",
		ProfileLink: server.publicURL + adminProfilePath,
	})
	if err != nil {
		return discussionMail{}, err
	}
	return discussionMail{msg: &msg, comments: len(ids), commentIDs: ids}, nil
}

// mailMember reads a member recipient. ok false: removed (the row would have gone with
// them; a claim may race the removal) or without an address.
func (server *Server) mailMember(ctx context.Context, claim db.ClaimDueDiscussionMailRow) (db.User, bool, error) {
	if !claim.UserID.Valid {
		return db.User{}, false, nil
	}
	member, err := server.store.GetUser(ctx, claim.UserID.Int64)
	if errors.Is(err, sql.ErrNoRows) {
		return member, false, nil
	}
	if err != nil {
		return member, false, err
	}
	return member, member.Email != "", nil
}
