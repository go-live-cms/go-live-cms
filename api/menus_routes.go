// menus_routes wires the navigation menus (#347). Themes declare locations in
// theme.config.ts (menuLocations, stored in the theme's config as
// menu_locations); a menu is assigned to at most one of them.
//
//   - /api/v1/menus: admin CRUD, editors and admins (requireContentEditor);
//     PUT /menus/:id/items saves the whole item tree
//   - /public/menus/:location: the assigned menu for the public site, visible
//     items only, URLs resolved from their targets at read time
package api

import "github.com/gin-gonic/gin"

func (server *Server) registerMenuRoutes(v1 *gin.RouterGroup) {
	menus := v1.Group("/menus", authMiddleware(server.tokenMaker, server.store), requireContentEditor(server))
	menus.GET("", server.listMenus)
	menus.POST("", server.createMenu)
	menus.GET("/:id", server.getMenu)
	menus.PUT("/:id", server.updateMenu)
	menus.PUT("/:id/items", server.saveMenuItems)
	menus.DELETE("/:id", server.deleteMenu)
}
