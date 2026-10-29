import type { Editor as TiptapEditor } from "@tiptap/core"

export default function CharacterCount({ editor, maxChars, minChars }: { editor: TiptapEditor, maxChars?: number, minChars?: number }) {
    const count = editor.storage.characterCount.characters()

    return (
        <div className="editor-meta">
            <span className="char-count">{count} characters</span>
            {typeof minChars === "number" && (
                <span className={`char-limit${count < minChars ? " is-out-of-range" : ""}`}>
                    min {minChars}
                    {count < minChars ? " · too short" : ""}
                </span>
            )}
            {typeof maxChars === "number" && (
                <span className={`char-limit${count > maxChars ? " is-out-of-range" : ""}`}>
                    max {maxChars}
                    {count > maxChars ? " · too long" : ""}
                </span>
            )}
        </div>
    )


}
