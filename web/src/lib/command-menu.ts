/*
 * The Cmd K menu's trigger, apart from the menu itself, so a page's search
 * button can open it without pulling cmdk into that page's chunk.
 */
export const OPEN_COMMAND_MENU = "unwind:command-menu";
export const openCommandMenu = () => window.dispatchEvent(new Event(OPEN_COMMAND_MENU));
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
