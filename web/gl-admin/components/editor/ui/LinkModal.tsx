import Input from "@gl-admin/components/ui/Input"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"

// Add or change a link on the selection (Ctrl/⌘ K).
export default function LinkModal({ setIsLinkModalOpen, applyLink, url, setUrl }: { editor: any; setIsLinkModalOpen: (isOpen: boolean) => void; applyLink: () => void; url: string; setUrl: (url: string) => void }) {
    const close = () => setIsLinkModalOpen(false)
    return (
        <Modal
            isOpen
            onClose={close}
            size="small"
            title="Link"
            description="Select text, then press Ctrl or ⌘ K to open this."
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        Cancel
                    </Button>
                    <Button variant="primary" onClick={applyLink}>
                        Apply
                    </Button>
                </>
            }
        >
            <Input
                title="URL"
                type="url"
                autoFocus
                value={url}
                placeholder="https://"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") applyLink()
                }}
            />
        </Modal>
    )
}
