<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { onDestroy } from "svelte";
  import { app } from "../lib/app.svelte";
  import { elapsed, fig } from "../lib/format";
  import { i18n, t } from "../lib/i18n.svelte";
  import type { Job } from "../lib/types";
  import JobErrors from "./JobErrors.svelte";
  import MadeWith from "./MadeWith.svelte";

  // A job still generating, or failed, opened from the tree: what it asked for, how far it got and
  // why it failed, with room for the whole log and error that a row of the tree can't show
  let { job, variant = "panel" }: { job: Job; variant?: "panel" | "sheet" } = $props();

  let now = $state(Date.now() / 1000);
  const timer = setInterval(() => (now = Date.now() / 1000), 1000);
  onDestroy(() => clearInterval(timer));

  const active = $derived(job.status === "queued" || job.status === "running");
  const parent = $derived(job.parent_id ? (app.nodes[job.parent_id] ?? null) : null);
  const logs = $derived(app.logs[job.id] ?? []);
  const time = $derived(
    active
      ? t("queue.waiting", { time: elapsed(now - job.created_at) })
      : job.finished_at
        ? t("queue.took", { time: elapsed(job.finished_at - job.created_at) })
        : "",
  );
  const clock = (seconds: number) =>
    new Date(seconds * 1000).toLocaleTimeString(i18n.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  // the newest line stays in view while the job runs, unless the log was scrolled up to read it
  let logBox = $state<HTMLOListElement>();
  $effect(() => {
    void logs.length;
    const el = logBox;
    if (el && el.scrollHeight - el.clientHeight - el.scrollTop < 40) el.scrollTop = el.scrollHeight;
  });
</script>

<aside class="job" class:sheet={variant === "sheet"} aria-label={t("job.label")}>
  <div class="head">
    <span class="state {job.status}">
      {#if active}<span class="spinner" aria-hidden="true"></span>{/if}
      {t(`status.${job.status}`)}
    </span>
    <span class="time">{time}</span>
    <span class="spacer"></span>
    <button class="quiet icon" title={t("job.close")} aria-label={t("job.close")} onclick={() => app.closeJob()}><X size={16} /></button>
  </div>

  <MadeWith {job} />

  <div class="scroll">
    <dl class="facts">
      <dt>{t("composer.model")}</dt>
      <dd>{job.model}</dd>
      <dt>{t("composer.size")}</dt>
      <dd>{job.size || "—"}</dd>
      <dt>{t("composer.count")}</dt>
      <dd>{t("job.progress", { done: job.done, failed: job.failed, n: job.n })}</dd>
    </dl>

    {#if job.errors.length}
      <section>
        <h3>{t("job.errors")}</h3>
        <JobErrors {job} />
      </section>
    {/if}

    <section>
      <h3>{t("job.log")}</h3>
      {#if logs.length}
        <ol class="log" bind:this={logBox}>
          {#each logs as line, i (i)}
            <li class={line.level}><time>{clock(line.t)}</time><span>{line.msg}</span></li>
          {/each}
        </ol>
      {:else}
        <p class="help">{active ? t("job.noLogYet") : t("job.noLog")}</p>
      {/if}
    </section>
  </div>

  {#if parent || !active}
  <div class="submit">
    {#if parent}
      <button onclick={() => app.select(parent.id)}>{t("job.backTo", { fig: fig(app.versions[parent.id]) })}</button>
    {/if}
    {#if !active}
      <button class="danger" onclick={() => app.dismissJob(job)}>{t("tree.dismiss")}</button>
    {/if}
  </div>
  {/if}
</aside>

<style>
  .job {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--rule);
    background: var(--panel);
  }

  .job.sheet {
    flex: 1;
    border-left: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
    min-height: 40px;
    padding: 0 6px 0 14px;
    border-bottom: 1px solid var(--rule);
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: 600;
  }

  .state.running,
  .state.queued {
    color: var(--warn);
  }

  .state.failed {
    color: var(--danger);
  }

  .time {
    color: var(--ink-3);
    font-size: var(--fs-s);
    font-variant-numeric: tabular-nums;
  }

  .spacer {
    flex: 1;
  }

  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 4px 14px 16px;
  }

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 14px;
    margin: 12px 0 0;
    font-size: var(--fs-s);
  }

  .facts dt {
    color: var(--ink-3);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  section {
    margin-top: 16px;
  }

  h3 {
    margin: 0 0 6px;
    font-size: var(--fs-m);
    font-weight: 600;
  }

  .help {
    margin: 0;
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .log {
    list-style: none;
    margin: 0;
    padding: 6px 8px;
    max-height: 18em;
    overflow: auto;
    border-radius: var(--r-s);
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule);
    font-size: var(--fs-xs);
    line-height: 1.55;
  }

  .log li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    overflow-wrap: anywhere;
    user-select: text;
  }

  .log time {
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }

  .log .retry,
  .log .warn {
    color: var(--warn);
  }

  .log .error {
    color: var(--danger);
  }

  .log .ok {
    color: var(--ok, var(--ink));
  }

  .submit {
    display: flex;
    gap: 8px;
    flex: none;
    padding: 12px 14px;
    border-top: 1px solid var(--rule);
  }

  .submit button {
    flex: 1;
  }

  .spinner {
    width: 12px;
    height: 12px;
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
