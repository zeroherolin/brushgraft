<script lang="ts">
  import { onMount } from "svelte";
  import { backend } from "../lib/backend";
  import type { StorageInfo } from "../lib/backend/types";
  import { app, errorText } from "../lib/app.svelte";
  import { i18n, t, type Key, type Lang } from "../lib/i18n.svelte";
  import { altKey, modKey, redoKey, submitKey, undoKey } from "../lib/platform";
  import type { Theme } from "../lib/prefs";

  const browser = backend.kind === "browser";
  const settings = $derived(app.config!.settings);
  let apiKey = $state("");
  let baseUrl = $state(app.config!.settings.base_url);
  let remember = $state(app.config!.settings.remember ?? true);
  let saving = $state(false);
  let error = $state("");
  let testing = $state(false);
  let test = $state<{ ok: boolean; text: string } | null>(null);
  let storage = $state<StorageInfo | null>(null);
  let persistDenied = $state(false);
  let dialog: HTMLDialogElement;

  const themes: { id: Theme; label: Key }[] = [
    { id: "system", label: "settings.themeSystem" },
    { id: "light", label: "settings.themeLight" },
    { id: "dark", label: "settings.themeDark" },
  ];
  // Each language is named in itself, so it can be found whatever the UI language
  const languages: { id: Lang; label: string }[] = [
    { id: "en", label: "English" },
    { id: "zh", label: "简体中文" },
  ];

  const coarse = matchMedia("(pointer: coarse)").matches;
  // As in Photoshop, so the keys a Photoshop user reaches for do the same here
  const shortcuts: [string | Key, Key][] = [
    ["V  M  L  B  E", "key.tools"],
    ["key.shiftDrag", "key.add"],
    ["key.altDrag", "key.subtract"],
    ["key.bothDrag", "key.intersect"],
    ["key.marqueeDrag", "key.constrain"],
    ["key.polygonTool", "key.polygon"],
    ["[  ]  X", "key.brush"],
    [`${modKey}A  ${modKey}D`, "key.selectAll"],
    [`${modKey}C`, "key.copy"],
    ["key.rightClick", "key.canvasMenu"],
    ["Delete", "key.delete"],
    ["↑ ↓ ← →", "key.nudge"],
    ["Esc", "key.escape"],
    [undoKey, "key.undo"],
    [redoKey, "key.redo"],
    ["C", "key.compare"],
    ["key.wheel", "key.scroll"],
    ["key.altWheel", "key.zoomWheel"],
    ["key.spaceDrag", "key.pan"],
    [`${modKey}0  ${modKey}1  ${modKey}+  ${modKey}−`, "key.zoom"],
    ["PageUp  PageDown  Home  End", "key.page"],
    ["↑ ↓ ← →", "key.nav"],
    [submitKey, "key.submit"],
  ];
  const params = { alt: altKey, mod: modKey.replace(/\+$/, "") };
  const keyLabel = (k: string) => (i18n.has(k) ? t(k, params) : k);

  onMount(() => {
    dialog.showModal();
    void refreshStorage();
  });

  async function refreshStorage() {
    try {
      storage = (await backend.storage?.()) ?? null;
    } catch {
      storage = null;
    }
  }

  function size(bytes: number): string {
    if (bytes >= 1024 ** 3) return t("settings.size.gb", { n: (bytes / 1024 ** 3).toFixed(1) });
    if (bytes >= 1024 ** 2) return t("settings.size.mb", { n: Math.round(bytes / 1024 ** 2) });
    return t("settings.size.kb", { n: Math.max(1, Math.round(bytes / 1024)) });
  }

  /** what the form holds, as the backend takes it */
  function pending(): { api_key?: string; base_url?: string; remember?: boolean } {
    const body: { api_key?: string; base_url?: string; remember?: boolean } = {};
    if (apiKey.trim() && settings.api_key_source !== "env") body.api_key = apiKey.trim();
    if (settings.base_url_source !== "env") body.base_url = baseUrl.trim();
    if (browser) body.remember = remember;
    return body;
  }

  async function persist(): Promise<void> {
    const body = pending();
    app.config = { ...app.config!, settings: await backend.saveSettings(body) };
    apiKey = "";
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    saving = true;
    error = "";
    try {
      await persist();
      dialog.close();
      app.notify(t("settings.saved"));
    } catch (err) {
      error = errorText(err);
    } finally {
      saving = false;
    }
  }

  /** browser build: save what is typed, then ask the service whether the key works */
  async function check() {
    testing = true;
    test = null;
    error = "";
    try {
      await persist();
      await backend.testConnection!();
      test = { ok: true, text: t("settings.testOk") };
    } catch (err) {
      test = { ok: false, text: t("settings.testFailed", { error: errorText(err) }) };
    } finally {
      testing = false;
    }
  }

  async function removeKey() {
    error = "";
    try {
      app.config = { ...app.config!, settings: await backend.saveSettings({ api_key: "" }) };
      test = null;
    } catch (err) {
      error = errorText(err);
    }
  }

  async function keepData() {
    persistDenied = false;
    const granted = (await backend.persistStorage?.()) ?? false;
    persistDenied = !granted;
    await refreshStorage();
  }
</script>

<dialog bind:this={dialog} onclose={() => (app.settingsOpen = false)} aria-labelledby="settings-title">
  <form onsubmit={save}>
    <h2 id="settings-title">{t("settings.title")}</h2>

    <fieldset>
      <legend>{t("settings.api")}</legend>
      <p class="help">{browser ? t("settings.apiHelpBrowser") : t("settings.apiHelp")}</p>
      <label>
        <span>{t("settings.key")}</span>
        {#if settings.api_key_source === "env"}
          <input value={t("settings.keyFromEnv")} disabled />
        {:else}
          <input
            type="password"
            autocomplete="off"
            bind:value={apiKey}
            placeholder={settings.api_key_set ? t("settings.keySaved") : "sk-…"}
          />
        {/if}
      </label>
      {#if browser}
        <label class="check">
          <input type="checkbox" bind:checked={remember} />
          <span>{t("settings.remember")}</span>
        </label>
        <small class="under-check">{t("settings.rememberHelp")}</small>
      {/if}
      <label>
        <span>{t("settings.baseUrl")}</span>
        <input
          bind:value={baseUrl}
          disabled={settings.base_url_source === "env"}
          placeholder="https://api.openai.com/v1"
          autocomplete="off"
          spellcheck="false"
        />
        <small>{browser ? t("settings.baseUrlHelpBrowser") : t("settings.baseUrlHelp")}</small>
      </label>
      {#if browser}
        <div class="test">
          <button type="button" disabled={testing || (!apiKey.trim() && !settings.api_key_set)} onclick={check}>
            {testing ? t("settings.testing") : t("settings.test")}
          </button>
          {#if settings.api_key_set}
            <button type="button" class="quiet" onclick={removeKey}>{t("settings.removeKey")}</button>
          {/if}
        </div>
        {#if test}<p class={test.ok ? "ok" : "error"} role="status">{test.text}</p>{/if}
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </fieldset>

    <fieldset>
      <legend>{t("settings.appearance")}</legend>
      <div class="row">
        <span class="row-label" id="theme-label">{t("settings.theme")}</span>
        <div class="segmented" role="radiogroup" aria-labelledby="theme-label">
          {#each themes as theme (theme.id)}
            <button
              type="button"
              role="radio"
              aria-checked={app.theme === theme.id}
              class:on={app.theme === theme.id}
              onclick={() => app.setTheme(theme.id)}
            >
              {t(theme.label)}
            </button>
          {/each}
        </div>
      </div>
      <div class="row">
        <span class="row-label" id="lang-label">{t("settings.language")}</span>
        <div class="segmented" role="radiogroup" aria-labelledby="lang-label">
          {#each languages as lang (lang.id)}
            <button
              type="button"
              role="radio"
              lang={lang.id === "zh" ? "zh-CN" : "en"}
              aria-checked={i18n.lang === lang.id}
              class:on={i18n.lang === lang.id}
              onclick={() => i18n.setLang(lang.id)}
            >
              {lang.label}
            </button>
          {/each}
        </div>
      </div>
    </fieldset>

    {#if !coarse}
      <fieldset>
        <legend>{t("settings.canvas")}</legend>
        <label class="check">
          <input type="checkbox" bind:checked={app.wheelZoom} onchange={() => app.persistPrefs()} />
          <span>{t("settings.wheelZoom")}</span>
        </label>
        <small class="under-check">{t("settings.wheelZoomHelp", params)}</small>
      </fieldset>
    {/if}

    {#if browser}
      <fieldset>
        <legend>{t("settings.data")}</legend>
        <p class="help">{t("settings.dataHelp")}</p>
        {#if storage}
          <div class="row">
            <span class="row-label">{t("settings.storage")}</span>
            <span>
              {storage.quota ? t("settings.storageUsed", { used: size(storage.used), quota: size(storage.quota) }) : t("settings.storageUsedOnly", { used: size(storage.used) })}
            </span>
          </div>
          <div class="persist">
            <button type="button" disabled={storage.persistent} onclick={keepData}>{t("settings.persist")}</button>
            <small>{storage.persistent ? t("settings.persistOn") : persistDenied ? t("settings.persistDenied") : t("settings.persistOff")}</small>
          </div>
        {/if}
      </fieldset>
    {/if}

    {#if !coarse}
      <details class="keys">
        <summary>{t("settings.shortcuts")}</summary>
        <dl>
          {#each shortcuts as [keys, desc] (desc)}
            <dt>{keyLabel(keys)}</dt>
            <dd>{t(desc, params)}</dd>
          {/each}
        </dl>
      </details>
    {/if}

    <dl class="about">
      {#if !browser}
        <dt>{t("settings.workspace")}</dt>
        <dd><code>{app.config!.home}</code></dd>
        <dt>{t("settings.envFile")}</dt>
        <dd><code>{settings.env_file}</code></dd>
      {/if}
      <dt>{t("settings.version")}</dt>
      <dd>brushgraft {app.config!.version}, promptbrush {app.config!.promptbrush_version}</dd>
    </dl>

    <div class="actions">
      <button type="button" onclick={() => dialog.close()}>{t("common.cancel")}</button>
      <button class="primary" type="submit" disabled={saving}>{saving ? t("common.saving") : t("common.save")}</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: min(480px, calc(100vw - 24px));
    max-height: calc(100dvh - 24px);
    padding: 0;
    border: 1px solid var(--rule-2);
    border-radius: var(--r-m);
    background: var(--panel);
    color: var(--ink);
    box-shadow: var(--shadow-pop);
  }

  dialog::backdrop {
    background: var(--scrim);
  }

  form {
    display: grid;
    gap: 18px;
    padding: 18px 20px 16px;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-l);
    font-weight: 600;
  }

  fieldset {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    padding: 0;
    margin-bottom: 2px;
    font-weight: 600;
  }

  label {
    display: grid;
    gap: 4px;
  }

  label > span {
    color: var(--ink-2);
    font-size: var(--fs-s);
  }

  small,
  .help {
    margin: 0;
    color: var(--ink-3);
    font-size: var(--fs-s);
  }

  code {
    font: inherit;
    word-break: break-all;
  }

  .error {
    margin: 0;
    color: var(--danger);
  }

  .ok {
    margin: 0;
    color: var(--ok);
  }

  .check {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .check > span {
    color: var(--ink);
    font-size: inherit;
  }

  .under-check {
    margin-top: -6px;
    padding-left: 24px;
  }

  .test,
  .persist {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .row {
    display: grid;
    grid-template-columns: 5.5em minmax(0, 1fr);
    align-items: center;
    gap: 8px;
  }

  .row-label {
    color: var(--ink-2);
    font-size: var(--fs-s);
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
    min-height: 26px;
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

  .keys summary {
    cursor: pointer;
    font-weight: 600;
  }

  .keys dl {
    display: grid;
    grid-template-columns: 9em minmax(0, 1fr);
    gap: 3px 10px;
    margin: 8px 0 0;
    font-size: var(--fs-s);
  }

  .keys dt {
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  .keys dd {
    margin: 0;
    color: var(--ink-2);
  }

  .about {
    display: grid;
    grid-template-columns: 5.5em minmax(0, 1fr);
    gap: 4px 8px;
    margin: 0;
    padding-top: 14px;
    border-top: 1px solid var(--rule);
    color: var(--ink-2);
    font-size: var(--fs-s);
  }

  .about dd {
    margin: 0;
  }

  /* the dialog scrolls on a short screen; Cancel and Save stay in view at its bottom edge */
  .actions {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin: 0 -20px -16px;
    padding: 12px 20px calc(16px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--rule);
    background: var(--panel);
  }
</style>
