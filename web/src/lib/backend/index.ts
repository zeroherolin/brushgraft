// The backend this build talks to. __BROWSER__ is a build-time constant, so each
// build bundles only its own backend.

import { BrowserBackend } from "./browser/backend";
import { ServerBackend } from "./server";
import type { Backend } from "./types";

export const backend: Backend = __BROWSER__ ? new BrowserBackend() : new ServerBackend();
export { ApiError } from "./errors";
export type { JobRequest } from "./types";
