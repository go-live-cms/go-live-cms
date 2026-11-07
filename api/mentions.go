package api

// The editor's @ menu (#320; inline nodes in inline_nodes.go):
//   - GET /mentions/people?q=  members with a content role whose name or username
//     contains q (everyone, by name, without), for People;
//   - GET /mentions/people?ids=1,2  those members (a removed one is left out), for the
//     editor's current names of the mentions it shows;
//   - GET /mentions/content?q=  posts and pages the caller may read (canReadPost: their
//     own and published ones for a contributor), never one in the trash, whose title
//     contains q (the latest edited, without), for "Link to post or page".
//
// Content roles only (requireContentAuthor), public fields only: id, username, name,
// avatar and role for a member, never an email; id, title, type and status for a post.
// Contributors list members too: who can be mentioned is everyone who writes, like the
// byline's picker (#319).

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	// mentionMenuLimit is how many of each the menu shows (MENTION_MENU_LIMIT).
	mentionMenuLimit = 5
	// mentionLookupMax is the most ids one ?ids= lookup takes (MENTION_LOOKUP_MAX).
	mentionLookupMax = 100
	mentionQueryMax  = 100
)

func (server *Server) registerMentionRoutes(rg *gin.RouterGroup) {
	mentions := rg.Group("/mentions", server.requireAuth(), requireContentAuthor(server))
	mentions.GET("/people", server.listMentionPeople)
	mentions.GET("/content", server.listMentionContent)
}

// MentionPersonResponse is a member as the @ menu shows them.
type MentionPersonResponse struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	FullName string  `json:"full_name"`
	Avatar   *string `json:"avatar"`
	Role     string  `json:"role"`
}

// MentionContentResponse is a post as the @ menu shows it.
type MentionContentResponse struct {
	ID            int64  `json:"id"`
	Title         string `json:"title"`
	PostType      string `json:"post_type"`
	PostTypeLabel string `json:"post_type_label"`
	PostStatus    string `json:"post_status"`
}

// parseMentionIDs reads ?ids=1,2,3: positive integers, at most mentionLookupMax, deduped.
func parseMentionIDs(raw string) ([]int64, bool) {
	seen := map[int64]bool{}
	ids := []int64{}
	for _, part := range strings.Split(raw, ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
		if err != nil || id <= 0 {
			return nil, false
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids, len(ids) <= mentionLookupMax
}

// listMentionPeople handles GET /mentions/people?q= | ?ids=.
//
// Returns:
//   - 200 OK: {"people": [{id, username, full_name, avatar, role}]}
//   - 400 Bad Request: q over 100 characters, or ids that aren't positive integers (≤100)
func (server *Server) listMentionPeople(c *gin.Context) {
	if raw, ok := c.GetQuery("ids"); ok {
		ids, valid := parseMentionIDs(raw)
		if !valid {
			c.JSON(http.StatusBadRequest, gin.H{"error": "ids must be at most 100 comma-separated positive integers"})
			return
		}
		rows, err := server.store.ListMentionPeopleByIDs(c.Request.Context(), ids)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list members"})
			return
		}
		people := make([]MentionPersonResponse, len(rows))
		for i, row := range rows {
			people[i] = MentionPersonResponse{ID: row.ID, Username: row.Username, FullName: row.FullName, Avatar: avatarResponse(row.AvatarUrl), Role: strings.ToLower(row.Role)}
		}
		c.JSON(http.StatusOK, gin.H{"people": people})
		return
	}

	q := c.Query("q")
	if len(q) > mentionQueryMax {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q must be at most 100 characters"})
		return
	}
	rows, err := server.store.ListMentionCandidates(c.Request.Context(), db.ListMentionCandidatesParams{
		Roles:      contentRoles,
		Pattern:    memberSearchPattern(q),
		LimitCount: mentionMenuLimit,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list members"})
		return
	}
	people := make([]MentionPersonResponse, len(rows))
	for i, row := range rows {
		people[i] = MentionPersonResponse{ID: row.ID, Username: row.Username, FullName: row.FullName, Avatar: avatarResponse(row.AvatarUrl), Role: strings.ToLower(row.Role)}
	}
	c.JSON(http.StatusOK, gin.H{"people": people})
}

// listMentionContent handles GET /mentions/content?q=.
//
// Returns:
//   - 200 OK: {"posts": [{id, title, post_type, post_type_label, post_status}]}
//   - 400 Bad Request: q over 100 characters
func (server *Server) listMentionContent(c *gin.Context) {
	q := c.Query("q")
	if len(q) > mentionQueryMax {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q must be at most 100 characters"})
		return
	}
	viewerID, ok := server.callerViewerID(c)
	if !ok {
		return
	}
	rows, err := server.store.ListMentionContent(c.Request.Context(), db.ListMentionContentParams{
		ViewerID:   viewerID,
		Pattern:    memberSearchPattern(q),
		LimitCount: mentionMenuLimit,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts"})
		return
	}
	posts := make([]MentionContentResponse, len(rows))
	for i, row := range rows {
		posts[i] = MentionContentResponse{ID: row.ID, Title: row.Title, PostType: row.PostType, PostTypeLabel: mentionTypeLabel(row.PostType), PostStatus: row.PostStatus}
	}
	c.JSON(http.StatusOK, gin.H{"posts": posts})
}
