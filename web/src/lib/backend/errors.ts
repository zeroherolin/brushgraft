// Errors that reach the user. Both backends throw ApiError: the server's JSON
// errors become one in ServerBackend, and BrowserBackend raises the same codes
// itself, so the UI shows the same message whichever mode it runs in.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** stable error code, see error.* in the locales */
    readonly code = "",
    readonly params: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

/** The request can't be carried out as asked (the server's HTTP 400). ``message`` is the English text. */
export const userError = (code: string, message: string, params: Record<string, string | number> = {}) =>
  new ApiError(message, 400, code, params);

/** A project, version, job or image that doesn't exist (HTTP 404). */
export const notFound = (what: string, ident: string) =>
  new ApiError(`${what} ${ident} not found`, 404, "not_found", { what });
