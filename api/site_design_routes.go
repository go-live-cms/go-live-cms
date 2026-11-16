package api

import "github.com/gin-gonic/gin"

// The site design (#485, docs/design/theme-builder.md sections 6, 8, 9 and 12): admins
// only, every route but the draft read. The draft is never public: the only public read
// of global styles is the *published* override, served with GET /themes/active.
func (server *Server) registerSiteDesignRoutes(router *gin.RouterGroup) {
	design := router.Group("/site-design", server.requireAuth(), requireSiteAdmin(server))
	{
		design.GET("/global-styles", server.getGlobalStyles)
		design.PUT("/global-styles", server.saveGlobalStyles)
		// Styles history (#492): restore a version or discard into the draft, by REST
		// (styles aren't collaborative, 5.3).
		design.GET("/global-styles/versions", server.listGlobalStyleVersions)
		design.GET("/global-styles/versions/:no", server.getGlobalStyleVersion)
		design.POST("/global-styles/versions/:no/restore", server.restoreGlobalStyleVersion)
		design.POST("/global-styles/discard", server.discardGlobalStyles)
		// The one "Publish site design" (#492, 8.2): every changed template, part and the
		// styles of the active theme, under one release.
		design.POST("/publish", server.publishSiteDesign)
		design.GET("/releases", server.listSiteDesignReleases)
		// A design preview token (#486) for the Astro server's preview cookie.
		design.POST("/preview", server.createDesignPreview)
		// Templates and parts (#490): Customize or New template. Their working copy is
		// edited through the collab server (template-<id>), never by REST.
		design.GET("/templates", server.listSiteTemplates)
		design.POST("/templates", server.createSiteTemplate)
		design.GET("/templates/:id", server.getSiteTemplate)
		design.DELETE("/templates/:id", server.deleteSiteTemplate)
		// Section 9 (#492): working_state, and what Start over and restores record after
		// the editor replaced the working copy (rule 9).
		design.POST("/templates/:id/reset", server.resetSiteTemplate)
		design.POST("/templates/:id/keep-editing", server.keepEditingSiteTemplate)
		design.GET("/templates/:id/default", server.getSiteTemplateDefault)
		design.POST("/templates/:id/start-over", server.startOverSiteTemplate)
		design.GET("/templates/:id/versions", server.listSiteTemplateVersions)
		design.GET("/templates/:id/versions/:no", server.getSiteTemplateVersion)
		design.POST("/templates/:id/versions/:no/restore", server.restoredSiteTemplateVersion)
	}
	// The named exception to requireSiteAdmin (design 12): the bearer is a design preview
	// token, and the handler re-checks that its user is still an admin on every read.
	router.GET("/site-design/draft", server.getDesignDraft)
}
