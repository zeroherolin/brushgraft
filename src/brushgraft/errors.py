"""Errors that reach the user.

Each error carries a stable ``code`` and ``params`` so the web UI can show it
in the user's language; ``str(error)`` is the English text for logs, scripts
and anything that does not know the code.
"""


class UserError(ValueError):
    """The request can't be carried out as asked; answered with HTTP 400."""

    def __init__(self, code: str, message: str, **params: object):
        super().__init__(message)
        self.code = code
        self.params = params


class NotFound(LookupError):
    """A project, version, job or image that does not exist; HTTP 404."""

    def __init__(self, what: str, ident: str):
        super().__init__(f"{what} {ident} not found")
        self.code = "not_found"
        self.params = {"what": what}
