export const normalizeUrl = (input: string) => {
    if (!input) return '';
    try {
        const hasProtocol = /^https?:\/\//i.test(input) || /^mailto:/i.test(input);
        return hasProtocol ? input : `https://${input}`;
    } catch {
        return input;
    }
}

export const applyLink = (editor, url, setIsLinkModalOpen) => {
    if (!editor) return;
    const href = normalizeUrl(url.trim());

    if (!href) {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setIsLinkModalOpen(false);
}

export const openLinkModal = (editor, setUrl, setIsLinkOpen) => {
    if (!editor) return;
    const current = editor.getAttributes('link')?.href ?? '';
    setUrl(current);
    setIsLinkOpen(true);
}