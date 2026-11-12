package api

import (
	"encoding/json"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// PluginResponse is one plugin as the Plugins page (#11) shows it. Capabilities are
// declared and shown; they don't restrict anything in Beta (design section 2).
type PluginResponse struct {
	ID          int64  `json:"id"`
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Author      string `json:"author"`
	Description string `json:"description"`
	// Status: installed | missing (gone from the build, row kept) | incompatible.
	Status string `json:"status"`
	// IncompatibleReason, for an incompatible plugin: "plugin_api" (outside core's
	// range), "hooks" (its server hooks in Go differ from plugin.json's server.hooks,
	// #458) or "invalid_manifest" (plugin.json stopped validating; the fields here are
	// from the last valid one).
	IncompatibleReason string `json:"incompatible_reason,omitempty"`
	// Enabled is the admin's choice, kept while missing or incompatible. Active is
	// whether it applies now: enabled and installed.
	Enabled     bool       `json:"enabled"`
	Active      bool       `json:"active"`
	EnabledAt   *time.Time `json:"enabled_at"`
	EnabledBy   *int64     `json:"enabled_by"`
	InstalledAt time.Time  `json:"installed_at"`
	ChangedAt   time.Time  `json:"changed_at"`
	// ContentHash is the SHA-256 over the plugin's files.
	ContentHash  string       `json:"content_hash"`
	PluginAPI    int          `json:"plugin_api"`
	Capabilities []string     `json:"capabilities"`
	Blocks       []string     `json:"blocks"`
	Hooks        []PluginHook `json:"hooks"`
	HasSettings  bool         `json:"has_settings"`
	// Manifest is the stored plugin.json, on GET /plugins/:slug only.
	Manifest json.RawMessage `json:"manifest,omitempty"`
}

// PluginAPIRange is core's plugin_api range.
type PluginAPIRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

func (server *Server) toPluginResponse(plugin db.Plugin, withManifest bool) PluginResponse {
	// The row's manifest was validated when it was stored; a decode failure only
	// leaves the derived lists empty.
	var manifest PluginManifest
	_ = json.Unmarshal(plugin.Manifest, &manifest)

	rsp := PluginResponse{
		ID:           plugin.ID,
		Slug:         plugin.Slug,
		Name:         plugin.Name,
		Version:      plugin.Version,
		Author:       plugin.Author,
		Description:  plugin.Description,
		Status:       plugin.Status,
		Enabled:      plugin.Enabled,
		Active:       plugin.Enabled && plugin.Status == PluginStatusInstalled,
		InstalledAt:  plugin.InstalledAt,
		ChangedAt:    plugin.ChangedAt,
		ContentHash:  plugin.ContentHash,
		PluginAPI:    manifest.PluginAPI,
		Capabilities: nonNilStrings(manifest.Capabilities),
		Blocks:       nonNilStrings(manifest.Blocks),
		Hooks:        manifest.Server.Hooks,
		HasSettings:  len(manifest.Settings) > 0,
	}
	if rsp.Hooks == nil {
		rsp.Hooks = []PluginHook{}
	}
	if plugin.Status == PluginStatusIncompatible {
		rsp.IncompatibleReason = "invalid_manifest"
		switch {
		case !pluginAPICompatible(manifest.PluginAPI):
			rsp.IncompatibleReason = "plugin_api"
		case server.pluginHooksMismatch(plugin.Slug, manifest) != "":
			// #458: its plugin.json and its Go code declare different hooks.
			rsp.IncompatibleReason = "hooks"
		}
	}
	if plugin.EnabledAt.Valid {
		at := plugin.EnabledAt.Time
		rsp.EnabledAt = &at
	}
	if plugin.EnabledBy.Valid {
		by := plugin.EnabledBy.Int64
		rsp.EnabledBy = &by
	}
	if withManifest {
		rsp.Manifest = plugin.Manifest
	}
	return rsp
}

func nonNilStrings(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}
