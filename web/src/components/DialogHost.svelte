<script lang="ts">
  import { tick } from "svelte";
  import { dialogs } from "../lib/dialogs.svelte";
  import { t } from "../lib/i18n.svelte";

  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let value = $state("");

  $effect(() => {
    const req = dialogs.current;
    if (!req || !dialog) return;
    value = req.value ?? "";
    if (!dialog.open) dialog.showModal();
    void tick().then(() => {
      input?.focus();
      input?.select();
    });
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const req = dialogs.current;
    if (!req) return;
    if (req.kind === "prompt" && !value.trim()) return;
    dialog?.close();
    dialogs.close(req.kind === "prompt" ? value : true);
  }

  function cancel() {
    dialog?.close();
    if (dialogs.current) dialogs.close(null);
  }
</script>

{#if dialogs.current}
  {@const req = dialogs.current}
  <dialog bind:this={dialog} oncancel={cancel} aria-labelledby="dialog-title">
    <form onsubmit={submit}>
      <h2 id="dialog-title">{req.title}</h2>
      {#if req.message}<p>{req.message}</p>{/if}
      {#if req.kind === "prompt"}
        <label>
          <span>{req.label}</span>
          <input bind:this={input} bind:value maxlength="100" />
        </label>
      {/if}
      <div class="actions">
        <button type="button" onclick={cancel}>{t("common.cancel")}</button>
        <button type="submit" class={req.danger ? "danger-solid" : "primary"}>{req.confirmLabel}</button>
      </div>
    </form>
  </dialog>
{/if}

<style>
  dialog {
    width: min(400px, calc(100vw - 32px));
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
    gap: 12px;
    padding: 18px 20px 16px;
  }

  h2 {
    margin: 0;
    font-size: var(--fs-l);
    font-weight: 600;
  }

  p {
    margin: 0;
    color: var(--ink-2);
  }

  label {
    display: grid;
    gap: 6px;
  }

  label span {
    color: var(--ink-2);
    font-size: var(--fs-s);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  .danger-solid {
    border-color: var(--danger);
    background: var(--danger);
    color: var(--panel);
    font-weight: 600;
  }

  .danger-solid:hover {
    background: color-mix(in srgb, var(--danger) 88%, var(--ink));
  }
</style>
