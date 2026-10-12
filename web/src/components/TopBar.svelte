<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ListChecks from "@lucide/svelte/icons/list-checks";
  import PanelLeft from "@lucide/svelte/icons/panel-left";
  import Settings from "@lucide/svelte/icons/settings";
  import { app } from "../lib/app.svelte";
  import { t } from "../lib/i18n.svelte";
  import { dismissible } from "../lib/popover";
  import Queue from "./Queue.svelte";

  let menuOpen = $state(false);
  let picker: HTMLInputElement;
  const busy = $derived(app.activeJobs.length);

  function toggleMenu() {
    menuOpen = !menuOpen;
    // other projects' counts change too (another tab, an import): read them again
    if (menuOpen) app.refreshProjects().catch(() => {});
  }

  function run(action: () => Promise<void>) {
    menuOpen = false;
    void action();
  }
</script>

<header class:narrow={app.layout === "narrow"}>
  {#if app.layout !== "wide"}
    <button class="quiet icon" aria-label={t("top.versionTree")} aria-expanded={app.treeOpen} onclick={() => (app.treeOpen = !app.treeOpen)}>
      <PanelLeft size={17} />
    </button>
  {/if}
  <span class="brand serif">brushgraft</span>

  <div class="anchor project" {@attach menuOpen ? dismissible(() => (menuOpen = false)) : undefined}>
    <button class="quiet picker" aria-haspopup="menu" aria-expanded={menuOpen} onclick={toggleMenu}>
      <span class="name">{app.project?.name ?? t("top.project")}</span>
      <ChevronDown size={14} />
    </button>
    {#if menuOpen}
      <div class="menu" role="menu">
        <div class="group-label">{t("top.projects")}</div>
        {#each app.projects as p (p.id)}
          <button
            role="menuitemradio"
            aria-checked={p.id === app.projectId}
            class="item"
            onclick={() => run(() => app.openProject(p.id))}
          >
            <span class="check" aria-hidden="true">{p.id === app.projectId ? "✓" : ""}</span>
            <span class="label">{p.name}</span>
            <span class="count">{(p.id === app.projectId ? app.nodeCount : p.node_count) ?? ""}</span>
          </button>
        {/each}
        <hr />
        <button role="menuitem" class="item" onclick={() => run(() => app.newProject())}>
          <span class="check"></span>{t("top.newProject")}
        </button>
        <button role="menuitem" class="item" onclick={() => run(() => app.renameProject())}>
          <span class="check"></span>{t("top.renameProject")}
        </button>
        <hr />
        <button role="menuitem" class="item" onclick={() => run(() => app.exportProject())}>
          <span class="check"></span>{t("top.exportProject")}
        </button>
        <button role="menuitem" class="item" onclick={() => { menuOpen = false; picker.click(); }}>
          <span class="check"></span>{t("top.importProject")}
        </button>
        <hr />
        <button role="menuitem" class="item danger" onclick={() => run(() => app.deleteProject())}>
          <span class="check"></span>{t("top.deleteProject")}
        </button>
      </div>
    {/if}
  </div>

  <input
    bind:this={picker}
    type="file"
    accept=".zip,application/zip"
    multiple
    hidden
    onchange={(e) => {
      void app.importProjects(e.currentTarget.files ?? []);
      e.currentTarget.value = "";
    }}
  />

  <span class="spacer"></span>

  <div class="anchor" {@attach app.queueOpen ? dismissible(() => (app.queueOpen = false)) : undefined}>
    <button
      class="quiet tasks"
      class:icon={app.layout === "narrow" && !busy}
      aria-expanded={app.queueOpen}
      aria-label={t("top.tasks")}
      onclick={() => (app.queueOpen = !app.queueOpen)}
    >
      {#if busy}
        <span class="pulse" aria-hidden="true"></span>
        <span>{t("top.generating", { n: busy })}</span>
      {:else}
        <ListChecks size={16} />
        {#if app.layout !== "narrow"}<span>{t("top.tasks")}</span>{/if}
      {/if}
    </button>
    {#if app.queueOpen}
      <Queue />
    {/if}
  </div>
  <button class="quiet icon settings" aria-label={t("top.settings")} title={t("top.settings")} onclick={() => (app.settingsOpen = true)}>
    <Settings size={16} />
    {#if !app.config?.settings.api_key_set}<span class="dot" title={t("top.noKey")}></span>{/if}
  </button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    height: var(--bar-h);
    padding: 0 8px 0 12px;
    padding-top: env(safe-area-inset-top);
    box-sizing: content-box;
    border-bottom: 1px solid var(--rule);
    background: var(--panel);
    min-width: 0;
  }

  header.narrow {
    padding-left: 6px;
  }

  .brand {
    font-size: 16px;
    margin: 0 10px 0 2px;
    color: var(--ink);
  }

  .narrow .brand {
    display: none;
  }

  .anchor {
    position: relative;
    min-width: 0;
  }

  .project {
    flex: 0 1 auto;
  }

  .picker {
    max-width: 260px;
    font-weight: 600;
    color: var(--ink);
  }

  .picker .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .spacer {
    flex: 1;
  }

  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 240px;
    max-width: min(320px, calc(100vw - 16px));
    max-height: 70vh;
    overflow: auto;
    padding: 4px;
    border: 1px solid var(--rule-2);
    border-radius: var(--r-m);
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    z-index: 40;
  }

  .group-label {
    padding: 6px 10px 2px;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }

  .item {
    display: flex;
    width: 100%;
    justify-content: flex-start;
    gap: 8px;
    border: 0;
    background: none;
    text-align: left;
  }

  .item .check {
    width: 12px;
    color: var(--accent);
  }

  .item .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item .count {
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .item.danger {
    color: var(--danger);
  }

  hr {
    margin: 4px 0;
    border: 0;
    border-top: 1px solid var(--rule);
  }

  .tasks .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .settings {
    position: relative;
  }

  .dot {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
</style>
