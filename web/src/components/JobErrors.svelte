<script lang="ts">
  import { app, jobErrorText } from "../lib/app.svelte";
  import { t } from "../lib/i18n.svelte";
  import type { Job } from "../lib/types";

  // A job's errors: what went wrong and what to do, and under each the service's raw answer,
  // folded, for a report to the provider
  let { job }: { job: Job } = $props();
</script>

<ul class="errors">
  {#each job.errors as err, i (i)}
    <li>
      <p class="error">{jobErrorText(err, job.model, app.config?.lenient_model)}</p>
      {#if typeof err === "object" && err.detail && err.code !== "image_unreachable"}
        <details class="raw">
          <summary>{t("queue.raw")}</summary>
          <code>{err.detail}</code>
        </details>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .errors {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
    font-size: var(--fs-s);
  }

  .error {
    margin: 0;
    color: var(--danger);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .raw {
    margin-top: 2px;
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
</style>
