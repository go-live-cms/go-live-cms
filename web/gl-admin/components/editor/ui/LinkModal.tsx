import Input from "@gl-admin/components/ui/Input";

export default function LinkModal({ setIsLinkModalOpen, applyLink, url, setUrl }: { editor: any; setIsLinkModalOpen: (isOpen: boolean) => void; applyLink: () => void; url: string; setUrl: (url: string) => void }) {
    return (
        <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/50"
            onClick={() => setIsLinkModalOpen(false)}
        >
            <div
                className="w-full max-w-md text-white rounded-xl bg-gray-800/80 border border-gray-700 backdrop-blur-xs p-4 shadow"
                onClick={(e) => e.stopPropagation()}
            >
                <h3 className="mb-3 text-lg font-semibold">Insert link</h3>
                <Input
                    title="URL"
                    type="url"
                    autoFocus
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') applyLink();
                        if (e.key === 'Escape') setIsLinkModalOpen(false);
                    }}
                />
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        className="px-3 py-1 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700/50 cursor-pointer"
                        onClick={() => setIsLinkModalOpen(false)}
                    >
                        Cancel
                    </button>
                    <button
                        className="px-3 py-1 rounded border border-gray-700 bg-gray-800 hover:bg-gray-700/50 cursor-pointer"
                        onClick={applyLink}
                    >
                        Apply
                    </button>
                </div>
                <p className="mt-2 text-xs text-gray-500">
                    Tip: Select text then press ⌘/Ctrl+K to open this modal.
                </p>
            </div>
        </div>
    )
}