// What went wrong with a request, worked out from a stored job error (its code and the raw text
// the API or the network gave): the kind of problem, the code to show (the HTTP status when there
// is one), and the service's own message when it says something the kind doesn't.

import type { JobError } from "./types";

export type Kind =
  | "auth" | "payment" | "forbidden" | "notFound" | "badRequest" | "tooLong" | "rateLimited"
  | "moderated" | "noChannel" | "server" | "unavailable" | "timeout524" | "cloudflare"
  | "webPage" | "badResponse" | "api"
  | "timeout" | "dns" | "tls" | "proxy" | "connect" | "fetch"
  | "no_image" | "image_unreachable" | "storage_full" | "save_failed" | "internal" | "interrupted"
  | "unknown";

export interface Described {
  kind: Kind;
  /** "HTTP 503", or brushgraft's error code when no status came back */
  code: string;
  /** what the service itself said, cleaned up; "" when it said nothing useful */
  service: string;
}

/** kinds whose own text says all the service's message would */
const SAYS_IT_ALL = new Set<Kind>(["auth", "tooLong", "rateLimited", "moderated", "noChannel", "webPage", "timeout524"]);
const SERVICE_MAX = 120;

function byStatus(status: number, body: string): Kind {
  if (status === 401) return "auth";
  if (status === 402) return "payment";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 413) return "tooLong";
  if (status === 429) return "rateLimited";
  if (status === 451) return "moderated";
  if (status === 524) return "timeout524";
  if (status >= 520 && status <= 527) return "cloudflare";
  // the usual relay (one-api / new-api) when no upstream serves the model right now
  if (status === 503 && /no available channel/i.test(body)) return "noChannel";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  if (status >= 500) return "server";
  if (status >= 400) return "badRequest";
  return "api";
}

/** A network failure, by the words the HTTP library or the browser used. */
function networkKind(detail: string): Kind {
  if (/timed? ?out|timeout|aborted without reason|operation was aborted/i.test(detail)) return "timeout";
  if (/failed to resolve|name or service not known|nodename nor servname|getaddrinfo|ENOTFOUND|name resolution/i.test(detail)) return "dns";
  if (/\bSSL|certificate|TLS/i.test(detail)) return "tls";
  if (/proxy/i.test(detail)) return "proxy";
  if (/failed to fetch|load failed|networkerror when attempting/i.test(detail)) return "fetch";
  return "connect";
}

const unescape = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
};

/** The message in an error body: {"error": {"message"}}, {"error": "..."}, {"message"}, {"detail"}. */
function messageIn(body: string, depth = 0): string {
  const text = body.trim();
  if (!text) return "";
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      const err = o.error;
      const candidates = [
        typeof err === "object" && err ? (err as Record<string, unknown>).message : err,
        o.message,
        typeof o.detail === "object" && o.detail ? (o.detail as Record<string, unknown>).message : o.detail,
        o.msg,
      ];
      const found = candidates.find((c): c is string => typeof c === "string" && !!c.trim()) ?? "";
      // some relays wrap the upstream's JSON in their message
      if (depth < 2 && /^\s*\{/.test(found)) {
        const inner = messageIn(found.replace(/[（(][^）)]*[）)]\s*$/, ""), depth + 1);
        if (inner) return inner;
      }
      return found;
    } catch {
      // cut short when it was stored: take the first message by hand
      const m = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)+)"/);
      return m ? unescape(m[1]) : "";
    }
  }
  if (/^<!doctype|^<html/i.test(text)) return ""; // an error page: its HTML says nothing readable
  return text;
}

function clean(message: string): string {
  let m = message
    .replace(/[（(]\s*(request id|request_id|traceid|trace id)\s*[:：][^）)]*[）)]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(unknown error|error|internal server error)\.?$/i.test(m)) m = "";
  return m.length <= SERVICE_MAX ? m : `${m.slice(0, SERVICE_MAX)}…`;
}

export function describeJobError(error: JobError): Described {
  const detail = error.detail ?? "";
  const http = detail.match(/^HTTP (\d{3})\b:?\s*([\s\S]*)$/);
  // these come only with a 200: any other status is reported as "HTTP <status>: ..." first
  const answered = /^(Response is not valid JSON|Unexpected response format|API returned an error)/i.test(detail);
  const status = http ? Number(http[1]) : answered ? 200 : 0;
  const code = status ? `HTTP ${status}` : error.code;
  let kind: Kind;
  let body = http ? http[2] : "";
  switch (error.code) {
    case "moderated":
      kind = "moderated";
      break;
    case "prompt_too_long":
      kind = "tooLong";
      break;
    case "network":
      return { kind: networkKind(detail), code, service: "" };
    case "api_error":
      if (http) {
        kind = byStatus(status, body);
      } else if (/^Response is not valid JSON/i.test(detail)) {
        kind = /<!doctype|<html/i.test(detail) ? "webPage" : "badResponse";
      } else if (/^Unexpected response format/i.test(detail)) {
        kind = "badResponse";
      } else {
        kind = "api";
        body = detail.replace(/^API returned an error:\s*/i, "");
      }
      break;
    case "no_image":
    case "image_unreachable":
    case "storage_full":
    case "save_failed":
    case "internal":
    case "interrupted":
      return { kind: error.code as Kind, code, service: "" };
    default:
      return { kind: "unknown", code, service: "" };
  }
  const service = SAYS_IT_ALL.has(kind) ? "" : clean(messageIn(body));
  return { kind, code, service };
}
