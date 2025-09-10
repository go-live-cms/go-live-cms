const headingLabel = (lvl?: number) => {
switch (lvl) {
    case 1:
    return "Heading 1…"
    case 2:
    return "Heading 2…"
    case 3:
    return "Heading 3…"
    default:
    return "Heading…"
}
}

export const editorPlaceholderConfig = {
    includeChildren: true,
    showOnlyWhenEditable: true,
    placeholder: ({ node, editor }) => {
        switch (node.type.name) {
            case "codeBlock":
                return "Write code…"
            case "blockquote":
                return "Write a quote…"
            case "horizontalRule":
                return ""
            case "image":
                return ""
            case "heading":
                return headingLabel(node.attrs?.level)
            case "listItem":
                return editor.isActive("orderedList") ? "List item…" : "List item…"
            case "paragraph":
            default: {
                if (editor.isActive("codeBlock")) return "Write code…"
                if (editor.isActive("blockquote")) return "Write a quote…"
                if (editor.isActive("orderedList")) return "List item…"
                if (editor.isActive("bulletList")) return "List item…"
                if (editor.isActive("heading", { level: 1 })) return headingLabel(1)
                if (editor.isActive("heading", { level: 2 })) return headingLabel(2)
                if (editor.isActive("heading", { level: 3 })) return headingLabel(3)
                return "Type '/' for commands…"
            }
    }
}
}