package api

import "github.com/gin-gonic/gin"

// registerPluginRoutes registers the plugin registry (#455, docs/design/plugin-system.md
// section 4.3). A plugin is trusted code with the process's authority (section 2), so
// everything but the enabled list is for site admins. GET /plugins/enabled is what the
// block menus read: any content role, slugs only.
//
// /plugins/enabled is a static route beside /plugins/:slug, which is why `enabled` is
// a reserved plugin id (plugins_manifest.go).
func (server *Server) registerPluginRoutes(v1 *gin.RouterGroup) {
	plugins := v1.Group("/plugins", server.requireAuth())
	{
		plugins.GET("/enabled", requireContentAuthor(server), server.listEnabledPlugins)

		admin := plugins.Group("", requireSiteAdmin(server))
		admin.GET("", server.listPlugins)
		admin.GET("/:slug", server.getPlugin)
		admin.POST("/:slug/enable", server.enablePlugin)
		admin.POST("/:slug/disable", server.disablePlugin)
	}
}
