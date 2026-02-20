package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/sqlc-dev/pqtype"
)

// DiscoveredTheme represents a theme found in the filesystem
type DiscoveredTheme struct {
	Slug        string
	Name        string
	Description string
	Version     string
	Author      string
	Config      map[string]interface{}
	Path        string
	PostTypes   []DiscoveredPostType
}

// DiscoveredPostType represents a post type declared in a theme's config
type DiscoveredPostType struct {
	Name         string   `json:"name"`
	Label        string   `json:"label"`
	Description  string   `json:"description"`
	Hierarchical bool     `json:"hierarchical"`
	HasArchive   bool     `json:"has_archive"`
	MenuPosition int32    `json:"menu_position"`
	Supports     []string `json:"supports"`
	Icon         string   `json:"icon"`
}

// ScanThemesDirectory scans the web/themes directory and returns discovered themes
func ScanThemesDirectory(themesPath string) ([]DiscoveredTheme, error) {
	var themes []DiscoveredTheme

	// Check if themes directory exists
	if _, err := os.Stat(themesPath); os.IsNotExist(err) {
		return themes, fmt.Errorf("themes directory not found: %s", themesPath)
	}

	// Read all entries in themes directory
	entries, err := os.ReadDir(themesPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read themes directory: %w", err)
	}

	for _, entry := range entries {
		// Skip files, only process directories
		if !entry.IsDir() {
			continue
		}

		// Skip hidden directories and system-theme
		if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "system-theme" {
			continue
		}

		themePath := filepath.Join(themesPath, entry.Name())
		configPath := filepath.Join(themePath, "theme.config.ts")

		// Check if theme.config.ts exists
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			fmt.Printf("Warning: Skipping '%s' - missing theme.config.ts\n", entry.Name())
			continue
		}

		// Validate required layout files exist
		requiredLayouts := []string{
			filepath.Join(themePath, "layouts", "post", "default.astro"),
			filepath.Join(themePath, "layouts", "page", "default.astro"),
		}

		missingLayouts := false
		for _, layoutPath := range requiredLayouts {
			if _, err := os.Stat(layoutPath); os.IsNotExist(err) {
				fmt.Printf("Warning: Skipping '%s' - missing required layout: %s\n", entry.Name(), layoutPath)
				missingLayouts = true
				break
			}
		}

		if missingLayouts {
			continue
		}

		// Parse theme config
		theme, err := parseThemeConfig(entry.Name(), configPath, themePath)
		if err != nil {
			fmt.Printf("Warning: Failed to parse theme config for %s: %v\n", entry.Name(), err)
			continue
		}

		themes = append(themes, theme)
	}

	return themes, nil
}

// parseThemeConfig extracts theme metadata from theme.config.ts
func parseThemeConfig(slug, configPath, themePath string) (DiscoveredTheme, error) {
	theme := DiscoveredTheme{
		Slug: slug,
		Path: themePath,
	}

	// Read config file
	content, err := os.ReadFile(configPath)
	if err != nil {
		return theme, fmt.Errorf("failed to read config file: %w", err)
	}

	configStr := string(content)

	// Extract name
	if match := regexp.MustCompile(`name:\s*["']([^"']+)["']`).FindStringSubmatch(configStr); len(match) > 1 {
		theme.Name = match[1]
	} else {
		theme.Name = slug // fallback to directory name
	}

	// Extract description
	if match := regexp.MustCompile(`description:\s*["']([^"']+)["']`).FindStringSubmatch(configStr); len(match) > 1 {
		theme.Description = match[1]
	}

	// Extract version
	if match := regexp.MustCompile(`version:\s*["']([^"']+)["']`).FindStringSubmatch(configStr); len(match) > 1 {
		theme.Version = match[1]
	} else {
		theme.Version = "1.0.0"
	}

	// Extract author
	if match := regexp.MustCompile(`author:\s*["']([^"']+)["']`).FindStringSubmatch(configStr); len(match) > 1 {
		theme.Author = match[1]
	}

	// Extract layouts configuration (simplified JSON extraction)
	layoutsRegex := regexp.MustCompile(`layouts:\s*\{([^}]+(?:\{[^}]+\}[^}]*)*)\}`)
	if match := layoutsRegex.FindStringSubmatch(configStr); len(match) > 1 {
		// Build a simplified config structure
		theme.Config = map[string]interface{}{
			"layouts": map[string]interface{}{
				"post": map[string]interface{}{
					"default":  "default",
					"variants": []string{"default", "sidebar", "wide"},
				},
				"page": map[string]interface{}{
					"default":  "default",
					"variants": []string{"default", "fullwidth"},
				},
			},
		}
	}

	// Extract postTypes declarations
	theme.PostTypes = parsePostTypes(configStr)

	return theme, nil
}

// parsePostTypes extracts post type declarations from theme.config.ts content.
// Looks for a postTypes array with objects containing name, label, description, etc.
func parsePostTypes(configStr string) []DiscoveredPostType {
	var postTypes []DiscoveredPostType

	// Match the postTypes array block
	postTypesRegex := regexp.MustCompile(`postTypes:\s*\[([\s\S]*?)\]`)
	match := postTypesRegex.FindStringSubmatch(configStr)
	if len(match) < 2 {
		return postTypes
	}

	arrayContent := match[1]

	// Match each object in the array
	objectRegex := regexp.MustCompile(`\{([^}]+)\}`)
	objects := objectRegex.FindAllStringSubmatch(arrayContent, -1)

	for _, obj := range objects {
		if len(obj) < 2 {
			continue
		}
		objStr := obj[1]

		pt := DiscoveredPostType{
			HasArchive: true, // default
		}

		// Extract name
		if m := regexp.MustCompile(`name:\s*["']([^"']+)["']`).FindStringSubmatch(objStr); len(m) > 1 {
			pt.Name = m[1]
		}

		// Extract label
		if m := regexp.MustCompile(`label:\s*["']([^"']+)["']`).FindStringSubmatch(objStr); len(m) > 1 {
			pt.Label = m[1]
		}

		// Extract description
		if m := regexp.MustCompile(`description:\s*["']([^"']+)["']`).FindStringSubmatch(objStr); len(m) > 1 {
			pt.Description = m[1]
		}

		// Extract icon
		if m := regexp.MustCompile(`icon:\s*["']([^"']+)["']`).FindStringSubmatch(objStr); len(m) > 1 {
			pt.Icon = m[1]
		}

		// Extract hierarchical
		if m := regexp.MustCompile(`hierarchical:\s*(true|false)`).FindStringSubmatch(objStr); len(m) > 1 {
			pt.Hierarchical = m[1] == "true"
		}

		// Extract hasArchive
		if m := regexp.MustCompile(`hasArchive:\s*(true|false)`).FindStringSubmatch(objStr); len(m) > 1 {
			pt.HasArchive = m[1] == "true"
		}

		// Extract menuPosition
		if m := regexp.MustCompile(`menuPosition:\s*(\d+)`).FindStringSubmatch(objStr); len(m) > 1 {
			pos, _ := strconv.Atoi(m[1])
			pt.MenuPosition = int32(pos)
		}

		// Extract supports array
		if m := regexp.MustCompile(`supports:\s*\[(.*?)\]`).FindStringSubmatch(objStr); len(m) > 1 {
			supportItems := regexp.MustCompile(`["']([^"']+)["']`).FindAllStringSubmatch(m[1], -1)
			for _, item := range supportItems {
				if len(item) > 1 {
					pt.Supports = append(pt.Supports, item[1])
				}
			}
		}

		// Only add if name is present and not a system type
		if pt.Name != "" && pt.Name != "post" && pt.Name != "page" {
			if pt.Label == "" {
				pt.Label = strings.Title(pt.Name) //nolint:staticcheck
			}
			if pt.Supports == nil {
				pt.Supports = []string{"title", "content", "description"}
			}
			postTypes = append(postTypes, pt)
		}
	}

	return postTypes
}

// SyncThemesToDatabase syncs discovered themes with the database
func (server *Server) SyncThemesToDatabase(themes []DiscoveredTheme) error {
	// Build a map of discovered theme slugs for quick lookup
	discoveredSlugs := make(map[string]bool)
	for _, theme := range themes {
		discoveredSlugs[theme.Slug] = true
	}

	// Get all themes from database
	dbThemes, err := server.store.ListThemes(server.ctx)
	if err != nil {
		fmt.Printf("Warning: Failed to list database themes: %v\n", err)
	} else {
		// Delete themes that no longer exist in filesystem
		for _, dbTheme := range dbThemes {
			if !discoveredSlugs[dbTheme.Slug] {
				// Don't delete if it's the active theme
				if dbTheme.Active {
					fmt.Printf("⚠️  Theme '%s' not found in filesystem but is active - keeping in database\n", dbTheme.Slug)
					continue
				}

				err := server.store.DeleteTheme(server.ctx, dbTheme.ID)
				if err != nil {
					fmt.Printf("Warning: Failed to delete orphaned theme %s: %v\n", dbTheme.Slug, err)
				} else {
					fmt.Printf("✓ Removed orphaned theme: %s\n", dbTheme.Name)
				}
			}
		}
	}

	// Create or update discovered themes
	for _, theme := range themes {
		// Convert config to JSON
		configJSON, err := json.Marshal(theme.Config)
		if err != nil {
			fmt.Printf("Warning: Failed to marshal config for theme %s: %v\n", theme.Slug, err)
			continue
		}

		// Ensure we have a version
		version := theme.Version
		if version == "" {
			version = "1.0.0"
		}

		// Check if theme exists in database
		existingTheme, err := server.store.GetThemeBySlug(server.ctx, theme.Slug)

		if err != nil {
			// Theme doesn't exist, create it
			_, err := server.store.CreateTheme(server.ctx, db.CreateThemeParams{
				Name: theme.Name,
				Slug: theme.Slug,
				Description: sql.NullString{
					String: theme.Description,
					Valid:  theme.Description != "",
				},
				Version: version,
				Author: sql.NullString{
					String: theme.Author,
					Valid:  theme.Author != "",
				},
				Config: configJSON,
				Active: false, // New themes are inactive by default
			})

			if err != nil {
				fmt.Printf("Warning: Failed to create theme %s: %v\n", theme.Slug, err)
			} else {
				fmt.Printf("✓ Registered new theme: %s\n", theme.Name)
			}
		} else {
			// Theme exists, update metadata but preserve active status
			_, err := server.store.UpdateTheme(server.ctx, db.UpdateThemeParams{
				ID: existingTheme.ID,
				Name: sql.NullString{
					String: theme.Name,
					Valid:  true,
				},
				Description: sql.NullString{
					String: theme.Description,
					Valid:  theme.Description != "",
				},
				Version: sql.NullString{
					String: version,
					Valid:  true,
				},
				Author: sql.NullString{
					String: theme.Author,
					Valid:  theme.Author != "",
				},
				Config: pqtype.NullRawMessage{
					RawMessage: configJSON,
					Valid:      true,
				},
			})

			if err != nil {
				fmt.Printf("Warning: Failed to update theme %s: %v\n", theme.Slug, err)
			}
		}
	}

	// Sync theme-declared post types
	for _, theme := range themes {
		registeredBy := fmt.Sprintf("theme:%s", theme.Slug)

		// Check if this theme is active
		existingTheme, err := server.store.GetThemeBySlug(server.ctx, theme.Slug)
		if err != nil {
			continue
		}
		isActive := existingTheme.Active

		for _, pt := range theme.PostTypes {
			supportsJSON, _ := json.Marshal(pt.Supports)

			_, err := server.store.UpsertPostType(server.ctx, db.UpsertPostTypeParams{
				Name:  pt.Name,
				Label: pt.Label,
				Description: sql.NullString{
					String: pt.Description,
					Valid:  pt.Description != "",
				},
				Public:       true,
				Hierarchical: pt.Hierarchical,
				HasArchive:   pt.HasArchive,
				MenuPosition: sql.NullInt32{
					Int32: pt.MenuPosition,
					Valid: pt.MenuPosition > 0,
				},
				Supports:     supportsJSON,
				IsActive:     isActive,
				RegisteredBy: registeredBy,
			})
			if err != nil {
				fmt.Printf("Warning: Failed to upsert post type '%s' for theme '%s': %v\n", pt.Name, theme.Slug, err)
			} else if isActive {
				fmt.Printf("✓ Registered post type: %s (from theme %s)\n", pt.Name, theme.Slug)
			}
		}
	}

	return nil
}
