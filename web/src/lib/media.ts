// Images on the page. The backend gives each image a URL asynchronously (the
// browser backend reads it from IndexedDB first), so elements get theirs through
// an attachment: <img {@attach thumb(sha)}>. Scoped styles keep working, and the
// URL follows the sha when it changes.

import type { Attachment } from "svelte/attachments";
import { backend } from "./backend";
import { t } from "./i18n.svelte";

function attach(get: (sha: string) => Promise<string>, sha: string | null | undefined): Attachment<HTMLImageElement> {
  return (img) => {
    if (!sha) {
      img.removeAttribute("src");
      return;
    }
    let live = true;
    get(sha).then(
      (url) => live && (img.src = url),
      () => {},
    );
    return () => {
      live = false;
    };
  };
}

/** a version's thumbnail as an <img>'s source */
export const thumb = (sha: string | null | undefined) => attach(backend.thumbSrc, sha);

/** load an image fully (for the canvas) */
export async function loadImage(sha: string, small = false): Promise<HTMLImageElement> {
  const src = await (small ? backend.thumbSrc(sha) : backend.imageSrc(sha));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("canvas.loadFailed")));
    img.src = src;
  });
}

/** open an image in a new tab; call from a click (popup blockers allow only that) */
export function openImage(sha: string): void {
  const tab = window.open("", "_blank");
  backend.imageSrc(sha).then(
    (url) => tab && (tab.location.href = url),
    () => tab?.close(),
  );
}
