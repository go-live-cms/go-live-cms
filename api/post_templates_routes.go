package api

import "github.com/gin-gonic/gin"

// registerPostTemplateRoutes registers /post-templates (#322, post_templates.go).
// Templates are listed and used by every content role (the new-post chooser);
// only admins and editors save, rename and delete them.
func (server *Server) registerPostTemplateRoutes(rg *gin.RouterGroup) {
	templates := rg.Group("/post-templates")
	auth := server.requireAuth()
	author := requireContentAuthor(server)
	editor := requireContentEditor(server)

	templates.GET("", auth, author, server.listPostTemplates)
	templates.POST("", auth, editor, server.createPostTemplate)
	templates.PUT("/:id", auth, editor, server.renamePostTemplate)
	templates.DELETE("/:id", auth, editor, server.deletePostTemplate)
	// A new draft owned by the caller; the handler checks canCreatePost.
	templates.POST("/:id/posts", auth, author, server.createPostFromTemplate)
}
