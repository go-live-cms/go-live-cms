import { SuggestionPopupManager } from "./slashCommandManager"
import { MentionMenuList } from "../ui/MentionMenu"

// The @ menu's popup (#320): the slash menu's manager (Esc keeps the typed text, Tab
// closes) with the mention list.
export const mentionMenuManager = new SuggestionPopupManager(MentionMenuList, "slash-command-popup mention-menu-popup")
