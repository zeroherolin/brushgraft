import { describe, expect, it } from "vitest";
import { describeJobError } from "./joberror";

const api = (detail: string) => describeJobError({ code: "api_error", detail, variant: "" });
const net = (detail: string) => describeJobError({ code: "network", detail, variant: "" });

// the bodies are what a relay sent back (2026-10)
describe("errors from the image API", () => {
  it("names the status and leaves out an empty message", () => {
    expect(api('HTTP 500: {"error":{"message":"","localized_message":"","type":"fastapi_error","param":"","code":-1}}')).toEqual({
      kind: "server",
      code: "HTTP 500",
      service: "",
    });
  });

  it("tells a model nobody serves apart from a service that is down", () => {
    const noChannel = api(
      'HTTP 503: {"error":{"message":"Current group default has no available channels for model gpt-image-9 under billing mode [pay-as-you-go] (request id: 2026101816)","type":"shell_api_error"}}',
    );
    expect(noChannel).toEqual({ kind: "noChannel", code: "HTTP 503", service: "" });
    expect(api("HTTP 503: Service Unavailable").kind).toBe("unavailable");
  });

  it("knows the usual statuses", () => {
    const kinds = Object.fromEntries([401, 402, 403, 404, 400, 422, 429, 451, 502, 504, 520, 524, 530].map((s) => [s, api(`HTTP ${s}: x`).kind]));
    expect(kinds).toEqual({
      401: "auth", 402: "payment", 403: "forbidden", 404: "notFound", 400: "badRequest", 422: "badRequest", 429: "rateLimited",
      451: "moderated", 502: "unavailable", 504: "unavailable", 520: "cloudflare", 524: "timeout524", 530: "server",
    });
  });

  it("passes on what the service said when it explains the refusal, without its request id", () => {
    const d = api('HTTP 400: {"error":{"message":"Invalid size \'1000x1000\' (request id: abc123)","type":"invalid_request_error"}}');
    expect(d).toEqual({ kind: "badRequest", code: "HTTP 400", service: "Invalid size '1000x1000'" });
    expect(api('HTTP 403: {"error":"insufficient quota"}').service).toBe("insufficient quota");
  });

  it("reads a message cut short when it was stored", () => {
    expect(api('HTTP 400: {"error":{"message":"Your request was rejected because \\"size\\" is wrong","type":"invalid_req…').service).toBe(
      'Your request was rejected because "size" is wrong',
    );
  });

  it("says nothing of an HTML error page (Cloudflare's 502)", () => {
    expect(api('HTTP 502: <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US">')).toEqual({
      kind: "unavailable",
      code: "HTTP 502",
      service: "",
    });
  });

  it("takes a web page for the API as a base URL without /v1", () => {
    expect(api('Response is not valid JSON: <!doctype html><html lang="zh-cn"><head>')).toEqual({ kind: "webPage", code: "HTTP 200", service: "" });
    expect(api("Unexpected response format: [1, 2]").kind).toBe("badResponse");
  });

  it("unwraps the upstream's message a relay wrapped in its own", () => {
    const d = describeJobError({
      code: "prompt_too_long",
      detail:
        'HTTP 413: {"error":{"message":"{\\"detail\\":{\\"message\\":\\"你提交的消息过长，请编辑后重新发送。\\",\\"code\\":\\"input_too_large\\"}}（traceid: 65af6d）","localized_message":"Unknown error","type":"server_error"}}',
      variant: "",
    });
    expect(d).toEqual({ kind: "tooLong", code: "HTTP 413", service: "" });
    expect(api('HTTP 400: {"error":{"message":"{\\"detail\\":{\\"message\\":\\"bad mask\\"}}"}}').service).toBe("bad mask");
  });

  it("keeps the status of a moderation block that didn't come as 451", () => {
    const d = describeJobError({ code: "moderated", detail: 'HTTP 400: {"error":{"code":"moderation_blocked","message":"blocked"}}', variant: "" });
    expect(d).toEqual({ kind: "moderated", code: "HTTP 400", service: "" });
  });

  it("reports an error field in a 200 answer with its message", () => {
    expect(api('API returned an error: {"message": "model overloaded"}')).toEqual({ kind: "api", code: "HTTP 200", service: "model overloaded" });
    expect(api("something else").code).toBe("api_error");
  });
});

describe("network failures", () => {
  it("are told apart by what the library said", () => {
    expect(net("ReadTimeout: HTTPSConnectionPool(host='x', port=443): Read timed out. (read timeout=360)").kind).toBe("timeout");
    expect(net("ConnectionError: ('Connection aborted.', TimeoutError('The write operation timed out'))").kind).toBe("timeout");
    expect(net("ConnectionError: Failed to resolve 'api.exmaple.com' ([Errno 8] nodename nor servname provided)").kind).toBe("dns");
    expect(net("SSLError: HTTPSConnectionPool(host='x', port=443): Max retries exceeded (Caused by SSLError(SSLEOFError(8, 'EOF')))").kind).toBe("tls");
    expect(net("ProxyError: Unable to connect to proxy").kind).toBe("proxy");
    expect(net("ConnectionError: [Errno 61] Connection refused").kind).toBe("connect");
    expect(net("Failed to fetch").kind).toBe("fetch");
    expect(net("signal is aborted without reason").kind).toBe("timeout");
    expect(net("x").code).toBe("network");
  });
});

describe("other codes", () => {
  it("show brushgraft's own code", () => {
    for (const code of ["no_image", "image_unreachable", "storage_full", "save_failed", "internal", "interrupted"]) {
      expect(describeJobError({ code, detail: "", variant: "" })).toEqual({ kind: code, code, service: "" });
    }
    expect(describeJobError({ code: "from_the_future", detail: "", variant: "" })).toEqual({ kind: "unknown", code: "from_the_future", service: "" });
  });
});
