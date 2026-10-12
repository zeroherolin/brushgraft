<script lang="ts">
  import { app } from "../lib/app.svelte";
  import { backend } from "../lib/backend";
  import { zoomText } from "../lib/format";
  import { t } from "../lib/i18n.svelte";

  const node = $derived(app.selected);
  const inside = $derived(
    node && app.cursor && app.cursor[0] >= 0 && app.cursor[1] >= 0 && app.cursor[0] < node.width && app.cursor[1] < node.height,
  );
</script>

<footer class="status" aria-label={t("status.label")}>
  <span class="item">
    <span class="light" class:off={!app.online} aria-hidden="true"></span>
    {#if backend.kind === "browser"}
      {t("status.stored")}
    {:else}
      {app.online ? t("status.connected") : t("status.reconnecting")}
    {/if}
  </span>
  {#if app.activeJobs.length}
    <span class="item busy">{t("status.busy", { n: app.activeJobs.length })}</span>
  {/if}
  <span class="item">{t("status.versions", { n: app.nodeCount })}</span>
  <span class="spacer"></span>
  {#if inside && app.cursor}
    <span class="item">x {Math.floor(app.cursor[0])}</span>
    <span class="item">y {Math.floor(app.cursor[1])}</span>
  {/if}
  {#if node}
    <span class="item">{node.width} × {node.height}</span>
    <span class="item">{zoomText(app.zoom)}</span>
  {/if}
  {#if app.mode === "edit" && app.draft.regions.length}
    <span class="item">{t("status.regions", { n: app.draft.regions.length })}</span>
  {/if}
  {#if app.site}
    <a class="item legal" href={app.site.url} target="_blank" rel="noopener noreferrer">{app.site.icp}</a>
  {/if}
</footer>

<style>
  .status {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 24px;
    padding: 0 12px;
    border-top: 1px solid var(--rule);
    background: var(--panel-2);
    color: var(--ink-3);
    font-size: var(--fs-xs);
    white-space: nowrap;
    overflow: hidden;
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .busy {
    color: var(--warn);
  }

  .light {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
  }

  .light.off {
    background: var(--warn);
  }

  .spacer {
    flex: 1;
  }

  .legal {
    color: var(--ink-3);
    text-decoration: none;
  }

  .legal:hover {
    color: var(--ink-2);
    text-decoration: underline;
  }
</style>
