package api

import "github.com/gin-gonic/gin"

// RegisterSettingsRoutes registers all settings-related routes
func (server *Server) RegisterSettingsRoutes(rg *gin.RouterGroup) {
	settings := rg.Group("/settings")
	{
		// Core settings (singleton; writes are admin only)
		settings.GET("", server.getSettings)
		settings.PUT("", server.requireAuth(), requireSiteAdmin(server), server.updateSettings)
	}

	// Settings › URLs & redirects (#331, redirects.go; admins)
	server.registerRedirectRoutes(rg)

	extensionSettings := rg.Group("/extension-settings")
	{
		// Extension settings (key-value; writes are admin only)
		extensionSettings.GET("", server.listExtensionSettings)
		extensionSettings.GET("/:key", server.getExtensionSetting)
		extensionSettings.PUT("", server.requireAuth(), requireSiteAdmin(server), server.upsertExtensionSetting)
		extensionSettings.DELETE("/:key", server.requireAuth(), requireSiteAdmin(server), server.deleteExtensionSetting)
	}
}
