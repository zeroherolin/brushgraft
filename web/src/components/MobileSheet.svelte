<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import { app, describeJob } from "../lib/app.svelte";
  import { fig } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import Composer from "./Composer.svelte";
  import JobPanel from "./JobPanel.svelte";
  import NodeInfo from "./NodeInfo.svelte";

  let infoOpen = $state(false);

  const editing = $derived(app.mode === "edit" && !!app.selected);
  const regions = $derived(app.draft.regions.length);
  const summary = $derived.by(() => {
    const job = app.viewedJob;
    if (job) return t("sheet.summaryJob", { status: t(`status.${job.status}`), text: describeJob(job) });
    if (!editing) return app.draft.prompt.trim() || t("sheet.summaryNew");
    const ver = app.versions[app.selected!.id];
    if (regions) return t("sheet.summaryRegions", { fig: fig(ver), n: regions });
    return app.draft.prompt.trim() || t("sheet.summaryEdit", { fig: fig(ver) });
  });
</script>

{#if app.sheetOpen}
  <div class="scrim" role="presentation" onclick={() => (app.sheetOpen = false)}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={app.viewedJob ? t("job.label") : t("composer.label")}>
    <div class="sheet-head">
      <span class="grip" aria-hidden="true"></span>
      {#if app.selected && !app.viewedJob}
        <button class="quiet" aria-pressed={infoOpen} onclick={() => (infoOpen = !infoOpen)}>{t("sheet.details")}</button>
      {/if}
      <span class="spacer"></span>
      <button class="quiet icon" aria-label={t("sheet.collapse")} onclick={() => (app.sheetOpen = false)}><ChevronDown size={18} /></button>
    </div>
    {#if app.viewedJob}
      <JobPanel job={app.viewedJob} variant="sheet" />
    {:else if infoOpen && app.selected}
      <div class="info"><NodeInfo node={app.selected} open /></div>
    {:else}
      <Composer variant="sheet" />
    {/if}
  </div>
{:else}
  <div class="peek">
    <button class="summary" onclick={() => (app.sheetOpen = true)} aria-label={t("sheet.expand")}>
      <ChevronUp size={16} />
      <span class="text">{summary}</span>
    </button>
    <button class="primary" onclick={() => (app.sheetOpen = true)}>{app.viewedJob ? t("sheet.view") : editing ? t("sheet.edit") : t("sheet.write")}</button>
  </div>
{/if}

<style>
  .peek {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--rule);
    background: var(--panel);
  }

  .summary {
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
    gap: 8px;
    border: 0;
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule);
    color: var(--ink-2);
  }

  .summary .text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 30;
    animation: fade 0.16s ease-out;
  }

  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: min(82dvh, 720px);
    display: flex;
    flex-direction: column;
    border-radius: 12px 12px 0 0;
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    z-index: 31;
    animation: rise 0.2s ease-out;
  }

  .sheet-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 10px 6px 2px 8px;
  }

  .grip {
    position: absolute;
    top: 6px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--rule-2);
  }

  .spacer {
    flex: 1;
  }

  .info {
    flex: 1;
    overflow: auto;
    padding: 0 14px calc(16px + env(safe-area-inset-bottom));
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes rise {
    from {
      transform: translateY(32px);
      opacity: 0;
    }
  }
</style>
