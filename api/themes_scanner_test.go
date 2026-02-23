package api

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParsePostTypes_FullConfig(t *testing.T) {
	configStr := `
export const themeConfig = {
  name: "Example Theme",
  postTypes: [
    {
      name: "product",
      label: "Products",
      description: "Product listings for the store",
      icon: "shopping-bag",
      hierarchical: false,
      hasArchive: true,
      menuPosition: 5,
      supports: ["title", "content", "description", "featured_image"],
    },
  ],
}
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 1)

	pt := postTypes[0]
	require.Equal(t, "product", pt.Name)
	require.Equal(t, "Products", pt.Label)
	require.Equal(t, "Product listings for the store", pt.Description)
	require.Equal(t, "shopping-bag", pt.Icon)
	require.False(t, pt.Hierarchical)
	require.True(t, pt.HasArchive)
	require.Equal(t, int32(5), pt.MenuPosition)
	require.Equal(t, []string{"title", "content", "description", "featured_image"}, pt.Supports)
}

func TestParsePostTypes_MultipleTypes(t *testing.T) {
	configStr := `
  postTypes: [
    {
      name: "product",
      label: "Products",
    },
    {
      name: "portfolio",
      label: "Portfolio Items",
      hierarchical: true,
      hasArchive: false,
      menuPosition: 10,
    },
  ],
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 2)

	require.Equal(t, "product", postTypes[0].Name)
	require.Equal(t, "Products", postTypes[0].Label)
	require.True(t, postTypes[0].HasArchive)                                             // default
	require.Equal(t, []string{"title", "content", "description"}, postTypes[0].Supports) // default

	require.Equal(t, "portfolio", postTypes[1].Name)
	require.Equal(t, "Portfolio Items", postTypes[1].Label)
	require.True(t, postTypes[1].Hierarchical)
	require.False(t, postTypes[1].HasArchive)
	require.Equal(t, int32(10), postTypes[1].MenuPosition)
}

func TestParsePostTypes_SkipsSystemTypes(t *testing.T) {
	configStr := `
  postTypes: [
    { name: "post", label: "Posts" },
    { name: "page", label: "Pages" },
    { name: "product", label: "Products" },
  ],
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 1)
	require.Equal(t, "product", postTypes[0].Name)
}

func TestParsePostTypes_DefaultLabel(t *testing.T) {
	configStr := `
  postTypes: [
    { name: "recipe" },
  ],
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 1)
	require.Equal(t, "recipe", postTypes[0].Name)
	require.Equal(t, "Recipe", postTypes[0].Label) // auto-capitalized
}

func TestParsePostTypes_NoPostTypes(t *testing.T) {
	configStr := `
export const themeConfig = {
  name: "Simple Theme",
  version: "1.0.0",
}
`
	postTypes := parsePostTypes(configStr)
	require.Empty(t, postTypes)
}

func TestParsePostTypes_EmptyArray(t *testing.T) {
	configStr := `
  postTypes: [],
`
	postTypes := parsePostTypes(configStr)
	require.Empty(t, postTypes)
}

func TestParsePostTypes_DoubleQuotes(t *testing.T) {
	configStr := `
  postTypes: [
    { name: "event", label: "Events", description: "Calendar events" },
  ],
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 1)
	require.Equal(t, "event", postTypes[0].Name)
	require.Equal(t, "Events", postTypes[0].Label)
	require.Equal(t, "Calendar events", postTypes[0].Description)
}

func TestParsePostTypes_SingleQuotes(t *testing.T) {
	configStr := `
  postTypes: [
    { name: 'event', label: 'Events' },
  ],
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 1)
	require.Equal(t, "event", postTypes[0].Name)
	require.Equal(t, "Events", postTypes[0].Label)
}

func TestParsePostTypes_SupportsArray(t *testing.T) {
	configStr := `
  postTypes: [
    {
      name: "product",
      label: "Products",
      supports: ["title", "content"],
    },
  ],
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 1)
	require.Equal(t, []string{"title", "content"}, postTypes[0].Supports)
}

func TestDiscoveredPostTypeDefaults(t *testing.T) {
	configStr := `
  postTypes: [
    { name: "custom" },
  ],
`
	postTypes := parsePostTypes(configStr)
	require.Len(t, postTypes, 1)

	pt := postTypes[0]
	require.Equal(t, "custom", pt.Name)
	require.Equal(t, "Custom", pt.Label)                                       // auto-capitalized
	require.Equal(t, []string{"title", "content", "description"}, pt.Supports) // defaults
	require.True(t, pt.HasArchive)                                             // default true
	require.False(t, pt.Hierarchical)                                          // default false
	require.Equal(t, int32(0), pt.MenuPosition)                                // default zero
}
