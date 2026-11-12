package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"

	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// pluginHost is pluginsdk.Host for one plugin's hook run (#458, design section 2): its
// settings, its logger, and a reader for each capability its plugin.json declares
// (nil otherwise, so a plugin that forgets one fails in development). Every reader is
// read-only; nothing here writes a post (rule 11).
type pluginHost struct {
	server *Server
	plugin hookPlugin
	log    *slog.Logger
}

var _ pluginsdk.Host = (*pluginHost)(nil)

func (h *pluginHost) declares(capability string) bool {
	return slices.Contains(h.plugin.manifest.Capabilities, capability)
}

func (h *pluginHost) Log() *slog.Logger { return h.log }

func (h *pluginHost) Posts() pluginsdk.PostReader {
	if !h.declares(pluginsdk.CapabilityPostsRead) {
		return nil
	}
	return pluginPostReader{server: h.server}
}

func (h *pluginHost) Media() pluginsdk.MediaReader {
	if !h.declares(pluginsdk.CapabilityMediaRead) {
		return nil
	}
	return pluginMediaReader{server: h.server}
}

func (h *pluginHost) Users() pluginsdk.UserReader {
	if !h.declares(pluginsdk.CapabilityUsersRead) {
		return nil
	}
	return pluginUserReader{server: h.server}
}

// Settings are plugin.json's defaults, overlaid with the values stored for the
// plugin in extension_settings (extension_type 'plugin', key
// plugin:<slug>:<field>, as 000052 named theme keys). A stored key the manifest
// doesn't declare is left out.
func (h *pluginHost) Settings(ctx context.Context) (map[string]any, error) {
	settings := map[string]any{}
	for field, spec := range h.plugin.manifest.Settings {
		if spec.Default != nil {
			settings[field] = spec.Default
		}
	}
	rows, err := h.server.store.ListPluginExtensionSettings(ctx, h.plugin.slug)
	if err != nil {
		return nil, err
	}
	prefix := "plugin:" + h.plugin.slug + ":"
	for _, row := range rows {
		field, ok := strings.CutPrefix(row.Key, prefix)
		if !ok {
			continue
		}
		if _, declared := h.plugin.manifest.Settings[field]; !declared {
			continue
		}
		var value any
		if err := json.Unmarshal(row.Value, &value); err != nil {
			continue
		}
		settings[field] = value
	}
	return settings, nil
}

type pluginPostReader struct{ server *Server }

func (r pluginPostReader) Get(ctx context.Context, id int64) (pluginsdk.Post, error) {
	post, err := r.server.store.GetPost(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return pluginsdk.Post{}, pluginsdk.ErrNotFound
	}
	if err != nil {
		return pluginsdk.Post{}, err
	}
	return pluginsdk.Post{
		ID:                 post.ID,
		Type:               post.PostType,
		Status:             post.PostStatus,
		Slug:               post.Slug,
		URL:                post.Url,
		Title:              post.Title,
		Excerpt:            post.Description,
		OwnerID:            post.UserID,
		CreatedAt:          post.CreatedAt,
		ChangedAt:          post.ChangedAt,
		BlockDoc:           post.BlockDoc,
		PublishedVersionID: post.PublishedVersionID.Int64,
	}, nil
}

// GetPublished is what the site shows: the published body, and the title and
// excerpt from the published settings (#358).
func (r pluginPostReader) GetPublished(ctx context.Context, id int64) (pluginsdk.Post, error) {
	post, err := r.server.store.GetPost(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return pluginsdk.Post{}, pluginsdk.ErrNotFound
	}
	if err != nil {
		return pluginsdk.Post{}, err
	}
	if post.PostStatus != "published" || !post.PublishedBlockDoc.Valid {
		return pluginsdk.Post{}, pluginsdk.ErrNotFound
	}
	title, excerpt := post.Title, post.Description
	if post.PublishedSettings.Valid {
		var settings struct {
			Title       *string `json:"title"`
			Description *string `json:"description"`
		}
		if json.Unmarshal(post.PublishedSettings.RawMessage, &settings) == nil {
			if settings.Title != nil {
				title = *settings.Title
			}
			if settings.Description != nil {
				excerpt = *settings.Description
			}
		}
	}
	return pluginsdk.Post{
		ID:                 post.ID,
		Type:               post.PostType,
		Status:             post.PostStatus,
		Slug:               post.Slug,
		URL:                post.Url,
		Title:              title,
		Excerpt:            excerpt,
		OwnerID:            post.UserID,
		CreatedAt:          post.CreatedAt,
		ChangedAt:          post.ChangedAt,
		BlockDoc:           post.PublishedBlockDoc.RawMessage,
		PublishedVersionID: post.PublishedVersionID.Int64,
	}, nil
}

type pluginMediaReader struct{ server *Server }

func (r pluginMediaReader) Get(ctx context.Context, id int64) (pluginsdk.Media, error) {
	media, err := r.server.store.GetMedia(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return pluginsdk.Media{}, pluginsdk.ErrNotFound
	}
	if err != nil {
		return pluginsdk.Media{}, err
	}
	return pluginsdk.Media{
		ID:          media.ID,
		Name:        media.Name,
		Alt:         media.Alt,
		Description: media.Description,
		MimeType:    media.MimeType,
		URL:         publicMediaPath(r.server.config.UploadPath, media.MediaPath),
		Width:       int(media.Width),
		Height:      int(media.Height),
		FileSize:    media.FileSize,
		CreatedAt:   media.CreatedAt,
	}, nil
}

type pluginUserReader struct{ server *Server }

// Get returns a member's public fields only: never the email or password fields.
func (r pluginUserReader) Get(ctx context.Context, id int64) (pluginsdk.User, error) {
	user, err := r.server.store.GetUser(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return pluginsdk.User{}, pluginsdk.ErrNotFound
	}
	if err != nil {
		return pluginsdk.User{}, err
	}
	return pluginsdk.User{ID: user.ID, Username: user.Username, Name: user.FullName, Role: user.Role}, nil
}
