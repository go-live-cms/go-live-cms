package api

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The public thread reads (#523, C3 of reader comments; design
// docs/design/reader-comments.md 6.2, 6.4, 7.1, 9.1, 10).
//
//   - GET /public/posts/:id/comments?page=N: one page of the post's threads, with
//     `discussion` and `pagination`. ?thread=<root id>: that thread with every reply.
//   - GET /public/posts/:id and /slug/:slug carry `discussion` too (publicPostView), so the
//     post route knows whether to render the section before fetching it.
//
// Only approved comments are served. A thread whose root isn't shown any more (pending
// again, spam, trash, a tombstone) but still has approved replies shows the root as a
// placeholder (`removed`), and so does a reply that a shown reply answers: unapproving or
// removing a comment never hides its replies (6.4). The queries (db/query/
// discussion_public.sql) blank the name and text of such rows themselves.
//
// Every answer here is cached by #185's middleware (publicCacheRoutes), so nothing in
// this file reads the clock, a header or a cookie: `discussion` carries the clock-free
// setting (`state` without the timer, and `closes_at`), and the renderer and the write
// path apply the time (12.4). The purges that keep these answers fresh are
// discussion_purge.go's.
//
// No email, commenter id, status, network hash or token is in any answer (7.1):
// PublicReaderComment is built field by field from rows that select none of them.

// discussionRepliesPerThread is how many replies a page shows per thread; the rest are
// "Show more replies", a link to ?thread= (6.2).
const discussionRepliesPerThread = 100

// defaultCommentsPerPage is comments_per_page's default (12.1), for a row without it.
const defaultCommentsPerPage int32 = 30

// The comment badges (3.4).
const (
	readerCommentBadgeAuthor = "author"
	readerCommentBadgeStaff  = "staff"
)

// PublicDiscussion is a post's discussion as a cached /public answer carries it (9.1):
// the state without the clock, when an open state closes, and how many comments are
// shown. off always counts 0: an off thread shows nothing, not even how many there are.
type PublicDiscussion struct {
	State    string     `json:"state"`
	ClosesAt *time.Time `json:"closes_at"`
	Count    int64      `json:"count"`
}

// PublicReaderComment is a comment as the public site shows it (9.1). Nothing else:
// no email, no commenter id, no status (everything served is approved).
type PublicReaderComment struct {
	ID       int64  `json:"id"`
	ParentID *int64 `json:"parent_id"`
	RootID   *int64 `json:"root_id"`
	// As posted; a member's current name. "" when removed.
	Name string `json:"name"`
	// author (the member is on the post's published byline), staff (another member) or null.
	Badge *string `json:"badge"`
	// A member's avatar path (#334), or null: the renderer draws initials.
	Avatar    *string   `json:"avatar"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
	Edited    bool      `json:"edited"`
	// A placeholder or a tombstone: "This comment was removed" (6.4).
	Removed bool `json:"removed"`
	// The name a reply to a reply answers ("Replying to Ana"), when that comment is shown.
	ReplyingTo *string `json:"replying_to"`
}

// PublicReaderCommentThread is a top-level comment and its replies, oldest first.
// ReplyCount is how many replies the thread lists in all: more than len(Replies) means
// "Show more replies" (?thread=).
type PublicReaderCommentThread struct {
	Comment    PublicReaderComment   `json:"comment"`
	Replies    []PublicReaderComment `json:"replies"`
	ReplyCount int64                 `json:"reply_count"`
}

// PublicCommentsResponse is GET /public/posts/:id/comments?page=N.
type PublicCommentsResponse struct {
	Discussion PublicDiscussion            `json:"discussion"`
	Threads    []PublicReaderCommentThread `json:"threads"`
	Pagination pageInfo                    `json:"pagination"`
}

// PublicCommentThreadResponse is GET /public/posts/:id/comments?thread=<root id>.
type PublicCommentThreadResponse struct {
	Discussion PublicDiscussion          `json:"discussion"`
	Thread     PublicReaderCommentThread `json:"thread"`
}

// publicDiscussionRead is what the reads need about a post's discussion.
type publicDiscussionRead struct {
	discussion PublicDiscussion
	settings   db.Setting
	// served: the post's type is public and active, so /public/posts/:id/comments
	// answers for it (9.1).
	served bool
}

// readPublicDiscussion reads the settings, the post's type and (unless off) the count,
// and applies the rule without the clock (12.4). A missing settings row is the defaults:
// comments off.
func (server *Server) readPublicDiscussion(ctx context.Context, post db.Post) (publicDiscussionRead, error) {
	settings, err := server.store.GetSettings(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return publicDiscussionRead{}, err
	}
	postType, err := server.store.GetPostType(ctx, post.PostType)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return publicDiscussionRead{}, err
	}
	site, typ, p := discussionInputs(settings, postType, post)
	setting := discussionSetting(site, typ, p)
	read := publicDiscussionRead{
		discussion: PublicDiscussion{State: setting.State, ClosesAt: setting.ClosesAt},
		settings:   settings,
		served:     typ.Public,
	}
	if setting.State != discussionStateOff {
		if read.discussion.Count, err = server.store.CountShownReaderComments(ctx, post.ID); err != nil {
			return publicDiscussionRead{}, err
		}
	}
	return read, nil
}

// getPublicPostComments handles GET /public/posts/:id/comments?page=N and ?thread=<id>.
// 404 for a post /public doesn't serve (not published, or of a type that isn't public),
// past the last page, and for a thread that isn't one of this post's shown threads. An
// off discussion answers no threads (and 404 for any thread).
func (server *Server) getPublicPostComments(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	page, err := parsePageQuery(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var threadID int64
	if value, ok := c.GetQuery("thread"); ok {
		if _, paged := c.GetQuery("page"); paged {
			c.JSON(http.StatusBadRequest, gin.H{"error": "page and thread can't be combined"})
			return
		}
		threadID, err = strconv.ParseInt(value, 10, 64)
		if err != nil || threadID <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid thread parameter"})
			return
		}
	}

	ctx := c.Request.Context()
	post, err := server.store.GetPost(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	if post.PostStatus != publishedStatus {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}
	read, err := server.readPublicDiscussion(ctx, post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the discussion"})
		return
	}
	if !read.served {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}
	if threadID > 0 {
		server.respondPublicCommentThread(c, post, read, threadID)
		return
	}
	server.respondPublicCommentPage(c, post, read, page)
}

// commentsPerPage is comments_per_page (10..100, enforced on write).
func commentsPerPage(settings db.Setting) int32 {
	if settings.CommentsPerPage < 1 {
		return defaultCommentsPerPage
	}
	return settings.CommentsPerPage
}

func (server *Server) respondPublicCommentPage(c *gin.Context, post db.Post, read publicDiscussionRead, page int32) {
	ctx := c.Request.Context()
	req := pageRequest{Page: page, PerPage: commentsPerPage(read.settings)}
	if int64(page-1)*int64(req.PerPage) > math.MaxInt32 {
		c.JSON(http.StatusNotFound, gin.H{"error": "page out of range"})
		return
	}
	flat := read.settings.CommentsThreading == "flat"
	newest := read.settings.CommentsOrder == "newest"

	var total int64
	var err error
	switch {
	case read.discussion.State == discussionStateOff:
		// An off discussion shows nothing (11.2), so it lists nothing either.
	case flat:
		total = read.discussion.Count
	default:
		total, err = server.store.CountPublicReaderCommentThreads(ctx, post.ID)
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count comments"})
		return
	}
	info := newPageInfo(req, total)
	if info.outOfRange() {
		c.JSON(http.StatusNotFound, gin.H{"error": "page out of range"})
		return
	}
	response := PublicCommentsResponse{Discussion: read.discussion, Threads: []PublicReaderCommentThread{}, Pagination: info}
	if total == 0 {
		c.JSON(http.StatusOK, response)
		return
	}

	if flat {
		rows, err := server.store.ListPublicReaderCommentsFlat(ctx, db.ListPublicReaderCommentsFlatParams{
			PostID: post.ID, NewestFirst: newest, OffsetCount: req.offset(), LimitCount: req.PerPage,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list comments"})
			return
		}
		// Flat (6.2 A): each comment on its own; "who answered whom" isn't shown.
		for _, row := range rows {
			response.Threads = append(response.Threads, PublicReaderCommentThread{
				Comment: toPublicReaderComment(publicCommentRow(row)),
				Replies: []PublicReaderComment{},
			})
		}
		c.JSON(http.StatusOK, response)
		return
	}

	roots, err := server.store.ListPublicReaderCommentThreads(ctx, db.ListPublicReaderCommentThreadsParams{
		PostID: post.ID, NewestFirst: newest, OffsetCount: req.offset(), LimitCount: req.PerPage,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list comments"})
		return
	}
	response.Threads, err = server.publicThreads(ctx, post.ID, roots, discussionRepliesPerThread)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list comments"})
		return
	}
	c.JSON(http.StatusOK, response)
}

func (server *Server) respondPublicCommentThread(c *gin.Context, post db.Post, read publicDiscussionRead, threadID int64) {
	if read.discussion.State == discussionStateOff {
		c.JSON(http.StatusNotFound, gin.H{"error": "thread not found"})
		return
	}
	ctx := c.Request.Context()
	root, err := server.store.GetPublicReaderCommentThread(ctx, db.GetPublicReaderCommentThreadParams{ID: threadID, PostID: post.ID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "thread not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the thread"})
		return
	}
	threads, err := server.publicThreads(ctx, post.ID, []db.ListPublicReaderCommentThreadsRow{publicCommentRow(root)}, math.MaxInt32)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the thread"})
		return
	}
	c.JSON(http.StatusOK, PublicCommentThreadResponse{Discussion: read.discussion, Thread: threads[0]})
}

// publicCommentRow is one shape for the roots and the flat rows (the queries select the
// same columns).
type publicCommentRow = db.ListPublicReaderCommentThreadsRow

// publicThreads attaches each root's replies (at most perThread each) in one query.
func (server *Server) publicThreads(ctx context.Context, postID int64, roots []publicCommentRow, perThread int64) ([]PublicReaderCommentThread, error) {
	threads := make([]PublicReaderCommentThread, len(roots))
	if len(roots) == 0 {
		return threads, nil
	}
	ids := make([]int64, len(roots))
	index := make(map[int64]int, len(roots))
	for i, root := range roots {
		ids[i] = root.ID
		index[root.ID] = i
		threads[i] = PublicReaderCommentThread{Comment: toPublicReaderComment(root), Replies: []PublicReaderComment{}}
	}
	rows, err := server.store.ListPublicReaderCommentReplies(ctx, db.ListPublicReaderCommentRepliesParams{
		PostID: postID, RootIds: ids, PerThread: perThread,
	})
	if err != nil {
		return nil, err
	}
	// The names a reply to a reply answers: the comments shown in the same thread.
	names := make(map[int64]string, len(rows))
	for _, root := range threads {
		if !root.Comment.Removed {
			names[root.Comment.ID] = root.Comment.Name
		}
	}
	replies := make([]PublicReaderComment, len(rows))
	for i, row := range rows {
		replies[i] = toPublicReaderComment(publicCommentRow{
			ID: row.ID, ParentID: row.ParentID, RootID: row.RootID, CreatedAt: row.CreatedAt,
			Shown: row.Shown, DisplayName: row.DisplayName, Body: row.Body, Edited: row.Edited,
			ByMember: row.ByMember, MemberName: row.MemberName, MemberAvatar: row.MemberAvatar,
			MemberIsAuthor: row.MemberIsAuthor,
		})
		if !replies[i].Removed {
			names[row.ID] = replies[i].Name
		}
	}
	for i, row := range rows {
		reply := replies[i]
		// "Replying to Ana" only for a reply to a reply (6.2 B): a direct reply sits under
		// the comment it answers already. A parent shown as removed has no name to show.
		if !reply.Removed && row.ParentID.Valid && row.RootID.Valid && row.ParentID.Int64 != row.RootID.Int64 {
			if name, ok := names[row.ParentID.Int64]; ok {
				reply.ReplyingTo = &name
			}
		}
		t := &threads[index[row.RootID.Int64]]
		t.Replies = append(t.Replies, reply)
		t.ReplyCount = row.ThreadReplyCount
	}
	return threads, nil
}

// toPublicReaderComment builds the public shape field by field (7.1).
func toPublicReaderComment(row publicCommentRow) PublicReaderComment {
	comment := PublicReaderComment{
		ID:        row.ID,
		ParentID:  nullInt64Ptr(row.ParentID),
		RootID:    nullInt64Ptr(row.RootID),
		CreatedAt: row.CreatedAt,
	}
	if !row.Shown {
		comment.Removed = true
		return comment
	}
	comment.Name, comment.Body, comment.Edited = row.DisplayName, row.Body, row.Edited
	if row.ByMember {
		// A member's comment shows their current name and avatar with a badge (3.4); a
		// removed member's keeps the name it was posted with and no badge (the row's
		// author_user_id is NULL then, so ByMember is false).
		if row.MemberName != "" {
			comment.Name = row.MemberName
		}
		comment.Avatar = avatarResponse(row.MemberAvatar)
		badge := readerCommentBadgeStaff
		if row.MemberIsAuthor {
			badge = readerCommentBadgeAuthor
		}
		comment.Badge = &badge
	}
	return comment
}
