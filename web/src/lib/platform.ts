// Shortcut labels that match the user's keyboard: ⌘ and ⌥ on Apple devices, Ctrl and Alt elsewhere.
// Key handling accepts both (metaKey || ctrlKey); only the labels differ.

const apple = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export const modKey = apple ? "⌘" : "Ctrl+";
export const altKey = apple ? "⌥" : "Alt";
export const undoKey = apple ? "⌘Z" : "Ctrl+Z";
export const redoKey = apple ? "⇧⌘Z" : "Ctrl+Shift+Z";
export const submitKey = apple ? "⌘⏎" : "Ctrl+Enter";
