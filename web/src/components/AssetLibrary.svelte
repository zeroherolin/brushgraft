<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import ImagePlus from "@lucide/svelte/icons/image-plus";
  import Search from "@lucide/svelte/icons/search";
  import { backend } from "../lib/backend";
  import { app } from "../lib/app.svelte";
  import { t } from "../lib/i18n.svelte";
  import { thumb } from "../lib/media";
  import { dismissible } from "../lib/popover";
  import { ASSET_REF, type Asset } from "../lib/types";

  // The asset library under the version tree: images every project can use as references, or
  // start from. Clicking an asset uses it as a reference in the edit being prepared, as "Ref"
  // does on a version; the rest is in its menu.

  let filePicker: HTMLInputElement;
  let packPicker: HTMLInputElement;
  let panel: HTMLElement;
  let query = $state("");
  let searching = $state(false);
  let dropping = $state(false);
  /** an open menu: the library's own, or one asset's, at a point on the screen */
  let menu = $state<{ asset: Asset | null; x: number; y: number } | null>(null);

  const refs = $derived(app.draft.refs);
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? app.assets.filter((a) => a.name.toLowerCase().includes(q)) : app.assets;
  });

  function openMenu(asset: Asset | null, e: MouseEvent) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // below the button, or above it when that would run off the bottom of the window
    const tall = asset ? 260 : 90;
    const y = box.bottom + 4 + tall > window.innerHeight ? Math.max(8, box.top - 4 - tall) : box.bottom + 4;
    menu = menu && menu.asset?.id === asset?.id ? null : { asset, x: box.right, y };
  }

  function run(action: () => Promise<void> | void) {
    // start it first: it reads the asset of the menu, which closing it clears
    const started = action();
    menu = null;
    void started;
  }

  // -- the panel's height, by its top edge ---------------------------------------
  const MIN = 120;
  function resizeStart(e: PointerEvent) {
    const parent = panel.parentElement!;
    const start = e.clientY;
    const from = panel.getBoundingClientRect().height;
    const max = Math.max(MIN, parent.getBoundingClientRect().height - 160);
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => app.setLibrary(true, Math.round(Math.min(max, Math.max(MIN, from + start - ev.clientY))));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  function resizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 60 : 20;
    if (e.key === "ArrowUp") app.setLibrary(true, app.libraryHeight + step);
    else if (e.key === "ArrowDown") app.setLibrary(true, Math.max(MIN, app.libraryHeight - step));
    else return;
    e.preventDefault();
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
</script>

<section
  class="library"
  class:open={app.libraryOpen}
  class:dropping
  style:height={app.libraryOpen ? `${app.libraryHeight}px` : undefined}
  aria-label={t("assets.title")}
  bind:this={panel}
  ondragover={(e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropping = true;
  }}
  ondragleave={(e) => {
    if (!panel.contains(e.relatedTarget as Node)) dropping = false;
  }}
  ondrop={(e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // the page's own drop handler leaves it alone (it would make versions)
    dropping = false;
    void app.addAssets(e.dataTransfer?.files ?? []);
  }}
>
  {#if app.libraryOpen}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("assets.resize")}
      aria-valuenow={app.libraryHeight}
      tabindex="0"
      onpointerdown={resizeStart}
      onkeydown={resizeKey}
    ></div>
  {/if}
  <div class="head">
    <button class="toggle" aria-expanded={app.libraryOpen} onclick={() => app.setLibrary(!app.libraryOpen)}>
      {#if app.libraryOpen}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
      <h2>{t("assets.title")}</h2>
      <span class="count">{app.assets.length || ""}</span>
    </button>
    <span class="spacer"></span>
    {#if app.libraryOpen && app.assets.length > 6}
      <button
        class="quiet icon"
        aria-pressed={searching}
        title={t("assets.search")}
        aria-label={t("assets.search")}
        onclick={() => {
          searching = !searching;
          if (!searching) query = "";
        }}><Search size={15} /></button
      >
    {/if}
    <button class="quiet" title={t("assets.addTitle")} onclick={() => filePicker.click()}>
      <ImagePlus size={15} />{t("assets.add")}
    </button>
    <button
      class="quiet icon"
      aria-haspopup="menu"
      aria-expanded={!!menu && !menu.asset}
      title={t("assets.more")}
      aria-label={t("assets.more")}
      onclick={(e) => openMenu(null, e)}><Ellipsis size={15} /></button
    >
    <input
      bind:this={filePicker}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      hidden
      onchange={(e) => {
        void app.addAssets(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
      }}
    />
    <input
      bind:this={packPicker}
      type="file"
      accept=".zip,application/zip"
      hidden
      onchange={(e) => {
        const file = e.currentTarget.files?.[0];
        if (file) void app.importAssets(file);
        e.currentTarget.value = "";
      }}
    />
  </div>

  {#if app.libraryOpen}
    {#if searching}
      <div class="search">
        <!-- svelte-ignore a11y_autofocus -->
        <input type="search" bind:value={query} placeholder={t("assets.searchPlaceholder")} aria-label={t("assets.search")} autofocus />
      </div>
    {/if}
    <div class="scroll">
      {#if !app.assets.length}
        <div class="empty">
          <p>{t("assets.empty1")}</p>
          <p class="hint">{t("assets.empty2")}</p>
        </div>
      {:else if !shown.length}
        <p class="empty hint">{t("assets.noMatch")}</p>
      {:else}
        <ul class="grid">
          {#each shown as asset (asset.id)}
            {@const k = refs.indexOf(ASSET_REF + asset.id)}
            <li class:ref={k >= 0}>
              <button
                class="thumb"
                aria-pressed={k >= 0}
                title="{asset.name} ({asset.width} × {asset.height})&#10;{k >= 0 ? t('assets.stopRef') : t('assets.useAsRef')}"
                aria-label="{asset.name}: {k >= 0 ? t('assets.stopRef') : t('assets.useAsRef')}"
                onclick={() => app.toggleRef(ASSET_REF + asset.id)}
              >
                <img {@attach thumb(asset.image)} alt="" loading="lazy" decoding="async" />
                {#if k >= 0}<span class="badge" title={t("composer.refName", { k: k + 1 })}>{t("tree.ref")} {k + 1}</span>{/if}
              </button>
              <span class="name" title={asset.name}>{asset.name}</span>
              <button
                class="more"
                aria-haspopup="menu"
                aria-expanded={menu?.asset?.id === asset.id}
                aria-label={t("assets.actions", { name: asset.name })}
                onclick={(e) => openMenu(asset, e)}><Ellipsis size={14} /></button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if menu}
    <div
      class="menu"
      role="menu"
      style:left="{Math.max(8, menu.x - 220)}px"
      style:top="{menu.y}px"
      {@attach dismissible(() => (menu = null))}
    >
      {#if menu.asset}
        {@const asset = menu.asset}
        {@const isRef = refs.includes(ASSET_REF + asset.id)}
        <button role="menuitem" class="item" onclick={() => run(() => app.toggleRef(ASSET_REF + asset.id))}>
          {isRef ? t("assets.stopRef") : t("assets.useAsRef")}
        </button>
        <button role="menuitem" class="item" onclick={() => run(() => app.addAssetToProject(asset))}>{t("assets.addToProject")}</button>
        <button role="menuitem" class="item" onclick={() => run(() => app.newProjectFromAsset(asset))}>{t("assets.newProject")}</button>
        <hr />
        <button role="menuitem" class="item" onclick={() => run(() => app.renameAsset(asset))}>{t("assets.rename")}</button>
        <button role="menuitem" class="item" onclick={() => run(() => backend.download(asset.image, asset.name))}>{t("assets.download")}</button>
        <hr />
        <button role="menuitem" class="item danger" onclick={() => run(() => app.deleteAsset(asset))}>{t("assets.delete")}</button>
      {:else}
        <button role="menuitem" class="item" disabled={!app.assets.length} onclick={() => run(() => app.exportAssets())}>{t("assets.export")}</button>
        <button role="menuitem" class="item" onclick={() => run(() => packPicker.click())}>{t("assets.import")}</button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .library {
    position: relative;
    display: flex;
    flex: none;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--rule);
    border-right: 1px solid var(--rule);
    background: var(--panel);
  }

  .library.dropping {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  /* the top edge drags to resize the panel */
  .grip {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 8px;
    cursor: row-resize;
    z-index: 2;
  }

  .grip:hover,
  .grip:focus-visible {
    background: linear-gradient(transparent 3px, var(--accent) 3px 5px, transparent 5px);
    outline: none;
  }

  .head {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    height: 40px;
    padding: 0 6px 0 6px;
  }

  .open .head {
    border-bottom: 1px solid var(--rule);
  }

  .toggle {
    gap: 4px;
    min-width: 0;
    padding: 2px 6px;
    border: 0;
    background: none;
    color: var(--ink-2);
  }

  h2 {
    margin: 0;
    color: var(--ink);
    font-size: var(--fs-m);
    font-weight: 600;
  }

  .count {
    margin-left: 2px;
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .spacer {
    flex: 1;
  }

  .search {
    flex: none;
    padding: 6px 8px 0;
  }

  .search input {
    width: 100%;
    box-sizing: border-box;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }

  .empty {
    margin: 0;
    padding: 0 4px;
    color: var(--ink-2);
  }

  .empty p {
    margin: 0 0 6px;
  }

  .hint {
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
    gap: 8px 6px;
  }

  .grid li {
    position: relative;
    min-width: 0;
  }

  .thumb {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: 4px;
    background: var(--well);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent);
  }

  .thumb:hover {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent);
  }

  .ref .thumb {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .badge {
    position: absolute;
    left: 0;
    bottom: 0;
    padding: 0 5px;
    border-top-right-radius: 4px;
    background: var(--accent);
    color: #fff;
    font-size: 10px;
    line-height: 16px;
  }

  .name {
    display: block;
    margin-top: 3px;
    overflow: hidden;
    color: var(--ink-2);
    font-size: var(--fs-xs);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* an asset's menu: on its corner, shown on hover (always on touch screens) */
  .more {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 22px;
    min-height: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: rgb(20 23 27 / 0.62);
    color: #fff;
    opacity: 0;
  }

  .grid li:hover .more,
  .more:focus-visible,
  .more[aria-expanded="true"] {
    opacity: 1;
  }

  @media (pointer: coarse) {
    .more {
      opacity: 1;
    }
  }

  .menu {
    position: fixed;
    width: 220px;
    padding: 4px;
    border: 1px solid var(--rule-2);
    border-radius: var(--r-m);
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    z-index: 45;
  }

  .item {
    display: flex;
    width: 100%;
    justify-content: flex-start;
    border: 0;
    background: none;
    text-align: left;
  }

  .item.danger {
    color: var(--danger);
  }

  hr {
    margin: 4px 0;
    border: 0;
    border-top: 1px solid var(--rule);
  }
</style>
