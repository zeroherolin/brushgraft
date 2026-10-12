"""Workspace location, access token, single-instance lock and API settings."""

import os
import re
import secrets
from pathlib import Path

import promptbrush as pb

from brushgraft.errors import UserError

# Within one source BRUSHGRAFT_ wins; PROMPTBRUSH_ is accepted so an existing
# promptbrush setup works as is.
ENV_PREFIXES = ("BRUSHGRAFT_", "PROMPTBRUSH_")
DEFAULT_HOME = Path("~/brushgraft")
TOKEN_FILE = ".token"
LOCK_FILE = ".lock"


def default_home() -> Path:
    """The workspace: ``$BRUSHGRAFT_HOME``, or ~/brushgraft."""
    return Path(os.environ.get("BRUSHGRAFT_HOME") or DEFAULT_HOME).expanduser()


class AlreadyRunning(RuntimeError):
    pass


def lock_home(home: Path):
    """Take exclusive use of the workspace; keep the returned file open.

    Two instances on one workspace get in each other's way: the second marks
    the first one's running jobs as interrupted, and its image cleanup can
    delete a result the first has saved but not yet recorded.
    """
    handle = open(home / LOCK_FILE, "a+")
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise AlreadyRunning(
            f"{home} is in use by another brushgraft; close it first, "
            "or pick another workspace with --dir") from None
    return handle


def load_or_create_token(home: Path) -> str:
    """Read the access token from the workspace, creating it on first run.

    The token survives restarts so bookmarks keep working.
    """
    path = home / TOKEN_FILE
    if path.exists():
        token = path.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    _write_private(path, token + "\n")
    return token


def _write_private(path: Path, text: str) -> None:
    """Write a file only the current user can read and write (0600)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, 0o600)  # os.open keeps the mode of an existing file


class Settings:
    """API key and base URL: environment variables win over the env file."""

    def __init__(self, env_file: Path):
        self.env_file = env_file

    def lookup(self, name: str) -> tuple[str, str]:
        """Return (value, source); source is "env", "file" or "" (unset)."""
        for prefix in ENV_PREFIXES:
            if value := os.environ.get(prefix + name, "").strip():
                return value, "env"
        values = self._read()
        for prefix in ENV_PREFIXES:
            if value := values.get(prefix + name, "").strip():
                return value, "file"
        return "", ""

    def _read(self) -> dict[str, str]:
        try:
            return pb.read_env_file(self.env_file)
        except (ValueError, OSError) as exc:
            raise UserError("env_file_unreadable",
                            f"Can't read {self.env_file}: {exc}",
                            path=str(self.env_file)) from None

    @property
    def api_key(self) -> str:
        return self.lookup("API_KEY")[0]

    @property
    def base_url(self) -> str:
        return self.lookup("BASE_URL")[0] or pb.DEFAULT_BASE_URL

    def save(self, *, api_key: str | None = None,
             base_url: str | None = None) -> None:
        """Write the BRUSHGRAFT_ entries of the env file, keeping other lines.

        An empty string removes the entry, under PROMPTBRUSH_ too (lookup would fall
        back to it); None leaves it alone.
        """
        updates = {k: v for k, v in (("BRUSHGRAFT_API_KEY", api_key),
                                     ("BRUSHGRAFT_BASE_URL", base_url))
                   if v is not None}
        for key, value in updates.items():
            if re.search(r"[\s\"'#\\]", value):
                raise UserError(
                    "invalid_setting",
                    f"{key} can't contain whitespace, quotes, # or backslashes",
                    key=key)
        lines = []
        if self.env_file.exists():
            self._read()  # refuse to rewrite a file we can't decode
            lines = pb.read_text_file(self.env_file).splitlines()
        pattern = re.compile(r"^\ufeff?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
        dropped = set(updates) | {prefix + key.removeprefix("BRUSHGRAFT_")
                                  for key, value in updates.items() if not value
                                  for prefix in ENV_PREFIXES}
        kept = [line for line in lines
                if not ((m := pattern.match(line)) and m.group(1) in dropped)]
        kept += [f"{k}={v}" for k, v in updates.items() if v]
        self.env_file.parent.mkdir(parents=True, exist_ok=True)
        _write_private(self.env_file, "\n".join(kept) + "\n")
