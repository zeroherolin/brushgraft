<script lang="ts">
  import { onMount } from "svelte";
  import X from "@lucide/svelte/icons/x";
  import { app, brushStep, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, type Layout } from "./lib/app.svelte";
  import { dialogs } from "./lib/dialogs.svelte";
  import { arrowInGroup, forControl, typingIn } from "./lib/keys";
  import { t } from "./lib/i18n.svelte";
  import AssetLibrary from "./components/AssetLibrary.svelte";
  import Canvas from "./components/Canvas.svelte";
  import Composer from "./components/Composer.svelte";
  import DialogHost from "./components/DialogHost.svelte";
  import Drawer from "./components/Drawer.svelte";
  import JobPanel from "./components/JobPanel.svelte";
  import MobileSheet from "./components/MobileSheet.svelte";
  import Settings from "./components/Settings.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TopBar from "./components/TopBar.svelte";
  import Tree from "./components/Tree.svelte";

  let dragging = $state(false);
  let dragDepth = 0;
  /** the files being dragged are over the asset library, which takes them itself */
  let overLibrary = $state(false);

  onMount(() => {
    const wide = matchMedia("(min-width: 1180px)");
    const medium = matchMedia("(min-width: 760px)");
    const update = () => {
      const next: Layout = wide.matches ? "wide" : medium.matches ? "medium" : "narrow";
      if (next !== app.layout) {
        app.treeOpen = false;
        app.sheetOpen = false;
      }
      app.layout = next;
    };
    update();
    wide.addEventListener("change", update);
    medium.addEventListener("change", update);
    void app.init();
    return () => {
      wide.removeEventListener("change", update);
      medium.removeEventListener("change", update);
    };
  });

  $effect(() => {
    document.title = app.project ? `${app.project.name} - brushgraft` : "brushgraft";
  });

  // Keep unsent drafts across reloads: save whenever any of them changes
  $effect(() => {
    void $state.snapshot(app.drafts);
    app.saveDrafts();
  });

  function onKeydown(e: KeyboardEvent) {
    // a key a control already used (or a character being composed) is not a shortcut
    if (dialogs.current || app.settingsOpen || e.defaultPrevented || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    // a polygon or a drag in progress has the keys to itself (the canvas handles them)
    if (app.polygonOpen || app.gestureOpen) return;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      void app.submit();
      return;
    }
    if (e.key === "Escape" && (app.treeOpen || app.sheetOpen || app.queueOpen)) {
      app.treeOpen = app.sheetOpen = app.queueOpen = false;
      return;
    }
    if (app.sheetOpen) return; // the canvas and the tree are behind it
    if (arrowInGroup(e) || forControl(e)) return;
    const key = e.key.toLowerCase();
    // the regions are shown and can be changed (Compare hides them)
    const editing = app.mode === "edit" && !!app.selected && !(app.compare && app.parentNode) && !app.viewedJob;
    if (mod && editing && e.altKey && e.code === "KeyZ") {
      // Photoshop's step backward and forward: ⌥⌘Z, ⇧⌥⌘Z
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
      return;
    }
    if (mod && !e.altKey) {
      // As in Photoshop: ⌘Z undo, ⇧⌘Z or ⌘Y redo, ⌘A select all, ⌘D deselect
      // ⌘C copies the version's image, unless text is selected (a prompt in Version details)
      if (key === "c" && !e.shiftKey && app.selected && !window.getSelection()?.toString()) app.copyImage(app.selected);
      else if (key === "z" && editing) e.shiftKey ? app.redo() : app.undo();
      else if (key === "y" && editing) app.redo();
      else if (key === "a" && editing) app.selectAll();
      else if (key === "d" && editing) app.selectedRegion = -1;
      else return;
      e.preventDefault();
      return;
    }
    if (mod || e.altKey) return;
    if (editing && pickToolKey(key, e.shiftKey)) {
      e.preventDefault();
      return;
    }
    if (e.shiftKey && !e.key.startsWith("Arrow")) return;
    if (key === "c" && app.parentNode && !app.viewedJob) {
      app.compare = !app.compare;
    } else if (key === "[" || key === "]") {
      app.brushSize = brushStep(app.brushSize, key === "]" ? 1 : -1);
      app.persistPrefs();
    } else if ((e.key === "Delete" || e.key === "Backspace") && editing && app.selectedRegion >= 0) {
      app.removeRegion(app.selectedRegion);
    } else if (e.key === "Escape" && app.viewedJob) {
      app.closeJob();
    } else if (e.key === "Escape" && app.shownPart) {
      app.partView = null;
    } else if (e.key === "Escape") {
      app.selectedRegion = -1;
    } else if (e.key.startsWith("Arrow") && editing && app.selectedRegion >= 0) {
      // nudge the selected region, 1 px or 10 with Shift (image pixels), whatever the tool, as in Photoshop
      const step = e.shiftKey ? 10 : 1;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      app.nudge(...d[e.key]);
    } else if (e.key.startsWith("Arrow") && !e.shiftKey && app.viewedJob) {
      // a job's row sits under the version it was made from: up goes back there
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") app.closeJob();
    } else if (e.key.startsWith("Arrow") && !e.shiftKey) {
      navigate(e.key);
    } else {
      return;
    }
    e.preventDefault();
  }

  /**
   * Photoshop's tool keys: V move, M marquee, L lasso, B brush, E eraser; with Shift the key
   * cycles through its group (Shift+M rectangle/ellipse, Shift+L freehand/polygonal), and X
   * swaps brush and eraser.
   */
  function pickToolKey(key: string, shift: boolean): boolean {
    const set = (tool: typeof app.tool) => {
      if (tool === "rect" || tool === "ellipse") app.marquee = tool;
      if (tool === "lasso" || tool === "polygon") app.lassoKind = tool;
      if (tool === "brush" || tool === "eraser") app.brushKind = tool;
      app.tool = tool;
      app.persistPrefs();
      return true;
    };
    if (key === "v" && !shift) return set("select");
    if (key === "r" && !shift) return set("rect");
    if (key === "m") return set(shift && (app.tool === "rect" || app.tool === "ellipse") ? (app.tool === "rect" ? "ellipse" : "rect") : app.marquee);
    if (key === "l") return set(shift && (app.tool === "lasso" || app.tool === "polygon") ? (app.tool === "lasso" ? "polygon" : "lasso") : app.lassoKind);
    if (key === "b" && !shift) return set("brush");
    if (key === "e" && !shift) return set("eraser");
    if (key === "x" && !shift && (app.tool === "brush" || app.tool === "eraser")) return set(app.tool === "brush" ? "eraser" : "brush");
    return false;
  }

  /** ↑ parent, ↓ first child, ←/→ siblings */
  function navigate(key: string) {
    const node = app.selected;
    if (!node) {
      const roots = app.children[""];
      if (roots?.length) app.select(roots[0].id);
      return;
    }
    if (key === "ArrowUp" && node.parent_id) app.select(node.parent_id);
    if (key === "ArrowDown") {
      const kids = app.children[node.id];
      if (kids?.length) app.select(kids[0].id);
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const siblings = app.children[node.parent_id ?? ""] ?? [];
      const i = siblings.findIndex((n) => n.id === node.id) + (key === "ArrowRight" ? 1 : -1);
      if (siblings[i]) app.select(siblings[i].id);
    }
  }

  /** a dialog is open: images pasted or dropped aren't for the project behind it */
  const blocked = () => !!dialogs.current || app.settingsOpen;

  function onPaste(e: ClipboardEvent) {
    if (typingIn(e.target) || blocked()) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void app.upload(files);
    }
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

  // -- the version tree's width, by its right edge -----------------------------------
  let windowWidth = $state(window.innerWidth);
  const sideShown = $derived(Math.max(SIDE_MIN, Math.min(app.sideWidth, windowWidth - 760)));

  function sideResizeStart(e: PointerEvent) {
    const grip = e.currentTarget as HTMLElement;
    const start = e.clientX;
    const from = sideShown;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => app.setSideWidth(from + ev.clientX - start);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  function sideResizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === "ArrowRight") app.setSideWidth(sideShown + step);
    else if (e.key === "ArrowLeft") app.setSideWidth(sideShown - step);
    else return;
    e.preventDefault();
  }
</script>

<svelte:window
  bind:innerWidth={windowWidth}
  onkeydown={onKeydown}
  onpaste={onPaste}
  ondragenter={(e) => {
    if (!hasFiles(e) || blocked()) return;
    dragDepth++;
    dragging = true;
  }}
  ondragleave={() => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dragging = false;
  }}
  ondragover={(e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // dropped here, not opened by the browser
    if (blocked() && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    overLibrary = !!(e.target as Element | null)?.closest?.(".library");
  }}
  ondrop={(e) => {
    if (!hasFiles(e)) return;
    dragDepth = 0;
    dragging = false;
    if (e.defaultPrevented) return; // the asset library took it
    e.preventDefault();
    if (blocked()) return;
    void app.upload(e.dataTransfer?.files ?? []);
  }}
/>

{#if app.fatal}
  <main class="fatal">
    <p class="brand serif">brushgraft</p>
    <p>{app.fatal}</p>
  </main>
{:else if !app.config}
  <div class="loading" aria-busy="true">
    <span class="brand serif">brushgraft</span>
  </div>
{:else}
  <div class="shell" data-layout={app.layout}>
    <TopBar />
    {#if !app.online}
      <div class="offline" role="status">{t("app.offline")}</div>
    {/if}
    <div class="body" style:--side="{app.sideWidth}px">
      {#if app.layout === "wide"}
        <div class="side">
          <Tree />
          <AssetLibrary />
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            class="side-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("app.resizeSide")}
            aria-valuenow={sideShown}
            aria-valuemin={SIDE_MIN}
            aria-valuemax={Math.max(SIDE_MIN, Math.min(SIDE_MAX, windowWidth - 760))}
            tabindex="0"
            onpointerdown={sideResizeStart}
            onkeydown={sideResizeKey}
            ondblclick={() => app.setSideWidth(SIDE_DEFAULT)}
          ></div>
        </div>
      {/if}
      <Canvas />
      {#if app.layout !== "narrow"}
        {#if app.viewedJob}
          <JobPanel job={app.viewedJob} />
        {:else}
          <Composer />
        {/if}
      {/if}
    </div>
    {#if app.layout !== "narrow"}
      <StatusBar />
    {:else}
      <MobileSheet />
      {#if app.site}
        <footer class="legal">
          <a href={app.site.url} target="_blank" rel="noopener noreferrer">{app.site.icp}</a>
        </footer>
      {/if}
    {/if}
  </div>

  {#if app.layout !== "wide" && app.treeOpen}
    <Drawer label={t("top.versionTree")} onclose={() => (app.treeOpen = false)}>
      <Tree onclose={() => (app.treeOpen = false)} />
      <AssetLibrary />
    </Drawer>
  {/if}
  {#if app.settingsOpen}
    <Settings />
  {/if}
  <DialogHost />
  {#if dragging}
    <div class="dropzone" aria-hidden="true"><span>{overLibrary ? t("app.dropzoneAssets") : t("app.dropzone")}</span></div>
  {/if}
  <!-- always there, so screen readers announce what is put in it; an error interrupts -->
  <div class="announce" role="status" aria-live="polite">{app.toast && !app.toast.error ? app.toast.text : ""}</div>
  <div class="announce" role="alert">{app.toast?.error ? app.toast.text : ""}</div>
  {#if app.toast}
    <!-- kept while the pointer or the focus is on it -->
    <div
      class="toast"
      class:error={app.toast.error}
      class:raised={app.layout === "narrow"}
      role="presentation"
      onpointerenter={() => app.holdToast(true)}
      onpointerleave={() => app.holdToast(false)}
      onfocusin={() => app.holdToast(true)}
      onfocusout={() => app.holdToast(false)}
    >
      <span>{app.toast.text}</span>
      {#if app.toast.action}
        <button class="quiet small" onclick={() => app.toastAction()}>{app.toast.action.label}</button>
      {/if}
      <button class="quiet icon small dismiss" aria-label={t("common.dismiss")} title={t("common.dismiss")} onclick={() => app.dismissToast()}><X size={14} /></button>
    </div>
  {/if}
{/if}

<style>
  .announce {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    height: 100dvh;
  }

  .body {
    flex: 1;
    display: grid;
    /* the tree is as wide as it was dragged, leaving the canvas at least about 430px */
    grid-template-columns: min(var(--side, 276px), calc(100vw - 760px)) minmax(0, 1fr) 332px;
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
  }

  /* the version tree, and the asset library under it */
  .side {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* the column's right edge: drag (or arrow keys) to widen the tree; a double-click resets it */
  .side-grip {
    position: absolute;
    top: 0;
    bottom: 0;
    right: -4px;
    width: 8px;
    cursor: col-resize;
    touch-action: none; /* a drag on a touch screen resizes; it doesn't scroll */
    z-index: 3;
  }

  .side-grip:hover::after,
  .side-grip:focus-visible::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    background: var(--accent);
  }

  .side-grip:focus-visible {
    outline: none;
  }

  .side > :global(nav) {
    flex: 1;
    min-height: 120px;
  }

  [data-layout="medium"] .body {
    grid-template-columns: minmax(0, 1fr) 300px;
  }

  [data-layout="narrow"] .body {
    grid-template-columns: minmax(0, 1fr);
  }

  /* the filing number sits at the very bottom on phones; the bottom bar above it then needs no inset of its own */
  .legal {
    padding: 4px 10px calc(4px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--rule);
    background: var(--panel-2);
    text-align: center;
    font-size: var(--fs-xs);
  }

  .legal a {
    color: var(--ink-3);
    text-decoration: none;
  }

  .shell:has(.legal) :global(.peek) {
    padding-bottom: 8px;
  }

  .offline {
    padding: 5px 12px;
    background: color-mix(in srgb, var(--warn) 14%, var(--panel));
    border-bottom: 1px solid var(--rule);
    color: var(--ink);
    font-size: var(--fs-s);
  }

  .loading,
  .fatal {
    display: grid;
    place-content: center;
    height: 100%;
    padding: 0 16px;
    text-align: center;
    color: var(--ink-2);
  }

  .fatal p {
    max-width: 32em;
    margin: 4px auto;
  }

  .brand {
    font-size: 22px;
    color: var(--ink);
  }

  .loading .brand {
    opacity: 0.35;
  }

  .dropzone {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 16px;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    pointer-events: none;
    z-index: 50;
  }

  .dropzone span {
    padding: 28px 40px;
    border: 1.5px dashed var(--accent);
    border-radius: var(--r-m);
    background: var(--panel);
    color: var(--ink);
    font-size: var(--fs-l);
    box-shadow: var(--shadow-pop);
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 12px;
    position: fixed;
    left: 50%;
    bottom: 76px; /* above the status bar and caption */
    transform: translateX(-50%);
    max-width: min(560px, calc(100vw - 32px));
    padding: 8px 14px;
    border: 1px solid var(--rule-2);
    border-radius: var(--r-m);
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    z-index: 60;
  }

  .toast.error {
    border-color: color-mix(in srgb, var(--danger) 60%, var(--rule-2));
    color: var(--danger);
  }

  .toast button {
    flex: none;
    min-height: 24px;
    padding: 0 8px;
    color: var(--accent);
    font-weight: 600;
  }

  .toast .dismiss {
    margin-right: -8px;
    padding: 0 4px;
    color: var(--ink-2);
  }

  .toast.raised {
    bottom: calc(108px + env(safe-area-inset-bottom));
  }
</style>
