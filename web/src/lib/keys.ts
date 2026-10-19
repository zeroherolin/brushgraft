// Which key presses belong to the focused control rather than to the app's shortcuts.

const TEXT = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** Whether ``target`` takes typed text: a text field or area, a list box, an editable element. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && TEXT.has((el as HTMLInputElement).type);
}

const PRESSABLE = 'button, summary, a[href], [role="button"], [role="tab"], [role="radio"], [role="menuitem"]';

/** Whether ``el`` was reached with the keyboard (a click focuses a button too, without this) */
function keyboardFocused(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Whether the focused control should have this key: typing goes to a text field, the arrows and
 * Page Up/Down, Home, End to a slider, Space and Enter to a check box, and to a button reached with
 * Tab. Every other key is a shortcut, so after the brush slider is dragged ⌘Z, E or ] still work,
 * and after a click on a button Space still pans.
 */
export function forControl(e: KeyboardEvent): boolean {
  if (typingIn(e.target)) return true;
  const el = e.target as HTMLInputElement | null;
  if ((e.key === " " || e.key === "Enter") && el?.matches?.(PRESSABLE) && keyboardFocused(el)) return true;
  if (e.key.startsWith("Arrow") && el?.getAttribute?.("role") === "separator") return true; // a resize grip
  if (/^(Arrow|Home$|End$)/.test(e.key) && el?.closest?.(GROUPS)) return true; // see arrowInGroup
  if (el?.tagName !== "INPUT") return false;
  if (el.type === "range") return /^(Arrow|Page)|^(Home|End)$/.test(e.key);
  return (el.type === "checkbox" || el.type === "radio") && (e.key === " " || e.key === "Enter");
}

const GROUPS = '[role="radiogroup"], [role="tablist"], [role="toolbar"], [role="menu"]';
const ITEMS = 'button, [role="radio"], [role="tab"], [role="menuitem"]';

/**
 * The arrow keys, Home and End within a radio group, a tab list, a toolbar or a menu, as WAI-ARIA has
 * them: focus moves to the next item (wrapping), and in a radio group or a tab list the item is chosen
 * too. Returns whether the key was used.
 */
export function arrowInGroup(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  const group = el?.closest?.(GROUPS) as HTMLElement | null;
  if (!group || !el || !/^(Arrow|Home$|End$)/.test(e.key)) return false;
  const role = group.getAttribute("role");
  const vertical = role === "menu";
  if (vertical ? e.key === "ArrowLeft" || e.key === "ArrowRight" : e.key === "ArrowUp" || e.key === "ArrowDown") return false;
  const items = [...group.querySelectorAll<HTMLElement>(ITEMS)].filter((b) => !(b as HTMLButtonElement).disabled && b.offsetParent !== null);
  const at = items.indexOf(el.closest(ITEMS) as HTMLElement);
  if (!items.length) return false;
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  e.preventDefault();
  items[next].focus();
  if (role === "radiogroup" || role === "tablist") items[next].click();
  return true;
}
