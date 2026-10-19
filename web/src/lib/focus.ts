// Focus for a panel that covers the page (a drawer, the phone's sheet), as a modal dialog has it:
// focus moves into it, Tab stays in it, and it goes back where it was when the panel closes.

import type { Attachment } from "svelte/attachments";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);

/** ``fallback``: where focus goes on close when what had it is gone (the button that opened it, say) */
export function modal(fallback?: () => HTMLElement | null | undefined): Attachment<HTMLElement> {
  return (root) => {
    const before = document.activeElement as HTMLElement | null;
    if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
    requestAnimationFrame(() => {
      if (!root.contains(document.activeElement)) (focusables(root)[0] ?? root).focus({ preventScroll: true });
    });
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables(root);
      if (!list.length) return;
      const [first, last] = [list[0], list[list.length - 1]];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKeydown);
    return () => {
      root.removeEventListener("keydown", onKeydown);
      // after the panel is gone (and what replaces it is in place)
      requestAnimationFrame(() => {
        const to = before && document.contains(before) ? before : fallback?.();
        if (to && (!document.activeElement || document.activeElement === document.body)) to.focus({ preventScroll: true });
      });
    };
  };
}
