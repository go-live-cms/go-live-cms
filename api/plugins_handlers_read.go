package api

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

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
		rsp = append(rsp, toPluginResponse(plugin, false))
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
	c.JSON(http.StatusOK, gin.H{"plugin": toPluginResponse(plugin, true)})
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

// pluginUsageListMax caps the posts listed by GET /plugins/:slug/usage; `count` is every match.
const pluginUsageListMax = 100

// PluginUsagePost is one post holding a plugin's blocks.
type PluginUsagePost struct {
	ID         int64  `json:"id"`
	Title      string `json:"title"`
	PostType   string `json:"post_type"`
	PostStatus string `json:"post_status"`
	// Where the blocks are: the working copy (the editor's), the published page, or both.
	InWorkingCopy bool      `json:"in_working_copy"`
	InPublished   bool      `json:"in_published"`
	ChangedAt     time.Time `json:"changed_at"`
}

// getPluginUsage is GET /plugins/:slug/usage (admin, #456, design 4.3): how many posts hold
// a block of the plugin (`plugin:<slug>/…`) in their working copy or published snapshot,
// and the most recently changed of them. The Plugins page's disable confirmation says "used
// in N posts" from `count`; the list is where an admin who wants the block off the site
// removes it, since disabling never changes a published page (design 4.4). Every status is
// counted, the trash included. Known for a plugin of any status (a missing plugin's blocks
// are still stored).
func (server *Server) getPluginUsage(c *gin.Context) {
	plugin, ok := server.loadPlugin(c)
	if !ok {
		return
	}
	rows, err := server.store.ListPostsUsingPluginBlocks(c.Request.Context(), db.ListPostsUsingPluginBlocksParams{
		TypePrefix: "plugin:" + plugin.Slug + "/",
		RowLimit:   pluginUsageListMax,
	})
	if err != nil {
		server.requestLog(c).Warn("plugin_usage_failed", "plugin", plugin.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count the plugin's posts"})
		return
	}
	posts := make([]PluginUsagePost, 0, len(rows))
	count := int64(0)
	for _, row := range rows {
		count = row.Total
		posts = append(posts, PluginUsagePost{
			ID: row.ID, Title: row.Title, PostType: row.PostType, PostStatus: row.PostStatus,
			InWorkingCopy: row.InWorkingCopy, InPublished: row.InPublished, ChangedAt: row.ChangedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"slug":      plugin.Slug,
		"count":     count,
		"posts":     posts,
		"truncated": count > int64(len(posts)),
	})
}
