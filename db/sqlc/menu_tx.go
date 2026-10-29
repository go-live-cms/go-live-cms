package db

import (
	"context"
	"database/sql"
	"errors"
)

// ErrMenuItemParent is returned by ReplaceMenuItemsTx when an item's parent
// isn't an earlier top-level item of the same list.
var ErrMenuItemParent = errors.New("menu item parent must be an earlier top-level item")

type SaveMenuTxParams struct {
	// 0 creates a menu.
	ID       int64
	Name     string
	Location sql.NullString
}

// SaveMenuTx creates or updates a menu. Assigning a location moves it: the
// menu that held it loses it in the same transaction. Two saves racing for
// one location still can't both win (idx_menus_location), the loser gets a
// unique violation. Updating a missing menu returns sql.ErrNoRows.
func (store *SQLStore) SaveMenuTx(ctx context.Context, arg SaveMenuTxParams) (Menu, error) {
	var menu Menu

	err := store.execTx(ctx, func(q *Queries) error {
		if arg.Location.Valid {
			if err := q.ClearMenuLocation(ctx, ClearMenuLocationParams{Location: arg.Location, ID: arg.ID}); err != nil {
				return err
			}
		}
		var err error
		if arg.ID == 0 {
			menu, err = q.CreateMenu(ctx, CreateMenuParams{Name: arg.Name, Location: arg.Location})
		} else {
			menu, err = q.UpdateMenu(ctx, UpdateMenuParams{ID: arg.ID, Name: arg.Name, Location: arg.Location})
		}
		return err
	})

	return menu, err
}

// MenuItemInput is one item of ReplaceMenuItemsTx's list.
type MenuItemInput struct {
	// Index of the parent in the same list, -1 for a top-level item.
	ParentIndex int
	ItemType    string
	Label       string
	PostID      sql.NullInt64
	TermID      sql.NullInt64
	PostType    sql.NullString
	Url         string
}

type ReplaceMenuItemsTxParams struct {
	MenuID int64
	// In reading order: each child after its parent.
	Items []MenuItemInput
}

// ReplaceMenuItemsTx replaces every item of a menu with the given list, whose
// position becomes sort_order. The menu row is locked first, so concurrent
// saves of one menu apply one after the other instead of interleaving.
// Returns sql.ErrNoRows for a missing menu; a target that doesn't exist fails
// on its foreign key.
func (store *SQLStore) ReplaceMenuItemsTx(ctx context.Context, arg ReplaceMenuItemsTxParams) ([]MenuItem, error) {
	items := make([]MenuItem, 0, len(arg.Items))

	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.GetMenuForUpdate(ctx, arg.MenuID); err != nil {
			return err
		}
		if err := q.DeleteMenuItems(ctx, arg.MenuID); err != nil {
			return err
		}
		for i, input := range arg.Items {
			var parent sql.NullInt64
			if input.ParentIndex >= 0 {
				if input.ParentIndex >= i || arg.Items[input.ParentIndex].ParentIndex >= 0 {
					return ErrMenuItemParent
				}
				parent = sql.NullInt64{Int64: items[input.ParentIndex].ID, Valid: true}
			}
			item, err := q.CreateMenuItem(ctx, CreateMenuItemParams{
				MenuID:    arg.MenuID,
				ParentID:  parent,
				SortOrder: int32(i),
				ItemType:  input.ItemType,
				Label:     input.Label,
				PostID:    input.PostID,
				TermID:    input.TermID,
				PostType:  input.PostType,
				Url:       input.Url,
			})
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		return q.TouchMenu(ctx, arg.MenuID)
	})
	if err != nil {
		return nil, err
	}

	return items, nil
}
