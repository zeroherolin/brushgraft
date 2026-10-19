<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { thumb } from "../lib/media";
  import { app } from "../lib/app.svelte";
  import { ASSET_REF } from "../lib/types";
  import { fig } from "../lib/format";
  import { i18n, t } from "../lib/i18n.svelte";
  import { altKey, submitKey } from "../lib/platform";
  import { charCount } from "../lib/backend/prompts";
  import { spec } from "../lib/backend/spec";
  import MadeWith from "./MadeWith.svelte";
  import NodeInfo from "./NodeInfo.svelte";

  let { variant = "panel" }: { variant?: "panel" | "sheet" } = $props();

  const CUSTOM = "__custom__";
  const model = $derived(app.modelInfo(app.model));
  const editing = $derived(app.mode === "edit" && !!app.selected);
  const draft = $derived(app.draft);
  const regions = $derived(draft.regions);
  const version = $derived(app.selected ? app.versions[app.selected.id] : "");
  // The sentence around the figure label, so the label can be set in the serif face
  const context = $derived(t("composer.context", { fig: "\u0000" }).split("\u0000"));
  // "Custom…" starts from the size in use, which may itself be a preset: remember the choice
  let pickedCustom = $state(false);
  // the model name field stays while it is typed in, even when what is typed so far is a listed
  // model's name (gpt-image-2 on the way to gpt-image-2-turbo)
  let typingModel = $state(false);
  const customModel = $derived(typingModel || app.isCustomModel);
  const customSize = $derived(pickedCustom || !app.config?.size_presets.includes(app.size));

  const keyMissing = $derived(!app.config?.settings.api_key_set);
  const hint = $derived(
    app.blocker === "model"
      ? t("composer.hintModel")
      : app.blocker === "empty"
        ? editing
          ? t("composer.hintEdit")
          : t("composer.hintNew")
        : app.blocker === "instruction"
          ? t("composer.hintInstruction")
          : app.blocker === "tooLong"
            ? t("composer.hintTooLong")
            : app.blocker === "refs"
              ? t("composer.hintRefs", { model: app.model, max: app.maxRefs })
              : "",
  );

  // A field's length against its limit: shown from 80% on (nobody needs a counter for a sentence),
  // red past it, where submitting stops and says why
  const count = (text: string, max: number) => {
    const n = charCount(text.trim());
    return { n, max, show: n >= max * 0.8, over: n > max };
  };
  const promptCount = $derived(count(draft.prompt, spec.max_prompt));
</script>

<aside class="composer" class:sheet={variant === "sheet"} aria-label={t("composer.label")}>
  <!-- About the selected version (its past), so outside the tabs, which are about the next edit -->
  {#if app.selected && app.selectedJob}
    <MadeWith job={app.selectedJob} />
  {/if}
  <div class="tabs" role="tablist" aria-label={t("composer.tabs")}>
    <button role="tab" aria-selected={editing} disabled={!app.selected} onclick={() => app.setMode("edit")}>
      {t("composer.editTab")}
    </button>
    <button role="tab" aria-selected={!editing} onclick={() => app.setMode("generate")}>{t("composer.newTab")}</button>
  </div>

  <div class="scroll">
    {#if editing}
      <p class="context">{context[0]}<span class="serif ver">{fig(version)}</span>{context[1] ?? ""}</p>

      <section>
        <div class="section-head">
          <h3>{t("composer.regions")}</h3>
          {#if regions.length}
            <span class="count">{regions.length}</span>
            <span class="spacer"></span>
            <button class="quiet small" onclick={() => app.clearDraft()}>{t("composer.clearAll")}</button>
          {/if}
        </div>
        {#if !regions.length}
          <p class="help">
            {t("composer.regionsHelp", { alt: altKey })}
          </p>
        {:else}
          <ol class="regions">
            {#each regions as region, i (i)}
              {@const c = count(region.instruction, spec.max_instruction)}
              <li class:selected={app.selectedRegion === i}>
                <button
                  class="badge"
                  style:background={app.regionColor(i)}
                  style:color={app.regionInk(i)}
                  aria-label={t("composer.selectRegion", { k: i + 1 })}
                  onclick={() => (app.selectedRegion = i)}>{i + 1}</button
                >
                <div class="instruction">
                  <textarea
                    rows="2"
                    aria-label={t("composer.instructionLabel", { k: i + 1 })}
                    aria-invalid={c.over}
                    aria-describedby={c.show ? `count-${i}` : undefined}
                    placeholder={t("composer.instructionPlaceholder")}
                    bind:value={region.instruction}
                    onfocus={() => (app.selectedRegion = i)}
                  ></textarea>
                  {#if c.show}
                    <span class="chars" class:over={c.over} id="count-{i}" aria-label={t("composer.charCountLabel", { n: c.n, max: c.max })}>{t("composer.charCount", { n: c.n, max: c.max })}</span>
                  {/if}
                </div>
                <button class="quiet icon remove" aria-label={t("composer.removeRegion", { k: i + 1 })} onclick={() => app.removeRegion(i)}>
                  <X size={14} />
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    {/if}

    <section>
      <div class="section-head">
        <label for="prompt"
          ><h3>{editing ? (regions.length ? t("composer.overall") : t("composer.request")) : t("composer.prompt")}</h3></label
        >
        {#if editing && regions.length}<span class="optional">{t("composer.optional")}</span>{/if}
      </div>
      <textarea
        id="prompt"
        rows={editing ? 3 : 6}
        aria-invalid={promptCount.over}
        aria-describedby={promptCount.show ? "prompt-count" : undefined}
        placeholder={editing
          ? regions.length
            ? t("composer.overallPlaceholder")
            : t("composer.requestPlaceholder")
          : t("composer.promptPlaceholder")}
        bind:value={draft.prompt}
      ></textarea>
      {#if promptCount.show}
        <span class="chars" class:over={promptCount.over} id="prompt-count" aria-label={t("composer.charCountLabel", { n: promptCount.n, max: promptCount.max })}
          >{t("composer.charCount", { n: promptCount.n, max: promptCount.max })}</span
        >
      {/if}
    </section>

    <section>
      <div class="section-head">
        <h3>{t("composer.refs")}</h3>
        {#if draft.refs.length}<span class="count">{draft.refs.length}</span>{/if}
      </div>
      {#if draft.refs.length}
        <ul class="refs">
          {#each draft.refs as id, i (id)}
            {@const asset = id.startsWith(ASSET_REF) ? app.assetById[id.slice(ASSET_REF.length)] : null}
            {@const ref = asset ?? app.nodes[id]}
            <li>
              {#if ref}<img {@attach thumb(ref.image)} alt="" width="34" height="34" />{/if}
              <span>{t("composer.refName", { k: i + 1 })}</span>
              {#if asset}
                <span class="asset-name" title={asset.name}><span class="kind">{t("composer.refAsset")}</span>{asset.name}</span>
              {:else}
                <span class="ver serif">{fig(app.versions[id])}</span>
              {/if}
              <button class="quiet icon" aria-label={t("composer.removeRef", { k: i + 1 })} onclick={() => app.toggleRef(id)}><X size={14} /></button>
            </li>
          {/each}
        </ul>
        <p class="help">{t("composer.refsHelp")}</p>
      {:else}
        <p class="help">{editing ? t("composer.refsEmptyEdit") : t("composer.refsEmptyNew")}</p>
      {/if}
    </section>

    <section class="params">
      <div class="field">
        <label for="model">{t("composer.model")}</label>
        <select
          id="model"
          value={customModel ? CUSTOM : app.model}
          onchange={(e) => {
            const v = e.currentTarget.value;
            typingModel = v === CUSTOM;
            app.model = v === CUSTOM ? "" : v;
            app.persistPrefs();
          }}
        >
          {#each app.config?.models ?? [] as m (m.name)}
            <option value={m.name}>{m.name}</option>
          {/each}
          <option value={CUSTOM}>{t("composer.otherModel")}</option>
        </select>
      </div>
      {#if customModel}
        <div class="field">
          <label for="custom-model">{t("composer.modelName")}</label>
          <input
            id="custom-model"
            bind:value={app.model}
            placeholder={t("composer.modelNamePlaceholder")}
            autocomplete="off"
            spellcheck="false"
            onchange={() => app.persistPrefs()}
          />
        </div>
      {/if}
      <p class="help indent">
        {#if model}{@const note = i18n.modelNote(model.name, model.note)}{note
            ? t("composer.modelHelp", { seconds: i18n.modelSeconds(model.seconds), note })
            : i18n.modelSeconds(model.seconds)}{:else}{t("composer.unknownModel")}{/if}
      </p>

      {#if !editing}
        <div class="field">
          <label for="size">{t("composer.size")}</label>
          <select
            id="size"
            value={customSize ? CUSTOM : app.size}
            onchange={(e) => {
              const v = e.currentTarget.value;
              pickedCustom = v === CUSTOM;
              if (!pickedCustom) app.size = v;
              else if (app.size === "auto") app.size = "1536x1024"; // a field to edit needs numbers
              app.persistPrefs();
            }}
          >
            {#each app.config?.size_presets ?? [] as s (s)}
              <option value={s}>{s === "auto" ? t("composer.sizeAuto") : s.replace("x", " × ")}</option>
            {/each}
            <option value={CUSTOM}>{t("composer.sizeCustom")}</option>
          </select>
        </div>
        {#if customSize}
          <div class="field">
            <label for="custom-size">{t("composer.customSize")}</label>
            <input id="custom-size" bind:value={app.size} placeholder="1536x1024" onchange={() => app.persistPrefs()} />
          </div>
        {/if}
      {:else if app.selected}
        <div class="field">
          <span class="label">{t("composer.size")}</span>
          <span class="value">{t("composer.sameAspect")}</span>
        </div>
      {/if}

      <div class="field">
        <span class="label" id="count-label">{t("composer.count")}</span>
        <div class="segmented" role="radiogroup" aria-labelledby="count-label">
          {#each [1, 2, 3, 4] as k (k)}
            <button role="radio" aria-checked={app.n === k} class:on={app.n === k} onclick={() => (app.n = k)}>{k}</button>
          {/each}
        </div>
      </div>

      {#if editing && regions.length}
        <label class="check" class:disabled={!app.canComposite}>
          <input type="checkbox" bind:checked={app.composite} disabled={!app.canComposite} onchange={() => app.persistPrefs()} />
          <span>{t("composer.composite")}</span>
        </label>
        {#if model && !model.aligned}
          <p class="help warn">{t("composer.notAligned")}</p>
        {:else if app.tooOblong}
          <p class="help warn">{t("composer.tooOblong", { max: spec.sizes.max_aspect })}</p>
        {:else}
          <p class="help">{t("composer.compositeHelp")}</p>
        {/if}
      {/if}
    </section>

    {#if app.selected && variant === "panel"}
      <NodeInfo node={app.selected} />
    {/if}
  </div>

  <div class="submit">
    {#if keyMissing}
      <button class="primary" onclick={() => (app.settingsOpen = true)}>{t("composer.needKey")}</button>
    {:else}
      <button class="primary" disabled={!!app.blocker} onclick={() => app.submit()}>
        {app.isSending() && app.blocker === "empty"
          ? t("composer.submitting")
          : editing
            ? t("composer.submitEdit", { n: app.n })
            : t("composer.submitNew", { n: app.n })}
        <kbd>{submitKey}</kbd>
      </button>
      {#if hint}<p class="hint">{hint}</p>{/if}
    {/if}
  </div>
</aside>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--rule);
    background: var(--panel);
  }

  .composer.sheet {
    flex: 1;
    border-left: 0;
  }

  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    flex: none;
    height: 40px;
    border-bottom: 1px solid var(--rule);
  }

  .tabs button {
    height: 100%;
    border: 0;
    border-radius: 0;
    background: none;
    color: var(--ink-2);
    box-shadow: inset 0 -2px 0 transparent;
  }

  .tabs button[aria-selected="true"] {
    color: var(--ink);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 4px 14px 16px;
  }

  .context {
    margin: 10px 0 0;
    color: var(--ink-2);
  }

  .ver {
    color: var(--ink);
    font-weight: 600;
  }

  section {
    margin-top: 16px;
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    margin-bottom: 6px;
  }

  h3 {
    margin: 0;
    font-size: var(--fs-m);
    font-weight: 600;
  }

  .count {
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule);
    color: var(--ink-2);
    font-size: var(--fs-xs);
    text-align: center;
  }

  .optional {
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  .instruction {
    display: grid;
    min-width: 0;
  }

  /* a field's length against its limit, under it on the right */
  .chars {
    display: block;
    margin-top: 3px;
    color: var(--ink-3);
    font-size: var(--fs-s);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .chars.over {
    color: var(--danger);
    font-weight: 600;
  }

  textarea[aria-invalid="true"] {
    border-color: var(--danger);
  }

  .spacer {
    flex: 1;
  }

  button.small {
    min-height: 22px;
    padding: 0 6px;
    font-size: var(--fs-s);
  }

  .help {
    margin: 6px 0 0;
    color: var(--ink-2);
    font-size: var(--fs-s);
    line-height: 1.55;
  }

  .help.indent {
    margin: 0 0 4px 4.5em;
  }

  .help.warn {
    color: var(--warn);
  }

  .regions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }

  .regions li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 8px;
    align-items: start;
    padding: 6px;
    border-radius: var(--r-s);
    box-shadow: inset 0 0 0 1px var(--rule);
  }

  .regions li.selected {
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--rule-2);
  }

  .badge {
    width: 22px;
    min-height: 22px;
    height: 22px;
    margin-top: 4px;
    padding: 0;
    border: 1.5px solid #fff;
    border-radius: 50%;
    color: #fff;
    font-size: var(--fs-s);
    font-weight: 600;
    box-shadow: 0 0 0 1px var(--rule-2);
  }

  .remove {
    margin-top: 1px;
  }

  .refs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
  }

  .refs li {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .refs span:first-of-type {
    flex: 1;
  }

  .refs img {
    width: 34px;
    height: 34px;
    object-fit: cover;
    border-radius: 3px;
  }

  .refs .asset-name {
    max-width: 50%;
    overflow: hidden;
    color: var(--ink-2);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .refs .kind {
    margin-right: 4px;
    color: var(--ink-3);
    font-size: var(--fs-xs);
  }

  .params {
    display: grid;
    gap: 8px;
    padding-top: 14px;
    border-top: 1px solid var(--rule);
  }

  .field {
    display: grid;
    grid-template-columns: 4em minmax(0, 1fr);
    align-items: center;
    gap: 8px;
  }

  .field label,
  .field .label {
    color: var(--ink-2);
  }

  .field .value {
    color: var(--ink);
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
    width: 34px;
    min-height: 24px;
    padding: 0;
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

  .check {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 4px;
  }

  .check.disabled {
    color: var(--ink-3);
  }

  .submit {
    flex: none;
    padding: 12px 14px;
    border-top: 1px solid var(--rule);
    background: var(--panel);
  }

  .sheet .submit {
    padding-bottom: calc(12px + env(safe-area-inset-bottom));
  }

  .submit button {
    width: 100%;
    min-height: 34px;
  }

  .hint {
    margin: 6px 0 0;
    color: var(--ink-3);
    font-size: var(--fs-s);
    text-align: center;
  }

  @media (pointer: coarse) {
    .segmented button {
      width: 44px;
      min-height: 32px;
    }

    .submit button {
      min-height: 44px;
    }
  }
</style>
