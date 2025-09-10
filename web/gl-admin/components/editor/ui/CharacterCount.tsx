import type { Editor as TiptapEditor } from "@tiptap/core"

export default function CharacterCount({ editor, maxChars, minChars }: { editor: TiptapEditor, maxChars?: number, minChars?: number }) {

    return (
        <div className="editor-meta">
            <span className="char-count">{editor.storage.characterCount.characters()} characters</span>
            {typeof minChars === "number" && (
                <span className="char-limit">
                    min {minChars}
                    {editor.storage.characterCount.characters() < minChars ? " • too short" : ""}
                </span>
            )}
            {typeof maxChars === "number" && (
                <span className="char-limit">
                    max {maxChars}
                    {editor.storage.characterCount.characters() > maxChars ? " • too long" : ""}
                </span>
            )}
        </div>
    )


}