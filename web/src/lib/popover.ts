/** Svelte attachment: call onclose on a click outside the element or on Esc. */
export function dismissible(onclose: (e: Event) => void) {
  return (node: HTMLElement) => {
    const onPointer = (e: PointerEvent) => {
      if (!node.contains(e.target as Node)) onclose(e);
    };
    // an open popover takes Esc for itself: it doesn't also deselect or close what's behind it
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onclose(e);
    };
    // Wait a tick so the click that opened the popover doesn't close it (Esc works at once)
    window.addEventListener("keydown", onKey, true);
    const timer = setTimeout(() => window.addEventListener("pointerdown", onPointer, true));
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  };
}
