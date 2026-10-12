<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Star from "@lucide/svelte/icons/star";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import type { SvelteSet } from "svelte/reactivity";
  import { thumb } from "../lib/media";
  import { app, describeJob } from "../lib/app.svelte";
  import { t } from "../lib/i18n.svelte";
  import { elapsed, shortModel, shortVersion } from "../lib/format";
  import type { TreeNode } from "../lib/types";
  import TreeBranch from "./TreeBranch.svelte";

  /** Past this many levels rows stop moving right: the version number already says how deep a
   *  version is, and an ever-narrower row would hide it */
  const MAX_INDENT = 4;

  let {
    parentKey,
    collapsed,
    now,
    depth = 0,
  }: { parentKey: string; collapsed: SvelteSet<string>; now: number; depth?: number } = $props();

  const nodes = $derived(app.children[parentKey] ?? []);
  const pending = $derived(app.pendingJobs[parentKey] ?? []);

  /** "Variant k" for every image of a job but the first; counts actual images,
   *  since the API occasionally returns more than one per request */
  function variant(node: TreeNode): number {
    if (!node.job_id) return 0;
    const siblings = nodes.filter((n) => n.job_id === node.job_id);
    return siblings.length < 2 ? 0 : siblings.indexOf(node) + 1;
  }

  function descendants(id: string): number {
    let count = 0;
    for (const child of app.children[id] ?? []) count += 1 + descendants(child.id);
    return count;
  }
</script>

<ul>
  {#each nodes as node (node.id)}
    {@const kids = (app.children[node.id]?.length ?? 0) + (app.pendingJobs[node.id]?.length ?? 0)}
    {@const v = variant(node)}
    {@const job = node.job_id ? app.jobs[node.job_id] : null}
    {@const isRef = app.draft.refs.includes(node.id)}
    {@const open = kids > 0 && !collapsed.has(node.id)}
    <li>
      <div
        class="row"
        data-node={node.id}
        class:selected={app.selectedId === node.id}
        class:on-path={app.lineageIds.has(node.id)}
      >
        {#if kids}
          <button
            class="twisty"
            aria-expanded={open}
            aria-label={t(open ? "tree.collapse" : "tree.expand", { v: app.versions[node.id] })}
            onclick={() => (open ? collapsed.add(node.id) : collapsed.delete(node.id))}
          >
            {#if open}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
          </button>
        {:else}
          <span class="twisty" aria-hidden="true"></span>
        {/if}
        <button class="select" aria-current={app.selectedId === node.id} onclick={() => app.select(node.id)}>
          <img class="thumb" {@attach thumb(node.image)} alt="" loading="lazy" decoding="async" width="40" height="40" />
          <span class="text">
            <span class="line1">
              <span class="ver serif" title={app.versions[node.id]}>{shortVersion(app.versions[node.id])}</span>
              <span class="title" class:muted={v > 1}>{v > 1 ? t("tree.variant", { k: v }) : app.caption(node)}</span>
            </span>
            <span class="meta">
              <span class="model">{job ? shortModel(job.model) : t("tree.imported", { w: node.width, h: node.height })}</span>
              {#if node.starred}<span class="mark star" title={t("tree.unstar")}><Star size={11} fill="currentColor" /></span>{/if}
              {#if isRef}<span class="mark ref">{t("tree.ref")}</span>{/if}
              {#if kids && !open}<span class="folded">{t("tree.folded", { n: descendants(node.id) || kids })}</span>{/if}
            </span>
          </span>
        </button>
        <span class="actions">
          <button
            class="ref"
            class:on={isRef}
            aria-pressed={isRef}
            title={isRef ? t("tree.stopRef") : t("tree.useAsRef")}
            onclick={() => app.toggleRef(node.id)}>{t("tree.ref")}</button
          >
          <button
            class="star"
            class:on={node.starred}
            aria-pressed={node.starred}
            aria-label={node.starred ? t("tree.unstar") : t("tree.star")}
            title={node.starred ? t("tree.unstar") : t("tree.star")}
            onclick={() => app.toggleStar(node)}><Star size={13} fill={node.starred ? "currentColor" : "none"} /></button
          >
          <button
            class="trash"
            aria-label={t("tree.delete")}
            title={t("tree.delete")}
            onclick={() => app.deleteNode(node)}><Trash2 size={13} /></button
          >
        </span>
      </div>
      {#if open}
        <div class="children" class:flat={depth + 1 >= MAX_INDENT} class:on-path={app.lineageIds.has(node.id)}>
          <TreeBranch parentKey={node.id} {collapsed} {now} depth={depth + 1} />
        </div>
      {/if}
    </li>
  {/each}

  {#each pending as job (job.id)}
    {@const failed = job.status === "failed"}
    <li class="pending" class:failed>
      <span class="twisty" aria-hidden="true"></span>
      <span class="thumb placeholder" aria-hidden="true">
        {#if !failed}<span class="spinner"></span>{/if}
      </span>
      <span class="text">
        <span class="title">{describeJob(job)}</span>
        {#if failed}
          <span class="meta error" title={app.jobError(job)}>{app.jobError(job)}</span>
          <span class="inline-actions">
            <button class="quiet" onclick={() => app.reuseJob(job)}>{t("tree.retry")}</button>
            <button class="quiet" onclick={() => app.dismissJob(job)}>{t("tree.dismiss")}</button>
          </span>
        {:else}
          <span class="meta">
            {t("tree.pendingMeta", {
              status: t(`status.${job.status}`),
              time: elapsed(now - job.created_at),
              model: shortModel(job.model),
              done: job.done,
              n: job.n,
            })}
          </span>
        {/if}
      </span>
    </li>
  {/each}
</ul>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .children {
    position: relative;
    margin-left: 8px;
    padding-left: 4px;
  }

  /* deep levels share one indent, and the guide line would only repeat */
  .children.flat {
    margin-left: 0;
    padding-left: 0;
  }

  .children.flat::before {
    display: none;
  }

  /* branch lines: hairlines, darker along the selected path */
  .children::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 10px;
    border-left: 1px solid var(--rule-2);
  }

  .children.on-path::before {
    border-left-color: var(--ink-3);
  }

  .row {
    --row-bg: var(--panel);
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--r-s);
  }

  .row:hover {
    --row-bg: var(--hover);
    background: var(--row-bg);
  }

  .row.selected {
    --row-bg: var(--accent-soft);
    background: var(--row-bg);
  }

  .twisty {
    flex: none;
    width: 18px;
    min-height: 0;
    height: 24px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink-3);
  }

  .twisty:hover {
    color: var(--ink);
  }

  .select {
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
    gap: 9px;
    padding: 4px 2px;
    border: 0;
    background: none;
    text-align: left;
  }

  .select:hover:not(:disabled) {
    background: none;
  }

  .select:focus-visible,
  .twisty:focus-visible {
    outline-offset: -2px;
  }

  .thumb {
    flex: none;
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: 3px;
    background: var(--well);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  }

  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .line1 {
    display: flex;
    gap: 7px;
    align-items: baseline;
    min-width: 0;
  }

  .ver {
    flex: none;
    font-size: 13.5px;
    color: var(--ink);
  }

  .row.on-path .ver {
    font-weight: 600;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title.muted {
    color: var(--ink-2);
  }

  .meta {
    display: flex;
    gap: 8px;
    color: var(--ink-3);
    font-size: var(--fs-xs);
    white-space: nowrap;
    overflow: hidden;
  }

  .meta .model {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta .folded {
    flex: none;
  }

  .meta.error {
    display: block;
    color: var(--danger);
    text-overflow: ellipsis;
  }

  /* Over the end of the row, not beside the title: idle rows give the whole width to the text */
  .actions {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px 0 16px;
    border-radius: var(--r-s);
    background: linear-gradient(to right, transparent, var(--row-bg) 14px);
    opacity: 0;
    /* the fade-out strip must not eat clicks meant for the row; only the buttons take them */
    pointer-events: none;
  }

  .actions button {
    pointer-events: auto;
  }

  .row:hover .actions,
  .row:focus-within .actions {
    opacity: 1;
  }

  /* what stays visible when the actions are away: starred, used as a reference, folded */
  .mark {
    flex: none;
    display: inline-flex;
    align-items: center;
  }

  .mark.star {
    color: var(--warn);
  }

  .mark.ref {
    padding: 0 4px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
  }

  .row.selected .mark.ref {
    background: var(--panel);
  }

  .actions button {
    min-height: 22px;
    height: 22px;
    padding: 0 6px;
    border: 0;
    background: none;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }

  .actions button:hover {
    color: var(--ink);
    background: var(--panel);
  }

  .actions .on {
    color: var(--accent);
    background: none;
  }

  .actions .star.on {
    color: var(--warn);
  }

  .actions .trash:hover {
    color: var(--danger);
  }

  /* touch screens have no hover: a column of actions beside the title, inactive ones faded */
  @media (hover: none) {
    .actions {
      position: static;
      flex: none;
      padding: 0 4px 0 0;
      background: none;
      opacity: 1;
      pointer-events: auto;
    }

    .mark {
      display: none;
    }

    .actions button:not(.on) {
      opacity: 0.55;
    }

    .actions button {
      height: 32px;
      min-height: 32px;
    }
  }

  .pending {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 4px 4px 4px 0;
  }

  .pending .twisty {
    margin-right: -9px;
  }

  .pending .text {
    flex: 1;
    padding-top: 2px;
  }

  .placeholder {
    display: grid;
    place-items: center;
    border: 1px dashed var(--rule-2);
    background: none;
    box-shadow: none;
  }

  .failed .placeholder {
    border-color: color-mix(in srgb, var(--danger) 50%, var(--rule-2));
  }

  .inline-actions {
    display: flex;
    gap: 2px;
    margin: 2px 0 0 -10px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--rule-2);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
