package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// saveMenu is POST /menus (id 0) and PUT /menus/:id.
func (server *Server) saveMenu(c *gin.Context, id int64) {
	var req SaveMenuRequest
	if !bindJSON(c, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required", "fields": gin.H{"name": "is required"}})
		return
	}

	location := ""
	if req.Location != nil {
		location = *req.Location
		if location != "" && !identifierRe.MatchString(location) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "location must be a theme location name", "fields": gin.H{"location": "must be a theme location name"}})
			return
		}
	}
	menu, err := server.store.SaveMenuTx(c.Request.Context(), db.SaveMenuTxParams{
		ID:           id,
		Name:         name,
		Location:     sql.NullString{String: location, Valid: location != ""},
		KeepLocation: id != 0 && req.Location == nil,
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "menu not found"})
		case isUniqueViolation(err):
			// Another save took the location between our clear and our write.
			c.JSON(http.StatusConflict, gin.H{"error": "another menu was just assigned to this location, try again"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save menu"})
		}
		return
	}

	if id == 0 {
		resp := toMenuResponse(menu)
		resp.Items = []MenuItemResponse{}
		c.JSON(http.StatusCreated, gin.H{"menu": resp})
		return
	}
	server.respondMenu(c, menu)
}

// createMenu creates an empty menu, optionally assigned to a theme location
// (taking it from the menu that had it).
//
// Authentication: Bearer token + editor or admin role
//
// Returns:
//   - 201 Created: {"menu": ...}
//   - 400 Bad Request: invalid name or location
func (server *Server) createMenu(c *gin.Context) {
	server.saveMenu(c, 0)
}

// updateMenu renames a menu and sets its location ("" = none).
//
// Authentication: Bearer token + editor or admin role
//
// Returns:
//   - 200 OK: {"menu": {..., "items": [...]}}
//   - 404 Not Found: no such menu
func (server *Server) updateMenu(c *gin.Context) {
	id, ok := menuIDParam(c)
	if !ok {
		return
	}
	server.saveMenu(c, id)
}

// saveMenuItems replaces a menu's items with the posted tree (order, nesting,
// targets, labels). Targets are checked by their foreign keys: one that
// doesn't exist fails the whole save.
//
// Authentication: Bearer token + editor or admin role
//
// Returns:
//   - 200 OK: {"menu": {..., "items": [...]}}
//   - 400 Bad Request: invalid item (unknown target, unsafe URL, too deep, too many)
//   - 404 Not Found: no such menu
func (server *Server) saveMenuItems(c *gin.Context) {
	id, ok := menuIDParam(c)
	if !ok {
		return
	}
	var req SaveMenuItemsRequest
	if !bindJSON(c, &req) {
		return
	}
	items, err := flattenMenuItems(req.Items)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx := c.Request.Context()
	if _, err := server.store.ReplaceMenuItemsTx(ctx, db.ReplaceMenuItemsTxParams{MenuID: id, Items: items}); err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "menu not found"})
		case isForeignKeyViolation(err):
			c.JSON(http.StatusBadRequest, gin.H{"error": "a menu item's target does not exist"})
		case errors.Is(err, db.ErrMenuItemParent):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save menu items"})
		}
		return
	}

	menu, err := server.store.GetMenu(ctx, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load menu"})
		return
	}
	server.respondMenu(c, menu)
}

// deleteMenu deletes a menu and its items; its location is left without one.
//
// Authentication: Bearer token + editor or admin role
//
// Returns:
//   - 204 No Content
//   - 404 Not Found: no such menu
func (server *Server) deleteMenu(c *gin.Context) {
	id, ok := menuIDParam(c)
	if !ok {
		return
	}
	n, err := server.store.DeleteMenu(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete menu"})
		return
	}
	if n == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "menu not found"})
		return
	}
	c.Status(http.StatusNoContent)
}
