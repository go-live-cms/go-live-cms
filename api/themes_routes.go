package api

import "github.com/gin-gonic/gin"

func (server *Server) registerThemeRoutes(router *gin.RouterGroup) {
	themes := router.Group("/themes")
	{
		// Public routes (read-only)
		themes.GET("", server.listThemes)
		themes.GET("/active", server.getActiveTheme)
		themes.GET("/:id", server.getTheme)
		themes.GET("/:id/settings", server.getThemeSettings)

		// Protected routes (admin only)
		themes.PUT("/:id/activate", authMiddleware(server.tokenMaker), requireSiteAdmin(server), server.activateTheme)
		themes.PUT("/:id/settings/:key", authMiddleware(server.tokenMaker), requireSiteAdmin(server), server.updateThemeSetting)
		themes.PUT("/active/settings", authMiddleware(server.tokenMaker), requireSiteAdmin(server), server.updateActiveThemeSettings)
	}
}
