package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// listPlugins is GET /plugins (admin): every registered plugin, missing and
// incompatible ones included, and core's plugin_api range.
func (server *Server) listPlugins(c *gin.Context) {
	plugins, err := server.store.ListPlugins(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list plugins"})
		return
	}
	rsp := make([]PluginResponse, 0, len(plugins))
	for _, plugin := range plugins {
		rsp = append(rsp, server.toPluginResponse(plugin, false))
	}
	c.JSON(http.StatusOK, gin.H{
		"plugins":    rsp,
		"count":      len(rsp),
		"plugin_api": PluginAPIRange{Min: PluginAPIMin, Max: PluginAPIMax},
	})
}

// getPlugin is GET /plugins/:slug (admin), with the stored manifest.
func (server *Server) getPlugin(c *gin.Context) {
	plugin, ok := server.loadPlugin(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"plugin": server.toPluginResponse(plugin, true)})
}

// listEnabledPlugins is GET /plugins/enabled (content roles): the slugs of the plugins
// that are enabled and installed, which is what the block menus offer (design section
// 4.3). Slugs only: who may see more is the admin routes' business.
func (server *Server) listEnabledPlugins(c *gin.Context) {
	slugs, err := server.store.ListEnabledPluginSlugs(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list enabled plugins"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"plugins": slugs})
}

// loadPlugin reads the plugin named by :slug, answering 404 (plugin_not_found) or 500
// itself when it can't.
func (server *Server) loadPlugin(c *gin.Context) (db.Plugin, bool) {
	slug := c.Param("slug")
	if !pluginIDRe.MatchString(slug) {
		respondPluginNotFound(c)
		return db.Plugin{}, false
	}
	plugin, err := server.store.GetPluginBySlug(c.Request.Context(), slug)
	if errors.Is(err, sql.ErrNoRows) {
		respondPluginNotFound(c)
		return db.Plugin{}, false
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the plugin"})
		return db.Plugin{}, false
	}
	return plugin, true
}

func respondPluginNotFound(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"error": "plugin not found", "code": "plugin_not_found"})
}
