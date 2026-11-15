package api

import "github.com/gin-gonic/gin"

// The site design (#485, docs/design/theme-builder.md sections 6, 8 and 12): admins
// only, every route but the draft read. The draft is never public: the only public read
// of global styles is the *published* override, served with GET /themes/active.
func (server *Server) registerSiteDesignRoutes(router *gin.RouterGroup) {
	design := router.Group("/site-design", server.requireAuth(), requireSiteAdmin(server))
	{
		design.GET("/global-styles", server.getGlobalStyles)
		design.PUT("/global-styles", server.saveGlobalStyles)
		// Styles only for now; #492 publishes templates and parts in the same release.
		design.POST("/publish", server.publishSiteDesign)
		// A design preview token (#486) for the Astro server's preview cookie.
		design.POST("/preview", server.createDesignPreview)
	}
	// The named exception to requireSiteAdmin (design 12): the bearer is a design preview
	// token, and the handler re-checks that its user is still an admin on every read.
	router.GET("/site-design/draft", server.getDesignDraft)
}
