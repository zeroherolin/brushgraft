#!/usr/bin/env python3
"""Install the brushgraft web site on a server that runs Caddy. Runs on the server.

Standard library only (Python 3.9+). ``deploy.py`` builds the site from the checkout and calls
this; on its own, it installs a site that is already built. It owns one directory and one Caddy
file, and nothing else:

    /srv/brushgraft/releases/<id>/   every published version of the site
    /srv/brushgraft/current          a symlink to the live release (the switch is atomic)
    /etc/caddy/sites-enabled/brushgraft.caddy

It does not manage the main Caddyfile. It checks that the main Caddyfile imports
``sites-enabled/*.caddy`` (or this file) and adds that one line when the file is free to edit;
a file whose first line says another tool manages it is left alone, with instructions.

    install.py install --src DIR --domain brush.example.com
    install.py rollback
    install.py uninstall [--purge]
"""

import argparse
import fnmatch
import hashlib
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path('/srv/brushgraft')
MAIN = Path('/etc/caddy/Caddyfile')
SITE_FILE = Path('/etc/caddy/sites-enabled/brushgraft.caddy')
KEEP_RELEASES = 5

# What the page may do: run its own scripts (and its image Worker), show images from itself and from
# blob: URLs it made, and call HTTPS image services (and a service on this computer, for people who
# run one). It can't load anything else, and nothing can embed it.
CSP = "; ".join([
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "worker-src 'self'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
])

HOSTNAME = re.compile(r'^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')


def site_block(domain, root=ROOT):
    """The Caddy site for ``domain``: static files from ``root/current``, with strict headers."""
    if not HOSTNAME.match(domain):
        raise ValueError(f'Not a host name: {domain!r}')
    return f'''# Managed by brushgraft's deploy/install.py: re-run the deployer, don't edit by hand.
{domain} {{
    root * {root}/current
    encode zstd gzip
    header {{
        Content-Security-Policy "{CSP}"
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
        Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
        Cross-Origin-Opener-Policy same-origin
        -Server
    }}
    # Built files carry a hash in their name and never change; the page itself always revalidates.
    # Only files that exist get the year-long lifetime: a 404 must not be remembered.
    @assets {{
        path /assets/*
        file
    }}
    header @assets Cache-Control "public, max-age=31536000, immutable"
    @pages not path /assets/*
    header @pages Cache-Control "no-cache"
    file_server
}}
'''


def import_line(site_file=SITE_FILE):
    return f'import {site_file}'


def has_import(text, main, site_file):
    """Whether an ``import`` at the top level of ``text`` loads ``site_file``."""
    depth = 0
    for line in text.splitlines():
        parts = shlex.split(line, comments=True)
        if depth == 0 and len(parts) == 2 and parts[0] == 'import':
            pattern = str((Path(main).parent / parts[1]).absolute())
            if fnmatch.fnmatchcase(str(site_file), pattern):
                return True
        depth += parts.count('{') - parts.count('}')
    return False


def merged_main(text, main=MAIN, site_file=SITE_FILE):
    """``text`` with an import that loads ``site_file``; unchanged when there is one already."""
    if has_import(text, main, site_file):
        return text
    first = text.lstrip().splitlines()[0] if text.strip() else ''
    if re.match(r'#\s*managed by', first, re.IGNORECASE):
        raise ValueError(
            f'{main} says another tool manages it ("{first.strip()}"), so it is not changed here. '
            f'Make that tool import {site_file.parent}/*.caddy (or {site_file}), run it, '
            'then retry.')
    return text.rstrip() + ('\n\n' if text.strip() else '') + import_line(site_file) + '\n'


def tree_hash(directory):
    digest = hashlib.sha256()
    for path in sorted(Path(directory).rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(directory)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:8]


def atomic_write(path, text, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.brushgraft-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def swap_link(root, target):
    """Point ``root/current`` at ``target`` in one atomic step."""
    link = Path(root) / 'current'
    tmp = Path(root) / ('.current-' + secrets.token_hex(6))
    try:
        tmp.symlink_to(target)
        os.replace(tmp, link)
    finally:
        tmp.unlink(missing_ok=True)


def releases(root):
    folder = Path(root) / 'releases'
    return sorted(p for p in folder.iterdir() if p.is_dir()) if folder.is_dir() else []


def live_release(root):
    link = Path(root) / 'current'
    return Path(os.path.realpath(link)) if link.is_symlink() else None


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


class Server:
    """What this installer does to the machine; tests substitute paths and commands."""

    def __init__(self, root=ROOT, main=MAIN, site_file=SITE_FILE, validate=None, reload=None):
        self.root, self.main, self.site_file = Path(root), Path(main), Path(site_file)
        self.validate = validate or self._validate
        self.reload = reload or self._reload

    def _validate(self):
        run(['caddy', 'validate', '--config', str(self.main), '--adapter', 'caddyfile'])

    def _reload(self):
        try:
            run(['systemctl', 'reload', 'caddy'])
        except (OSError, subprocess.CalledProcessError):
            run(['caddy', 'reload', '--config', str(self.main), '--adapter', 'caddyfile'])


def install(server, src, domain):
    """Put the site in ``src`` live at ``domain``; returns the release. Failures are undone."""
    src = Path(src)
    if not (src / 'index.html').is_file():
        raise ValueError(f'{src} has no index.html: build the site first')
    block = site_block(domain, server.root)
    main_text = server.main.read_text(encoding='utf-8') if server.main.exists() else ''
    new_main = merged_main(main_text, server.main, server.site_file)

    stamp = time.strftime('%Y%m%dT%H%M%S', time.gmtime())
    release = server.root / 'releases' / f'{stamp}-{tree_hash(src)}'
    if release.exists():
        raise ValueError(f'{release} exists already; retry in a second')
    previous_live = live_release(server.root)
    main_existed = server.main.exists()
    old_site = server.site_file.read_text(encoding='utf-8') if server.site_file.exists() else None
    changed_config = old_site != block or new_main != main_text
    try:
        shutil.copytree(src, release)
        for path in [release, *release.rglob('*')]:
            os.chmod(path, 0o755 if path.is_dir() else 0o644)
        if changed_config:
            if new_main != main_text:
                atomic_write(server.main, new_main)
            atomic_write(server.site_file, block)
            if not (server.root / 'current').exists():
                swap_link(server.root, release)  # the config names current/: it must exist
            server.validate()
        swap_link(server.root, release)
        if changed_config:
            server.reload()
    except BaseException:
        # Undo, in reverse: the config first, so Caddy never serves a half-installed state
        if old_site is None:
            server.site_file.unlink(missing_ok=True)
        else:
            atomic_write(server.site_file, old_site)
        if main_existed:
            atomic_write(server.main, main_text)
        else:
            server.main.unlink(missing_ok=True)
        if previous_live and previous_live.exists():
            swap_link(server.root, previous_live)
        elif (server.root / 'current').is_symlink():
            (server.root / 'current').unlink()
        shutil.rmtree(release, ignore_errors=True)
        if changed_config:
            try:
                server.reload()
            except Exception:
                pass
        raise
    for old in releases(server.root)[:-KEEP_RELEASES]:
        if old != release and old != previous_live:
            shutil.rmtree(old, ignore_errors=True)
    return release


def rollback(server):
    """Make the release before the live one live again. Returns it."""
    live = live_release(server.root)
    older = [r for r in releases(server.root) if live is None or r.name < live.name]
    if not older:
        raise ValueError('There is no earlier release to go back to')
    swap_link(server.root, older[-1])
    return older[-1]


def uninstall(server, purge=False):
    """Take the site down: remove its Caddy file (and the import line this installer added)."""
    server.site_file.unlink(missing_ok=True)
    if server.main.exists():
        text = server.main.read_text(encoding='utf-8')
        kept = [line for line in text.splitlines() if line.strip() != import_line(server.site_file)]
        if kept != text.splitlines():
            atomic_write(server.main, '\n'.join(kept).rstrip() + '\n')
    server.validate()
    server.reload()
    if purge:
        shutil.rmtree(server.root, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--root', type=Path, default=ROOT, help=argparse.SUPPRESS)
    parser.add_argument('--caddyfile', type=Path, default=MAIN, help=argparse.SUPPRESS)
    parser.add_argument('--site-file', type=Path, default=SITE_FILE, help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('install', help='put the site in --src live at --domain')
    p.add_argument('--src', type=Path, required=True)
    p.add_argument('--domain', required=True)
    sub.add_parser('rollback', help='go back to the previous release')
    p = sub.add_parser('uninstall', help='remove the Caddy file')
    p.add_argument('--purge', action='store_true', help='also delete every release')
    args = parser.parse_args(argv)
    server = Server(args.root, args.caddyfile, args.site_file)
    try:
        if args.command == 'install':
            print(f'Installed {install(server, args.src, args.domain)}')
        elif args.command == 'rollback':
            print(f'Rolled back to {rollback(server)}')
        else:
            uninstall(server, args.purge)
            print('Removed the brushgraft site')
    except subprocess.CalledProcessError as exc:
        sys.exit(f'{exc.cmd[0]} failed: {(exc.stderr or exc.stdout or "").strip()}')
    except (ValueError, OSError) as exc:
        sys.exit(str(exc))


if __name__ == '__main__':
    main()
