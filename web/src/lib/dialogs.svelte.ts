// In-app confirm and prompt dialogs, replacing the browser's own.

import { t } from "./i18n.svelte";

export interface DialogRequest {
  kind: "confirm" | "prompt";
  title: string;
  message?: string;
  label?: string;
  value?: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (value: string | boolean | null) => void;
}

class Dialogs {
  current = $state<DialogRequest | null>(null);

  confirm(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      this.#open({ kind: "confirm", confirmLabel: t("common.ok"), ...opts, resolve: (v) => resolve(v === true) });
    });
  }

  prompt(opts: { title: string; label: string; value?: string; confirmLabel?: string }): Promise<string | null> {
    return new Promise((resolve) => {
      this.#open({
        kind: "prompt",
        confirmLabel: t("common.ok"),
        ...opts,
        resolve: (v) => resolve(typeof v === "string" ? v : null),
      });
    });
  }

  close(value: string | boolean | null): void {
    const req = this.current;
    this.current = null;
    req?.resolve(value);
  }

  #open(req: DialogRequest): void {
    this.current?.resolve(null);
    this.current = req;
  }
}

export const dialogs = new Dialogs();
