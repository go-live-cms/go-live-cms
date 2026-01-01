package api

import "github.com/gin-gonic/gin"

// RegisterSettingsRoutes registers all settings-related routes
func (server *Server) RegisterSettingsRoutes(rg *gin.RouterGroup) {
	settings := rg.Group("/settings")
	{
		// Core settings (singleton)
		settings.GET("", server.getSettings)
		settings.PUT("", authMiddleware(server.tokenMaker), server.updateSettings)
	}

	extensionSettings := rg.Group("/extension-settings")
	{
		// Extension settings (key-value)
		extensionSettings.GET("", server.listExtensionSettings)
		extensionSettings.GET("/:key", server.getExtensionSetting)
		extensionSettings.PUT("", authMiddleware(server.tokenMaker), server.upsertExtensionSetting)
		extensionSettings.DELETE("/:key", authMiddleware(server.tokenMaker), server.deleteExtensionSetting)
	}
}
