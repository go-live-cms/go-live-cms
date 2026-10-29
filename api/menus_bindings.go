package api

// Request bodies for the menus endpoints (#347).

// SaveMenuRequest is the body of POST /menus and PUT /menus/:id. location is
// a theme location name ("primary", "footer") or "" for none. Absent: none on
// create, unchanged on update (so a rename can't reassign a location from a
// stale copy). Assigning a location moves it from the menu that had it.
type SaveMenuRequest struct {
	Name     string  `json:"name" binding:"required,max=100"`
	Location *string `json:"location" binding:"omitempty,max=64"`
}

// MenuItemRequest is one item of PUT /menus/:id/items. Which fields apply
// depends on type:
//   - post: target_id is the post's id (any post type, pages included)
//   - term: target_id is the taxonomy term's id
//   - archive: post_type is the post type whose list it links to
//   - custom: url (http(s) or site-relative) and a label
//
// label is optional for the first three: empty shows the target's title.
// children are one level deep: a child can't have children of its own.
type MenuItemRequest struct {
	Type     string            `json:"type" binding:"required,oneof=post term archive custom"`
	Label    string            `json:"label" binding:"max=200"`
	TargetID int64             `json:"target_id" binding:"omitempty,min=1"`
	PostType string            `json:"post_type" binding:"omitempty,max=100,identifier"`
	URL      string            `json:"url" binding:"max=2048"`
	Children []MenuItemRequest `json:"children" binding:"max=100,dive"`
}

// SaveMenuItemsRequest replaces a menu's whole item tree: the admin edits the
// tree locally (add, reorder, nest) and saves it in one request.
type SaveMenuItemsRequest struct {
	Items []MenuItemRequest `json:"items" binding:"max=200,dive"`
}
