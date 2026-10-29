package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

func menuIDParam(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid menu ID"})
		return 0, false
	}
	return id, true
}

// resolvedMenuItems loads a menu's items and resolves them against their
// targets and the site's URL structure.
func (server *Server) resolvedMenuItems(ctx context.Context, menuID int64) ([]resolvedMenuItem, error) {
	rows, err := server.store.ListMenuItemsWithTargets(ctx, menuID)
	if err != nil {
		return nil, err
	}
	structure := "id"
	if len(rows) > 0 {
		settings, err := server.store.GetSettings(ctx)
		switch {
		case err == nil:
			structure = settings.PostUrlStructure
		case !errors.Is(err, sql.ErrNoRows):
			return nil, err
		}
	}
	items := make([]resolvedMenuItem, len(rows))
	for i, row := range rows {
		items[i] = resolveMenuItem(row, structure)
	}
	return items, nil
}

// respondMenu answers 200 with the menu and its whole item tree.
func (server *Server) respondMenu(c *gin.Context, menu db.Menu) {
	items, err := server.resolvedMenuItems(c.Request.Context(), menu.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load menu items"})
		return
	}
	resp := toMenuResponse(menu)
	resp.Items = adminMenuItems(items)
	c.JSON(http.StatusOK, gin.H{"menu": resp})
}

// listMenus returns every menu with its location and item count.
//
// Authentication: Bearer token + editor or admin role
//
// Returns:
//   - 200 OK: {"menus": [...]}
func (server *Server) listMenus(c *gin.Context) {
	rows, err := server.store.ListMenus(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list menus"})
		return
	}
	menus := make([]MenuResponse, len(rows))
	for i, row := range rows {
		menus[i] = toMenuListResponse(row)
	}
	c.JSON(http.StatusOK, gin.H{"menus": menus})
}

// getMenu returns one menu with every item, including the ones readers don't
// see (each item's status says why).
//
// Authentication: Bearer token + editor or admin role
//
// Returns:
//   - 200 OK: {"menu": {..., "items": [...]}}
//   - 404 Not Found: no such menu
func (server *Server) getMenu(c *gin.Context) {
	id, ok := menuIDParam(c)
	if !ok {
		return
	}
	menu, err := server.store.GetMenu(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "menu not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load menu"})
		return
	}
	server.respondMenu(c, menu)
}

// getPublicMenu returns the menu assigned to a theme location, for the public
// site: only the items readers may follow, with URLs built from their targets'
// current slugs.
//
// Authentication: none (rate limited like the rest of /public)
//
// Returns:
//   - 200 OK: {"name", "location", "items": [{id, label, url, children}]}
//   - 404 Not Found: no menu is assigned to this location
func (server *Server) getPublicMenu(c *gin.Context) {
	location := c.Param("location")
	if !identifierRe.MatchString(location) || len(location) > 64 {
		c.JSON(http.StatusNotFound, gin.H{"error": "menu not found"})
		return
	}
	menu, err := server.store.GetMenuByLocation(c.Request.Context(), sql.NullString{String: location, Valid: true})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "menu not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load menu"})
		return
	}
	items, err := server.resolvedMenuItems(c.Request.Context(), menu.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load menu items"})
		return
	}
	c.JSON(http.StatusOK, PublicMenuResponse{Name: menu.Name, Location: location, Items: publicMenuItems(items)})
}
