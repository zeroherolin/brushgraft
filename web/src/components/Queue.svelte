<script lang="ts">
  import { onDestroy } from "svelte";
  import { app, describeJob, jobErrorText } from "../lib/app.svelte";
  import { t } from "../lib/i18n.svelte";
  import { elapsed } from "../lib/format";
  import type { Job } from "../lib/types";

  let now = $state(Date.now() / 1000);
  const timer = setInterval(() => (now = Date.now() / 1000), 1000);
  onDestroy(() => clearInterval(timer));

  const active = (j: Job) => j.status === "queued" || j.status === "running";

  // Running jobs first, then the most recently finished ones
  const jobs = $derived(
    Object.values(app.jobs)
      .sort((a, b) => (active(a) === active(b) ? b.created_at - a.created_at : active(a) ? -1 : 1))
      .slice(0, 10),
  );


  function open(job: Job) {
    const result = Object.values(app.nodes).find((n) => n.job_id === job.id);
    if (result) app.select(result.id);
    else if (job.parent_id && app.nodes[job.parent_id]) app.select(job.parent_id);
    app.queueOpen = false;
  }
</script>

<div class="queue" role="dialog" aria-label={t("queue.title")}>
  <div class="head">
    <span>{t("queue.title")}</span>
    <span class="muted">{t("queue.limit")}</span>
  </div>
  {#if !jobs.length}
    <p class="empty">{t("queue.empty")}</p>
  {/if}
  <ol>
    {#each jobs as job (job.id)}
      {@const logs = app.logs[job.id] ?? []}
      <li>
        <button class="row" onclick={() => open(job)}>
          <span class="status {job.status}">{t(`status.${job.status}`)}</span>
          <span class="text">
            <span class="title">{describeJob(job)}</span>
            <span class="meta">
              {t("queue.meta", { model: job.model, done: job.done, n: job.n })}{active(job)
                ? `${t("common.comma")}${t("queue.waiting", { time: elapsed(now - job.created_at) })}`
                : job.finished_at
                  ? `${t("common.comma")}${t("queue.took", { time: elapsed(job.finished_at - job.created_at) })}`
                  : ""}
            </span>
          </span>
        </button>
        {#if logs.length && active(job)}
          <ol class="logs">
            {#each logs.slice(-3) as line, i (i)}
              <li class={line.level}>{line.msg}</li>
            {/each}
          </ol>
        {/if}
        {#each job.errors as err, i (i)}
          <p class="error">{jobErrorText(err, job.model, app.config?.lenient_model)}</p>
          {#if typeof err === "object" && err.detail && err.code !== "image_unreachable"}
            <details class="raw">
              <summary>{t("queue.raw")}</summary>
              <code>{err.detail}</code>
            </details>
          {/if}
        {/each}
      </li>
    {/each}
  </ol>
</div>

<style>
  .queue {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    width: min(420px, calc(100vw - 16px));
    max-height: min(70vh, 560px);
    overflow: auto;
    border: 1px solid var(--rule-2);
    border-radius: var(--r-m);
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    z-index: 40;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 10px 12px 6px;
    font-weight: 600;
  }

  .muted {
    color: var(--ink-3);
    font-weight: 400;
    font-size: var(--fs-xs);
  }

  .empty {
    margin: 4px 12px 14px;
    color: var(--ink-2);
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .queue > ol > li {
    padding: 4px 6px;
    border-top: 1px solid var(--rule);
  }

  .row {
    display: flex;
    width: 100%;
    gap: 10px;
    align-items: flex-start;
    justify-content: flex-start;
    border: 0;
    background: none;
    text-align: left;
    white-space: normal;
  }

  .status {
    flex: none;
    min-width: 5.6em; /* the longest, "Generating", fits: the titles line up */
    white-space: nowrap;
    font-size: var(--fs-s);
    color: var(--ink-2);
  }

  .status.running,
  .status.queued {
    color: var(--warn);
  }

  .status.failed {
    color: var(--danger);
  }

  .status.done {
    color: var(--ok);
  }

  .text {
    min-width: 0;
    display: grid;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .logs {
    margin: 0 10px 4px calc(3.2em + 20px);
    font-size: var(--fs-s);
    color: var(--ink-2);
  }

  .logs .retry,
  .logs .warn {
    color: var(--warn);
  }

  .logs .error,
  .error {
    color: var(--danger);
  }

  .raw {
    margin-top: -4px;
    color: var(--ink-3);
  }

  .raw summary {
    cursor: pointer;
    width: fit-content;
  }

  .raw code {
    display: block;
    margin-top: 2px;
    max-height: 8em;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }

  .error,
  .raw {
    margin: 0 10px 6px calc(5.6em + 20px); /* under the title, past the status column */
    font-size: var(--fs-s);
    overflow-wrap: anywhere;
  }
</style>
