import { Extension } from '@tiptap/core';
import { KEYS } from '../utils/shortcuts';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    openLinkModal: {
      openLinkModal: () => ReturnType
    }
  }
}

export const OpenLinkModal = Extension.create<{
  onOpen?: (initialHref: string) => void
}>({
  name: 'openLinkModal',

  addOptions() {
    return {
      onOpen: () => {},
    };
  },

  addCommands() {
    return {
      openLinkModal: () => ({ editor }) => {
        const href = editor.getAttributes('link')?.href ?? '';
        this.options.onOpen?.(href);
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      [KEYS.link]: () => {
        const href = this.editor.getAttributes('link')?.href ?? '';
        this.options.onOpen?.(href);
        return true;
      },
    };
  },
});