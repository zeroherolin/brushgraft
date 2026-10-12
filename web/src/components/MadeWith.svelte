<script lang="ts">
  import Copy from "@lucide/svelte/icons/copy";
  import Repeat2 from "@lucide/svelte/icons/repeat-2";
  import { thumb } from "../lib/media";
  import { app } from "../lib/app.svelte";
  import { fig } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import { ASSET_REF, type Job } from "../lib/types";

  // How the selected version was made: the edit (or prompt) behind it. It describes the
  // past, so it sits apart from the tabs that prepare the next edit; collapsible, since
  // an edit with many regions is long.
  let { job }: { job: Job } = $props();

  const parent = $derived(job.parent_id ? app.nodes[job.parent_id] : null);
  const source = $derived(
    job.kind === "edit"
      ? parent
        ? t("madeWith.editOf", { fig: fig(app.versions[parent.id]) })
        : t("madeWith.editOfDeleted")
      : t("madeWith.generated"),
  );
  // Variations need the parent; a generated image can always be run again
  const canRepeat = $derived(job.kind === "generate" || !!parent);
  const open = $derived(app.madeWithOpen ?? app.layout !== "narrow");
  // In the order they were sent: "reference image 1" in an instruction means the first. A version
  // of this project goes to it; an asset, or a version since deleted, shows the image that was sent
  const refs = $derived(
    job.refs.map((id, i) => {
      const asset = id.startsWith(ASSET_REF);
      const node = asset ? null : (app.nodes[id] ?? null);
      const libraryAsset = asset ? (app.assetById[id.slice(ASSET_REF.length)] ?? null) : null;
      return { id, node, asset, name: libraryAsset?.name ?? null, image: node?.image ?? job.ref_images?.[i] ?? null };
    }),
  );

  // A long edit scrolls inside the block instead of pushing the tabs away; a fade at the
  // bottom says there is more
  let scroller = $state<HTMLDivElement>();
  let more = $state(false);
  $effect(() => {
    const el = scroller;
    if (!el) return;
    const update = () => (more = el.scrollHeight - el.clientHeight - el.scrollTop > 2);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  });
</script>

<details class="made" {open} aria-label={t("madeWith.title")}>
  <summary
    onclick={(e) => {
      e.preventDefault(); // the state lives in app, so it is remembered
      app.setMadeWithOpen(!open);
    }}
  >
    <span class="title">{t("madeWith.title")}</span>
    <span class="source">{source}</span>
  </summary>
  <div class="scroll-wrap" class:more>
    <div class="body" bind:this={scroller}>
      {#if job.regions.length}
        <ol class="steps">
          {#each job.regions as region, i (i)}
            <li>
              <span class="badge" style:--c={app.regionColor(i)}>{i + 1}</span>
              <span class="text">{region.instruction.trim() || t("madeWith.noInstruction")}</span>
            </li>
          {/each}
        </ol>
      {/if}
      {#if job.prompt.trim()}
        <p class="prompt">
          {#if job.regions.length}<span class="label">{t("madeWith.overall")}</span>{/if}{job.prompt.trim()}
        </p>
      {/if}
    </div>
  </div>
  {#if refs.length}
    <div class="refs">
      <span class="label">{t("madeWith.refs")}</span>
      <ul>
        {#each refs as { id, node, asset, name: assetName, image }, i (`${i}:${id}`)}
          <li>
            {#if node}
              {@const name = `${t("composer.refName", { k: i + 1 })}, ${fig(app.versions[id])}`}
              <button class="thumb" title={name} aria-label="{name}. {t('madeWith.goToRef', { fig: fig(app.versions[id]) })}" onclick={() => app.select(id)}>
                <img {@attach thumb(node.image)} alt="" width="34" height="34" loading="lazy" decoding="async" />
                <span class="n">{i + 1}</span>
              </button>
            {:else}
              {@const what = asset ? (assetName ? t("madeWith.refAsset", { name: assetName }) : t("madeWith.refAssetGone")) : t("info.refDeleted")}
              {@const name = `${t("composer.refName", { k: i + 1 })}${asset ? ", " : " ("}${what}${asset ? "" : ")"}`}
              <span class="thumb" class:gone={!image} class:faded={!asset && !!image} title={name} role="img" aria-label={name}>
                {#if image}<img {@attach thumb(image)} alt="" width="34" height="34" loading="lazy" decoding="async" />{/if}
                <span class="n">{i + 1}</span>
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  <div class="actions">
    <button disabled={!canRepeat || app.isSending(`again:${job.id}`)} onclick={() => app.variations(job)} title={t("madeWith.moreTitle", { n: app.n })}>
      <Repeat2 size={14} />{t("madeWith.more", { n: app.n })}
    </button>
    <button onclick={() => app.reuseJob(job)} title={t("info.reuseTitle")}>
      <Copy size={14} />{t("info.reuse")}
    </button>
  </div>
</details>

<style>
  .made {
    flex: none;
    padding: 8px 14px 10px;
    border-bottom: 1px solid var(--rule);
    background: var(--panel-2);
  }

  summary {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-height: 22px;
    cursor: pointer;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    content: "";
    align-self: center;
    flex: none;
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

  .title {
    flex: none;
    font-weight: 600;
  }

  .source {
    min-width: 0;
    overflow: hidden;
    color: var(--ink-2);
    font-size: var(--fs-s);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scroll-wrap {
    position: relative;
    margin-top: 8px;
  }

  .body {
    display: grid;
    gap: 8px;
    max-height: min(13em, 30vh);
    overflow: auto;
  }

  .scroll-wrap.more::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 22px;
    background: linear-gradient(to bottom, transparent, var(--panel-2));
    pointer-events: none;
  }

  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }

  .steps li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: start;
  }

  /* ringed, not filled: these are the past edit, not the regions being drawn now */
  .badge {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border: 1.5px solid var(--c);
    border-radius: 50%;
    color: var(--c);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .text,
  .prompt {
    word-break: break-word;
  }

  .prompt {
    margin: 0;
  }

  .label {
    margin-right: 6px;
    color: var(--ink-2);
  }

  /* always visible, outside the scrolling part: a row of numbered thumbnails */
  .refs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    margin-top: 8px;
  }

  .refs .label {
    margin: 0;
  }

  .refs ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .thumb {
    position: relative;
    display: block;
    box-sizing: border-box;
    width: 34px;
    height: 34px;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: 4px;
    background: var(--well);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 14%, transparent);
  }

  button.thumb:hover {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* the number an instruction can refer to: "reference image 1" */
  .thumb .n {
    position: absolute;
    left: 0;
    bottom: 0;
    min-width: 14px;
    padding: 0 3px;
    border-top-right-radius: 4px;
    background: rgb(20 23 27 / 0.72);
    color: #fff;
    font-size: 10px;
    line-height: 14px;
    text-align: center;
  }

  /* a version since deleted: what was sent, dimmed */
  .thumb.faded img {
    opacity: 0.55;
    filter: grayscale(0.6);
  }

  .thumb.gone {
    background: repeating-linear-gradient(135deg, transparent 0 4px, var(--rule-2) 4px 5px);
  }

  .thumb.gone .n {
    background: var(--ink-3);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .actions button {
    gap: 5px;
  }
</style>
