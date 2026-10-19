<script lang="ts">
  // The canvas's context menu: what can be done with the version on screen, its view and the
  // selected region. A WAI-ARIA menu: the arrow keys, Home and End move through it, Esc and a click
  // outside close it, and the focus goes back where it was.
  import { app } from "../lib/app.svelte";
  import { backend } from "../lib/backend";
  import { canCopyImage } from "../lib/clipboard";
  import { t } from "../lib/i18n.svelte";
  import { modKey } from "../lib/platform";
  import { dismissible } from "../lib/popover";
  import type { TreeNode } from "../lib/types";

  let {
    node,
    x,
    y,
    editing,
    viewing,
    onfit,
    onactual,
    onclose,
  }: {
    node: TreeNode;
    /** where it opens, in the window */
    x: number;
    y: number;
    /** the regions on screen can be changed */
    editing: boolean;
    /** a job is on screen (its parent's image): only the image itself */
    viewing: boolean;
    onfit: () => void;
    onactual: () => void;
    onclose: () => void;
  } = $props();

  const apple = modKey === "⌘";
  const copyable = canCopyImage();
  const region = $derived(editing ? app.selectedRegion : -1);
  // a version is a reference of a new image; the one being edited is already the original
  const asRef = $derived(app.mode === "generate");
  const isRef = $derived(app.editable.refs.includes(node.id));
  const canCompare = $derived(!!app.parentNode && !viewing);

  let menu: HTMLElement;
  let left = $state(0);
  let top = $state(0);

  /** Run what an item does, then close; it starts first, as a clipboard write must start in the click. */
  function run(action: () => unknown) {
    void action();
    onclose();
  }

  // inside the window, flipped left or up when it would run off an edge
  const place = (el: HTMLElement) => {
    const { offsetWidth: w, offsetHeight: h } = el;
    left = x + w + 8 > innerWidth ? Math.max(8, x - w) : x;
    top = y + h + 8 > innerHeight ? Math.max(8, y - h) : y;
    const before = document.activeElement as HTMLElement | null;
    el.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      // the focus goes back, unless it has moved on elsewhere meanwhile (a click on a field)
      if (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement)) {
        before?.focus({ preventScroll: true });
      }
    };
  };

  const items = () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];

  function onkeydown(e: KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") {
      e.preventDefault();
      onclose();
    }
    if (next >= 0) {
      e.preventDefault();
      list[next].focus();
    }
    // the app's shortcuts (C compares, arrows move through the tree) wait until it has closed
    e.stopPropagation();
  }

  const key = (k: string) => (apple ? `⌘${k}` : `Ctrl+${k}`);
</script>

<svelte:window onresize={onclose} onblur={onclose} />

<div
  class="menu"
  role="menu"
  aria-label={t("menu.label")}
  tabindex="-1"
  bind:this={menu}
  style:left="{left}px"
  style:top="{top}px"
  {onkeydown}
  oncontextmenu={(e) => e.preventDefault()}
  {@attach place}
  {@attach dismissible(onclose)}
>
  <button
    role="menuitem"
    class="item"
    aria-disabled={!copyable}
    title={copyable ? t("menu.copyImageTitle") : t("canvas.copyUnavailable")}
    onclick={() => run(() => app.copyImage(node))}><span>{t("menu.copyImage")}</span><kbd>{key("C")}</kbd></button
  >
  {#if region >= 0}
    <button
      role="menuitem"
      class="item"
      aria-disabled={!copyable}
      title={copyable ? t("menu.copyRegionTitle") : t("canvas.copyUnavailable")}
      onclick={() => run(() => app.copyRegion(region))}><span>{t("menu.copyRegion")}</span></button
    >
  {/if}
  <button role="menuitem" class="item" onclick={() => run(() => backend.download(node.image, `brushgraft-${app.versions[node.id]}`))}>
    <span>{t("menu.download")}</span>
  </button>
  {#if !viewing}
    <hr />
    {#if asRef}
      <button role="menuitem" class="item" onclick={() => run(() => app.toggleRef(node.id))}>
        <span>{isRef ? t("assets.stopRef") : t("assets.useAsRef")}</span>
      </button>
    {/if}
    <button role="menuitem" class="item" onclick={() => run(() => app.saveAsAsset(node))}><span>{t("canvas.saveAsAsset")}</span></button>
    <button role="menuitem" class="item" onclick={() => run(() => app.toggleStar(node))}>
      <span>{node.starred ? t("tree.unstar") : t("tree.star")}</span>
    </button>
    <hr />
    <button
      role="menuitemcheckbox"
      class="item"
      aria-checked={app.compare && canCompare}
      disabled={!canCompare}
      onclick={() => run(() => (app.compare = !app.compare))}><span>{t("canvas.compareLabel")}</span><kbd>C</kbd></button
    >
  {/if}
  <button role="menuitem" class="item" onclick={() => run(onfit)}><span>{t("menu.fit")}</span><kbd>{key("0")}</kbd></button>
  <button role="menuitem" class="item" onclick={() => run(onactual)}><span>{t("menu.actualSize")}</span><kbd>{key("1")}</kbd></button>
  {#if editing}
    <hr />
    <button role="menuitem" class="item" onclick={() => run(() => app.selectAll())}><span>{t("menu.selectAll")}</span><kbd>{key("A")}</kbd></button>
    <button role="menuitem" class="item" disabled={region < 0} onclick={() => run(() => (app.selectedRegion = -1))}>
      <span>{t("menu.deselect")}</span><kbd>{key("D")}</kbd>
    </button>
    <button role="menuitem" class="item danger" disabled={region < 0} onclick={() => run(() => app.removeRegion(region))}>
      <span>{t("menu.deleteRegion")}</span><kbd>{apple ? "⌫" : "Delete"}</kbd>
    </button>
  {/if}
</div>

<style>
  .menu {
    position: fixed;
    min-width: 220px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    border: 1px solid var(--rule-2);
    border-radius: var(--r-m);
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    z-index: 45;
    outline: none;
  }

  /* a column on the left for the check mark of a checked item, as desktop menus have */
  .item {
    position: relative;
    display: flex;
    width: 100%;
    justify-content: space-between;
    gap: 24px;
    padding-left: 26px;
    border: 0;
    background: none;
    text-align: left;
  }

  .item[aria-checked="true"]::before {
    content: "✓";
    position: absolute;
    left: 9px;
  }

  .item:focus-visible {
    outline: none;
    background: var(--hover);
  }

  .item[aria-disabled="true"] {
    opacity: 0.45;
  }

  .item.danger:not(:disabled) {
    color: var(--danger);
  }

  kbd {
    font: inherit;
    font-size: var(--fs-s);
    color: var(--ink-3);
  }

  hr {
    margin: 4px 0;
    border: 0;
    border-top: 1px solid var(--rule);
  }
</style>
