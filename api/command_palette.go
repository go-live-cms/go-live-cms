package api

// The admin's command palette (#41): GET /search?q=, the one call behind "Search · Ctrl K".
// Posts, pages, media, terms and (admins only) users whose name or title matches q, at most
// commandPaletteLimit of each.
//
// One route rather than the per-type ones because the palette asks on every pause in
// typing: /taxonomy/terms/search takes one taxonomy at a time (N calls, plus one to list
// them), /users is admin-only and /media/search refuses an empty q, so the client would
// fan out five or more calls per keystroke, each counted by the per-IP limit, and carry a
// copy of the role rules. Here who sees which group is decided once, from the caller's row:
//
//   - posts and pages: by title or slug, through postsViewerID, so a contributor gets their
//     own and published ones (canReadPost), and nobody the trash. Not the admin list's
//     ranked search: it took seconds at 30,000 posts, too slow to run on every pause;
//   - media and terms: every content role may open the library and the Taxonomies page;
//   - users: admins only (the Users pages are), and the query isn't run for anyone else.

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// commandPaletteLimit is how many of each kind the palette shows.
const commandPaletteLimit = 5

// statusClientClosedRequest answers a search the client aborted (nginx's 499): the
// palette cancels a stale request on every keystroke, and that isn't a server error,
// so it mustn't reach the 5xx metrics and the error reporter. Nobody reads the response.
const statusClientClosedRequest = 499

func (server *Server) registerCommandPaletteRoutes(rg *gin.RouterGroup) {
	rg.GET("/search", server.requireAuth(), requireContentAuthor(server), server.searchCommandPalette)
}

// CommandPalettePost is a post or page as the palette shows it.
type CommandPalettePost struct {
	ID         int64  `json:"id"`
	Title      string `json:"title"`
	PostType   string `json:"post_type"`
	PostStatus string `json:"post_status"`
}

// CommandPaletteTerm is a taxonomy term as the palette shows it.
type CommandPaletteTerm struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	Slug          string `json:"slug"`
	TaxonomyType  string `json:"taxonomy_type"`
	TaxonomyLabel string `json:"taxonomy_label"`
}

// CommandPaletteUser is a member as the palette shows them: never an email.
type CommandPaletteUser struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	FullName string  `json:"full_name"`
	Avatar   *string `json:"avatar"`
	Role     string  `json:"role"`
}

// CommandPaletteResponse is GET /search's answer. Users is left out for everyone but
// admins, and for an admin when no member matches.
type CommandPaletteResponse struct {
	Query string               `json:"query"`
	Posts []CommandPalettePost `json:"posts"`
	Pages []CommandPalettePost `json:"pages"`
	Media []MediaResponse      `json:"media"`
	Terms []CommandPaletteTerm `json:"terms"`
	Users []CommandPaletteUser `json:"users,omitempty"`
}

// searchCommandPalette handles GET /search?q=. An empty q answers empty groups (the
// palette only shows its actions then). A q that's too long is cut, like the other
// searches (normalizeSearchQuery).
//
// Returns:
//   - 200 OK: CommandPaletteResponse
func (server *Server) searchCommandPalette(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	response := CommandPaletteResponse{
		Query: normalizeSearchQuery(c.Query("q")),
		Posts: []CommandPalettePost{},
		Pages: []CommandPalettePost{},
		Media: []MediaResponse{},
		Terms: []CommandPaletteTerm{},
	}
	if response.Query != "" {
		if err := server.fillCommandPalette(c, caller, &response); err != nil {
			if c.Request.Context().Err() != nil {
				c.Status(statusClientClosedRequest)
				return
			}
			server.requestLog(c).Warn("command_palette_search_failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search"})
			return
		}
	}
	c.JSON(http.StatusOK, response)
}

func (server *Server) fillCommandPalette(c *gin.Context, caller db.User, response *CommandPaletteResponse) error {
	ctx := c.Request.Context()
	query := response.Query
	pattern := memberSearchPattern(query)
	prefix := likeEscaper.Replace(query) + "%"

	posts, err := server.store.SearchCommandPalettePosts(ctx, db.SearchCommandPalettePostsParams{
		Pattern:       pattern,
		PrefixPattern: prefix,
		ViewerID:      postsViewerID(caller),
		LimitPerType:  commandPaletteLimit,
	})
	if err != nil {
		return err
	}
	for _, row := range posts {
		post := CommandPalettePost{ID: row.ID, Title: row.Title, PostType: row.PostType, PostStatus: row.PostStatus}
		if row.PostType == searchTypePage {
			response.Pages = append(response.Pages, post)
		} else {
			response.Posts = append(response.Posts, post)
		}
	}

	media, err := server.store.SearchMediaByName(ctx, db.SearchMediaByNameParams{
		// The query adds the % around it, so this is the pattern's text only.
		Column1: sql.NullString{String: likeEscaper.Replace(query), Valid: true},
		Column2: getMimeTypeFilter(""),
		Column3: int64(0),
		Column4: "date_desc",
		Limit:   commandPaletteLimit,
	})
	if err != nil {
		return err
	}
	for _, row := range media {
		response.Media = append(response.Media, server.withPublicMediaPath(toMediaFromSearchRow(row)))
	}

	terms, err := server.store.SearchTermsAcrossTaxonomies(ctx, db.SearchTermsAcrossTaxonomiesParams{
		Pattern:    pattern,
		LimitCount: commandPaletteLimit,
	})
	if err != nil {
		return err
	}
	for _, row := range terms {
		response.Terms = append(response.Terms, CommandPaletteTerm{
			ID:            row.ID,
			Name:          row.Name,
			Slug:          row.Slug,
			TaxonomyType:  row.TaxonomyType,
			TaxonomyLabel: row.TaxonomyLabel,
		})
	}

	if !isSiteAdmin(caller) {
		return nil
	}
	members, err := server.store.SearchCommandPaletteUsers(ctx, db.SearchCommandPaletteUsersParams{
		Pattern:       pattern,
		PrefixPattern: prefix,
		LimitCount:    commandPaletteLimit,
	})
	if err != nil {
		return err
	}
	response.Users = make([]CommandPaletteUser, len(members))
	for i, row := range members {
		response.Users[i] = CommandPaletteUser{
			ID:       row.ID,
			Username: row.Username,
			FullName: row.FullName,
			Avatar:   avatarResponse(row.AvatarUrl),
			Role:     row.Role,
		}
	}
	return nil
}
