<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "../lib/app.svelte";
  import { clock, elapsed, fig } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import { openImage } from "../lib/media";
  import type { TreeNode } from "../lib/types";
  import JobErrors from "./JobErrors.svelte";

  let { node, open = false }: { node: TreeNode; open?: boolean } = $props();
  // Keep the open state here, so updates to the version (a star, a switched
  // image) don't collapse it
  let expanded = $state(untrack(() => open));

  const job = $derived(node.job_id ? (app.jobs[node.job_id] ?? null) : null);
  const parentVer = $derived(node.parent_id ? app.versions[node.parent_id] : "");
</script>

<!-- open: shown on its own (the phone sheet's details), under a heading of its own already -->
<details class="info" class:standalone={open} bind:open={expanded}>
  <summary>{t("info.title")}</summary>
  <dl>
    <dt>{t("info.version")}</dt>
    <dd><span class="serif">{fig(app.versions[node.id])}</span>{#if node.starred}{t("info.starred")}{/if}</dd>
    <dt>{t("info.source")}</dt>
    <dd>
      {#if !job}{node.label ? t("info.importedFile", { name: node.label }) : t("info.imported")}{:else if job.kind === "edit"}{t(
          "info.editOf",
          { fig: fig(parentVer) },
        )}{:else}{t("info.generated")}{/if}
    </dd>
    {#if job}
      <dt>{t("info.model")}</dt>
      <dd>{job.model}</dd>
      {#if job.finished_at}
        <dt>{t("info.took")}</dt>
        <dd>{elapsed(job.finished_at - job.created_at)}{job.n > 1 ? t("info.together", { n: job.n }) : ""}</dd>
      {/if}
      {#if job.usage?.total_tokens}
        <dt>{t("info.usage")}</dt>
        <dd>
          {t("info.tokens", { n: job.usage.total_tokens.toLocaleString() })}{job.n > 1
            ? t("info.usageTotal", { n: job.n })
            : ""}
        </dd>
      {/if}
    {/if}
    <dt>{t("info.size")}</dt>
    <dd>{node.width} × {node.height}</dd>
    <dt>{t("info.created")}</dt>
    <dd>{clock(node.created_at)}</dd>
  </dl>

  {#if node.note}
    <p class="help note">{app.noteText(node.note)}</p>
  {/if}
  {#if job?.errors.length}
    <div class="failed">
      <span class="label">{t("job.errors")}</span>
      <JobErrors {job} />
    </div>
  {/if}
  {#if node.raw_image && node.merged_image}
    {@const usingRaw = node.image === node.raw_image}
    <!-- a job still generating or failed was drawn on the adopted image: its regions must keep fitting -->
    {@const locked = (app.children[node.id]?.length ?? 0) > 0 || (app.pendingJobs[node.id]?.length ?? 0) > 0}
    <div class="adopt">
      <span class="label" id="adopt-{node.id}">{t("info.adopt")}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="adopt-{node.id}">
        <button role="radio" aria-checked={!usingRaw} class:on={!usingRaw} disabled={locked} onclick={() => app.useRaw(node, false)}>
          {t("info.adoptMerged")}
        </button>
        <button role="radio" aria-checked={usingRaw} class:on={usingRaw} disabled={locked} onclick={() => app.useRaw(node, true)}>
          {t("info.adoptRaw")}
        </button>
      </div>
      <p class="help">
        {locked ? t("info.adoptLocked") : usingRaw ? t("info.adoptRawHelp") : t("info.adoptMergedHelp")}
      </p>
    </div>
  {/if}

  {#if job}
    <details class="sent">
      <summary>{t("info.sent")}</summary>
      <pre>{job.full_prompt}</pre>
      {#if job.annot_image}
        <button class="link" onclick={() => openImage(job.annot_image!)}>{t("info.annotated")}</button>
      {/if}
    </details>
  {/if}

  <div class="actions">
    <button class="danger" onclick={() => app.deleteNode(node)}>{t("info.delete")}</button>
  </div>
</details>

<style>
  .failed {
    margin: 8px 0 0;
  }

  .failed .label {
    display: block;
    margin-bottom: 4px;
    color: var(--ink-2);
    font-size: var(--fs-s);
  }

  .standalone > summary {
    display: none;
  }

  .info {
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px solid var(--rule);
  }

  summary {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-weight: 600;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    content: "";
    width: 0;
    height: 0;
    border-left: 4.5px solid currentColor;
    border-top: 3.5px solid transparent;
    border-bottom: 3.5px solid transparent;
    transition: transform 0.12s;
    opacity: 0.7;
  }

  details[open] > summary::before {
    transform: rotate(90deg);
  }

  .sent summary {
    font-weight: 400;
    color: var(--ink-2);
  }

  dl {
    display: grid;
    grid-template-columns: 4em minmax(0, 1fr);
    gap: 4px 8px;
    margin: 10px 0;
  }

  dt {
    color: var(--ink-2);
  }

  dd {
    margin: 0;
    word-break: break-word;
  }

  pre {
    margin: 8px 0;
    padding: 8px 10px;
    border-radius: var(--r-s);
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule);
    font: inherit;
    font-size: var(--fs-s);
    white-space: pre-wrap;
  }

  .sent .link {
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: var(--fs-s);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  .adopt {
    display: grid;
    grid-template-columns: 4em minmax(0, 1fr);
    align-items: center;
    gap: 6px 8px;
    margin-bottom: 10px;
  }

  .adopt .label {
    color: var(--ink-2);
  }

  .adopt .help {
    grid-column: 2;
  }

  .help {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--fs-s);
  }

  .help.note {
    margin-bottom: 10px;
  }

  .segmented {
    display: inline-flex;
    width: max-content;
    padding: 2px;
    gap: 2px;
    border-radius: calc(var(--r-s) + 2px);
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .segmented button {
    min-height: 24px;
    padding: 0 8px;
    border: 0;
    background: none;
    color: var(--ink-2);
  }

  .segmented button.on {
    background: var(--panel);
    color: var(--ink);
    font-weight: 600;
    box-shadow:
      0 0 0 1px var(--rule-2),
      0 1px 2px rgb(0 0 0 / 0.06);
  }
</style>
