package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// enablePlugin is POST /plugins/:slug/enable (admin). Only an installed, compatible
// plugin can be enabled: 409 plugin_missing or plugin_incompatible otherwise. Enabling
// an enabled plugin answers 200 and records nothing. Nothing else changes: the editor
// and collab schemas follow what is installed, not what is enabled (design section
// 5.3), so no restart and no open tab notices.
func (server *Server) enablePlugin(c *gin.Context) {
	plugin, ok := server.loadPlugin(c)
	if !ok {
		return
	}
	if plugin.Status != PluginStatusInstalled {
		respondPluginNotEnableable(c, plugin)
		return
	}
	if plugin.Enabled {
		c.JSON(http.StatusOK, gin.H{"plugin": toPluginResponse(plugin, false)})
		return
	}

	caller := getAuthPayload(c).UserID
	enabled, err := server.store.EnablePlugin(c.Request.Context(), db.EnablePluginParams{
		Slug:      plugin.Slug,
		EnabledBy: sql.NullInt64{Int64: caller, Valid: caller != 0},
	})
	if errors.Is(err, sql.ErrNoRows) {
		// Changed since it was read: enabled by someone else (fine), or marked
		// missing or incompatible by a scan (refused).
		server.respondPluginRaced(c, plugin.Slug, true)
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to enable the plugin"})
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb: db.ActivityPluginEnabled, ObjectType: db.ActivityObjectPlugin, ObjectID: enabled.ID,
		Payload: map[string]any{"version": enabled.Version},
	})
	c.JSON(http.StatusOK, gin.H{"plugin": toPluginResponse(enabled, false)})
}

// disablePlugin is POST /plugins/:slug/disable (admin), in any status: it's how an
// admin stops a misbehaving plugin, and a missing plugin that comes back then stays
// off. Disabling a disabled plugin answers 200 and records nothing. A disabled
// plugin's blocks keep editing and rendering (design section 4.4).
func (server *Server) disablePlugin(c *gin.Context) {
	plugin, ok := server.loadPlugin(c)
	if !ok {
		return
	}
	if !plugin.Enabled {
		c.JSON(http.StatusOK, gin.H{"plugin": toPluginResponse(plugin, false)})
		return
	}
	disabled, err := server.store.DisablePlugin(c.Request.Context(), plugin.Slug)
	if errors.Is(err, sql.ErrNoRows) {
		server.respondPluginRaced(c, plugin.Slug, false) // disabled by someone else meanwhile
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to disable the plugin"})
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb: db.ActivityPluginDisabled, ObjectType: db.ActivityObjectPlugin, ObjectID: disabled.ID,
		Payload: map[string]any{"version": disabled.Version},
	})
	c.JSON(http.StatusOK, gin.H{"plugin": toPluginResponse(disabled, false)})
}

// respondPluginRaced answers an enable or disable whose conditional update matched no
// row: the plugin changed between the read and the write, so the answer is its state
// now. Another request did the same change: 200, recorded by that one.
func (server *Server) respondPluginRaced(c *gin.Context, slug string, enabling bool) {
	plugin, err := server.store.GetPluginBySlug(c.Request.Context(), slug)
	if errors.Is(err, sql.ErrNoRows) {
		respondPluginNotFound(c)
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the plugin"})
		return
	}
	if enabling && !plugin.Enabled {
		respondPluginNotEnableable(c, plugin)
		return
	}
	c.JSON(http.StatusOK, gin.H{"plugin": toPluginResponse(plugin, false)})
}

func respondPluginNotEnableable(c *gin.Context, plugin db.Plugin) {
	rsp := gin.H{"plugin": toPluginResponse(plugin, false)}
	switch plugin.Status {
	case PluginStatusInstalled:
		// Only after a lost race: it was enabled and disabled again meanwhile.
		rsp["error"] = "the plugin changed meanwhile; try again"
		rsp["code"] = "plugin_changed"
	case PluginStatusMissing:
		rsp["error"] = "the plugin is not in this build"
		rsp["code"] = "plugin_missing"
	case PluginStatusIncompatible:
		rsp["error"] = "the plugin is not compatible with this version of GoLive"
		rsp["code"] = "plugin_incompatible"
	}
	c.JSON(http.StatusConflict, rsp)
}
