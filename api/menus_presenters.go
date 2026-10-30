package api

import (
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// MenuResponse is a menu in the admin. items is present on single-menu
// responses (GET/PUT /menus/:id[/items]); item_count on the list.
type MenuResponse struct {
	ID        int64              `json:"id"`
	Name      string             `json:"name"`
	Location  string             `json:"location"`
	ItemCount *int64             `json:"item_count,omitempty"`
	Items     []MenuItemResponse `json:"items,omitempty"`
	CreatedAt string             `json:"created_at"`
	ChangedAt string             `json:"changed_at"`
}

// MenuItemResponse is an admin menu item: what was stored (type, label,
// target) and what readers get (title, url, status). Items that readers don't
// see are still listed, with their status, so editors can fix or remove them.
type MenuItemResponse struct {
	ID       int64  `json:"id"`
	Type     string `json:"type"`
	Label    string `json:"label"`
	TargetID int64  `json:"target_id,omitempty"`
	// The archive's post type, or the post's.
	PostType string             `json:"post_type,omitempty"`
	Title    string             `json:"title"`
	URL      string             `json:"url"`
	Status   string             `json:"status"`
	Children []MenuItemResponse `json:"children"`
}

// PublicMenuResponse is GET /public/menus/:location: visible items only.
type PublicMenuResponse struct {
	Name     string           `json:"name"`
	Location string           `json:"location"`
	Items    []PublicMenuItem `json:"items"`
}

type PublicMenuItem struct {
	ID       int64            `json:"id"`
	Label    string           `json:"label"`
	URL      string           `json:"url"`
	Children []PublicMenuItem `json:"children"`
}

func toMenuResponse(menu db.Menu) MenuResponse {
	return MenuResponse{
		ID:        menu.ID,
		Name:      menu.Name,
		Location:  menu.Location.String,
		CreatedAt: menu.CreatedAt.Format(time.RFC3339),
		ChangedAt: menu.ChangedAt.Format(time.RFC3339),
	}
}

func toMenuListResponse(row db.ListMenusRow) MenuResponse {
	resp := toMenuResponse(db.Menu{ID: row.ID, Name: row.Name, Location: row.Location, CreatedAt: row.CreatedAt, ChangedAt: row.ChangedAt})
	count := row.ItemCount
	resp.ItemCount = &count
	return resp
}

// adminMenuItems arranges resolved items (in sort_order) as a tree. An item
// whose parent is gone, or is itself a child, is shown at the top level.
func adminMenuItems(items []resolvedMenuItem) []MenuItemResponse {
	out := []MenuItemResponse{}
	topIndex := map[int64]int{}
	for _, item := range items {
		resp := MenuItemResponse{
			ID:       item.Row.ID,
			Type:     item.Row.ItemType,
			Label:    item.Row.Label,
			TargetID: item.Row.PostID.Int64 + item.Row.TermID.Int64,
			PostType: item.Row.PostType.String,
			Title:    item.Title,
			URL:      item.URL,
			Status:   item.Status,
			Children: []MenuItemResponse{},
		}
		if item.Row.ItemType == "post" {
			resp.PostType = item.Row.PostPostType.String
		}
		if i, ok := topIndex[item.Row.ParentID.Int64]; item.Row.ParentID.Valid && ok {
			out[i].Children = append(out[i].Children, resp)
			continue
		}
		topIndex[resp.ID] = len(out)
		out = append(out, resp)
	}
	return out
}

// publicMenuItems keeps the visible items, as a tree. A visible child of a
// hidden parent takes the parent's place at the top level, so unpublishing a
// page doesn't take the links under it away.
func publicMenuItems(items []resolvedMenuItem) []PublicMenuItem {
	out := []PublicMenuItem{}
	topIndex := map[int64]int{}
	for _, item := range items {
		if item.Status != menuItemVisible {
			continue
		}
		resp := PublicMenuItem{ID: item.Row.ID, Label: item.Title, URL: item.URL, Children: []PublicMenuItem{}}
		if i, ok := topIndex[item.Row.ParentID.Int64]; item.Row.ParentID.Valid && ok {
			out[i].Children = append(out[i].Children, resp)
			continue
		}
		topIndex[resp.ID] = len(out)
		out = append(out, resp)
	}
	return out
}
