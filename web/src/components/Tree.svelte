<script lang="ts">
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import ImageUp from "@lucide/svelte/icons/image-up";
  import Star from "@lucide/svelte/icons/star";
  import X from "@lucide/svelte/icons/x";
  import { onDestroy } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { app } from "../lib/app.svelte";
  import { shortVersion } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import TreeBranch from "./TreeBranch.svelte";

  /** passed when shown in a drawer: adds a close button to the header */
  let { onclose }: { onclose?: () => void } = $props();

  let fileInput: HTMLInputElement;
  let starredOnly = $state(false);
  const collapsed = new SvelteSet<string>();

  let now = $state(Date.now() / 1000);
  const timer = setInterval(() => (now = Date.now() / 1000), 1000);
  onDestroy(() => clearInterval(timer));

  const empty = $derived(!app.children[""]?.length && !app.pendingJobs[""]?.length);
  const starred = $derived(Object.values(app.nodes).filter((n) => n.starred).sort((a, b) => a.created_at - b.created_at));
  // with the last star gone (or in another project) the whole tree shows again, and the toggle with it
  const onlyStarred = $derived(starredOnly && starred.length > 0);
  $effect(() => {
    void app.projectId;
    starredOnly = false;
  });
  $effect(() => {
    if (!starred.length) starredOnly = false;
  });

  // Branches with children, to fold them all at once on a big tree. The way to the
  // selected version always stays open, so it doesn't count either way.
  const branches = $derived(Object.values(app.nodes).filter((n) => app.children[n.id]?.length));
  const canFold = $derived(branches.some((n) => !collapsed.has(n.id) && !app.lineageIds.has(n.id)));
  const canUnfold = $derived(branches.some((n) => collapsed.has(n.id)));

  function toggleAll() {
    if (!canFold) {
      collapsed.clear();
      return;
    }
    for (const n of branches) if (!app.lineageIds.has(n.id)) collapsed.add(n.id);
  }

  // Expand ancestors that hide the selected version, and scroll it into view; for a job on screen,
  // the version it was made from opens too, to show the job's row under it
  $effect(() => {
    const id = app.selectedId;
    const job = app.jobId;
    if (!id && !job) return;
    for (const node of job ? app.lineage : app.lineage.slice(0, -1)) collapsed.delete(node.id);
    requestAnimationFrame(() => {
      const row = job ? `[data-job="${job}"]` : `[data-node="${id}"]`;
      document.querySelector(row)?.scrollIntoView({ block: "nearest" });
    });
  });
</script>

<nav class="tree" aria-label={t("top.versionTree")}>
  <div class="head">
    <h2>{t("tree.title")}</h2>
    <span class="count">{app.nodeCount || ""}</span>
    <span class="spacer"></span>
    {#if branches.length > 3 && !onlyStarred && (canFold || canUnfold)}
      <button
        class="quiet icon"
        title={canFold ? t("tree.collapseAll") : t("tree.expandAll")}
        aria-label={canFold ? t("tree.collapseAll") : t("tree.expandAll")}
        onclick={toggleAll}
      >
        {#if canFold}<ChevronsDownUp size={15} />{:else}<ChevronsUpDown size={15} />{/if}
      </button>
    {/if}
    {#if starred.length}
      <button
        class="quiet icon"
        aria-pressed={onlyStarred}
        title={onlyStarred ? t("tree.showAll") : t("tree.starredOnly")}
        aria-label={t("tree.starredOnly")}
        onclick={() => (starredOnly = !onlyStarred)}><Star size={15} /></button
      >
    {/if}
    <button class="quiet" onclick={() => fileInput.click()} title={t("tree.importTitle")}>
      <ImageUp size={15} />{t("tree.import")}
    </button>
    {#if onclose}
      <button class="quiet icon" aria-label={t("tree.close")} onclick={onclose}><X size={16} /></button>
    {/if}
    <input
      bind:this={fileInput}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      hidden
      onchange={(e) => {
        void app.upload(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
      }}
    />
  </div>
  <div class="scroll">
    {#if empty}
      <div class="empty">
        <p>{t("tree.empty1")}</p>
        <p>{t("tree.empty2")}</p>
        <button onclick={() => fileInput.click()}><ImageUp size={15} />{t("tree.importImages")}</button>
      </div>
    {:else if onlyStarred}
      <ul class="flat">
        {#each starred as node (node.id)}
          <li>
            <button class="flat-row" class:selected={app.selectedId === node.id} onclick={() => app.select(node.id)}>
              <span class="ver serif" title={app.versions[node.id]}>{shortVersion(app.versions[node.id])}</span>
              <span class="title">{app.caption(node)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <TreeBranch parentKey="" {collapsed} {now} />
    {/if}
  </div>
</nav>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--rule);
    background: var(--panel);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 40px;
    padding: 0 6px 0 14px;
    border-bottom: 1px solid var(--rule);
  }

  h2 {
    margin: 0;
    font-size: var(--fs-m);
    font-weight: 600;
  }

  .count {
    margin-left: 6px;
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .spacer {
    flex: 1;
  }

  .scroll {
    flex: 1;
    overflow: auto;
    padding: 6px 6px 32px;
  }

  .empty {
    padding: 8px 8px 0;
    color: var(--ink-2);
  }

  .empty p {
    margin: 0 0 8px;
  }

  .flat {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .flat-row {
    width: 100%;
    justify-content: flex-start;
    gap: 10px;
    border: 0;
    background: none;
    text-align: left;
  }

  .flat-row.selected {
    background: var(--accent-soft);
  }

  .flat-row .title {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ver {
    color: var(--ink-2);
  }
</style>
