"""Command-line entry: start the local server and open the browser."""

import argparse
import contextlib
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from brushgraft import __version__
from brushgraft.app import LOOPBACK_HOSTS, create_app
from brushgraft.config import (AlreadyRunning, Settings, default_home, load_or_create_token,
                               lock_home)
from brushgraft.store import Store

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 7788


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="brushgraft",
        description="Start the local image version-tree editor and open it in a browser.",
    )
    parser.add_argument(
        "--dir", type=Path, metavar="DIR",
        help="workspace for projects and images "
             "(default: $BRUSHGRAFT_HOME or ~/brushgraft)")
    parser.add_argument(
        "--env-file", type=Path, metavar="PATH",
        help="file to read API settings from (default: .env in the workspace)")
    parser.add_argument(
        "--host", default=DEFAULT_HOST,
        help=f"address to listen on (default: {DEFAULT_HOST}, this computer only); "
             "0.0.0.0 lets devices on your network connect, still with the token")
    parser.add_argument(
        "--port", type=int, default=DEFAULT_PORT,
        help=f"port (default: {DEFAULT_PORT}; a free port is picked if it's taken)")
    parser.add_argument(
        "--no-browser", action="store_true", help="don't open a browser")
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}")
    return parser


_WILDCARD_HOSTS = ("0.0.0.0", "::", "")


def _links(host: str, port: int, token: str) -> tuple[str, str | None]:
    """The link to open on this computer, and for a wildcard bind the link other
    devices use. A wildcard (0.0.0.0) isn't an address anyone can browse to, so
    this computer uses the loopback address and the others get a placeholder
    (the machine's own address depends on which network they share)."""
    query = f"/?token={token}"
    if host in _WILDCARD_HOSTS:
        local = f"http://{'[::1]' if host == '::' else '127.0.0.1'}:{port}{query}"
        return local, f"http://<this computer's address>:{port}{query}"
    shown = "127.0.0.1" if host in ("127.0.0.1", "localhost") else host
    if ":" in shown:
        shown = f"[{shown}]"
    return f"http://{shown}:{port}{query}", None


class _Server(uvicorn.Server):
    """End the event streams first on shutdown; open streams would stall it. A Ctrl+C or
    SIGTERM stops the server and nothing more: uvicorn raises it again once stopped, which
    would end the process before the requests in flight (already billed) are saved."""

    def __init__(self, config: uvicorn.Config, on_shutdown):
        super().__init__(config)
        self._on_shutdown = on_shutdown

    @contextlib.contextmanager
    def capture_signals(self):
        with super().capture_signals():
            yield
            self._captured_signals.clear()

    async def shutdown(self, sockets=None) -> None:
        self._on_shutdown()
        await super().shutdown(sockets=sockets)


def _listening(family: int, port: int) -> bool:
    """Whether a server answers on the port, on this computer."""
    probe = socket.socket(family, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(("::1" if family == socket.AF_INET6 else "127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def _bind(host: str, port: int) -> socket.socket:
    """Bind the port, or a free one picked by the OS when a server answers on it.

    The server is asked for first: a failed bind doesn't always tell, as macOS and Windows let
    a socket share the port with a server on another address (127.0.0.1 next to 0.0.0.0), and
    the link printed would reach that server. SO_REUSEADDR lets a restart take its port back
    while the previous run's connections wait out TIME_WAIT (on Linux only if that run set it
    too, so it is always set); on Windows it would take the port of a running server, so not
    there.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    for candidate in (0,) if port and _listening(family, port) else (port, 0):
        sock = socket.socket(family, socket.SOCK_STREAM)
        if sys.platform != "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, candidate))
            return sock
        except OSError:
            sock.close()
            if candidate == 0:
                raise
    raise AssertionError("unreachable")


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    home = (args.dir or default_home()).expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    try:
        _lock = lock_home(home)  # held until the process exits
    except AlreadyRunning as exc:
        sys.exit(f"brushgraft: {exc}")
    store = Store(home)
    if recovered := store.recover_interrupted():
        print(f"{recovered} unfinished job(s) from the last run marked as interrupted",
              file=sys.stderr)
    store.collect_garbage()
    settings = Settings((args.env_file or home / ".env").expanduser())
    token = load_or_create_token(home)

    loopback = args.host in ("127.0.0.1", "localhost", "::1")
    app = create_app(store, settings, token,
                     allowed_hosts=LOOPBACK_HOSTS if loopback else None)
    sock = _bind(args.host, args.port)
    port = sock.getsockname()[1]
    url, network_url = _links(args.host, port, token)

    print(f"brushgraft {__version__}")
    print(f"  workspace  {home}")
    print(f"  open       {url}")
    if network_url:
        print(f"  network    {network_url}")
    if not settings.api_key:
        print(f"  API key not set: add it in Settings in the web UI, or in {settings.env_file}")
    print("Press Ctrl+C to quit", flush=True)

    server = _Server(uvicorn.Config(app, log_level="warning",
                                    timeout_graceful_shutdown=5),
                     on_shutdown=app.state.bus.close)
    if not args.no_browser:
        def open_when_ready() -> None:
            while not server.started and not server.should_exit:
                time.sleep(0.05)
            if server.started:
                webbrowser.open(url)
        threading.Thread(target=open_when_ready, daemon=True).start()

    server.run(sockets=[sock])
    if active := app.state.runner.active:
        # Requests already sent are most likely billed: their results get saved first, with
        # the workspace still locked (a second instance would mark the jobs interrupted)
        print(f"Waiting for {active} request(s) in progress to finish and be saved… "
              "(press Ctrl+C again to discard them)", file=sys.stderr, flush=True)
        try:
            app.state.runner.wait()
        except KeyboardInterrupt:
            os._exit(130)  # the pool's threads would still be waited for on a normal exit
    store.close()
    _lock.close()
