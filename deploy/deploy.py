#!/usr/bin/env python3
"""Build the brushgraft website and publish it on this server, from a git checkout of brushgraft.

Runs on the server (Linux with Caddy; Python 3.9+, git, Node.js 20.19+ or 22.12+). Publishing
changes /srv and Caddy's configuration, so it runs as root:

    python3 deploy/deploy.py configure          # save the domain (and a filing number)
    sudo python3 deploy/deploy.py               # build the site and publish it
    sudo python3 deploy/deploy.py update        # get the latest code, then build and publish
    sudo python3 deploy/deploy.py rollback      # the release before the live one
    sudo python3 deploy/deploy.py uninstall     # take the site down (--purge: delete the releases)

Your own details never go in the repository: ``configure`` keeps them in ``local/site.json`` at
the top of the checkout (git ignores ``local/``), e.g.
{"domain": "brush.example.com", "icp_number": "..."}. ``icp_number`` is a filing number shown
at the bottom of the page where the law of your country asks for one; leave it out otherwise.
``install.py`` does the work on the machine: releases, the live link and the Caddy site.
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WEB = ROOT / 'web'
LOCAL = ROOT / 'local' / 'site.json'
REGISTRY = 'https://beian.miit.gov.cn/'
FIELDS = ('domain', 'icp_number')

sys.path.insert(0, str(HERE))
import install  # noqa: E402  (deploy/install.py, beside this file)

ICP = re.compile(r'^[\w一-鿿（）() -]{1,100}$')


def where(path):
    """``path`` as the reader of a message knows it: relative to the checkout when inside it."""
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


# -- settings -------------------------------------------------------------------------------

def load_settings(path=LOCAL):
    path = Path(path)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError(f'Cannot read {where(path)}: {exc}') from None
    if not isinstance(data, dict):
        raise ValueError(f'{where(path)} must hold a JSON object')
    unknown = sorted(set(data) - set(FIELDS))
    if unknown:
        raise ValueError(f'{where(path)}: unknown setting {", ".join(map(repr, unknown))} '
                         f'(the settings are {", ".join(FIELDS)})')
    return data


def check(settings, path=LOCAL):
    """The domain and filing number to publish with; ValueError says what is wrong."""
    domain = settings.get('domain') or ''
    icp = settings.get('icp_number') or ''
    if not domain:
        raise ValueError('No domain yet: run "python3 deploy/deploy.py configure", '
                         f'which saves it to {where(path)}')
    if not isinstance(domain, str) or not install.HOSTNAME.match(domain):
        raise ValueError(f'Not a host name: {domain!r}')
    if icp and (not isinstance(icp, str) or not ICP.match(icp)):
        raise ValueError('The filing number may hold only letters, digits, spaces, - and ( )')
    return domain, icp or None


def configure(path=LOCAL, given=None, ask=None):
    """Save the settings: ``given`` values win, ``ask(prompt)`` asks for the rest (Enter keeps the
    current value, - clears the filing number). Nothing is written unless the result is valid."""
    path = Path(path)
    current = load_settings(path)
    given = given or {}
    questions = [('domain', 'Domain, such as brush.example.com (no https://)'),
                 ('icp_number', 'Filing number shown at the bottom of the page; - for none')]
    settings = {}
    for key, prompt in questions:
        value = given.get(key)
        if value is None:
            value = current.get(key, '')
            if ask:
                entered = ask(prompt + (f' [{value}]' if value else '') + ': ').strip()
                value = entered or value
        if value and value != '-':
            settings[key] = value
    check(settings, path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    text = json.dumps(settings, ensure_ascii=False, indent=2) + '\n'
    install.atomic_write(path, text, mode=0o600)
    return settings


# -- building -------------------------------------------------------------------------------

def node_ok(version):
    """Whether Node.js ``(major, minor)`` can build the site: Vite needs ^20.19.0 || >=22.12.0."""
    return version is not None and ((version[0] == 20 and version[1] >= 19) or version >= (22, 12))


def node_version():
    try:
        out = subprocess.run(['node', '--version'], capture_output=True, text=True,
                             check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    match = re.match(r'v(\d+)\.(\d+)', out.strip())
    return (int(match[1]), int(match[2])) if match else None


def run(args, **kwargs):
    print('+', shlex.join(map(str, args)), flush=True)
    subprocess.run(args, check=True, **kwargs)


def build(web=WEB):
    """Build the site into web/dist, installing the build tools first when the lock file changed."""
    version = node_version()
    if not node_ok(version):
        found = 'none' if version is None else 'v%d.%d' % version
        raise ValueError(f'Building the site needs Node.js 20.19+ or 22.12+ (found {found}); '
                         'see docs/deploy.md')
    lock = hashlib.sha256((web / 'package-lock.json').read_bytes()).hexdigest()
    stamp = web / 'node_modules' / '.brushgraft-lock'
    if not stamp.is_file() or stamp.read_text().strip() != lock:
        # No package needs its install script (only fsevents has one, for macOS): none runs
        run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=web)
        stamp.write_text(lock + '\n')
    run(['npm', 'run', 'build:browser'], cwd=web)
    return web / 'dist'


def stage(dist, icp=None, icp_url=REGISTRY):
    """A copy of the built site, with site.json beside it when there is a filing number to show."""
    dist = Path(dist)
    if not (dist / 'index.html').is_file():
        raise ValueError(f'{dist} has no index.html: the build did not produce a site')
    staged = Path(tempfile.mkdtemp(prefix='brushgraft-site-'))
    shutil.copytree(dist, staged, dirs_exist_ok=True)
    (staged / 'site.json').unlink(missing_ok=True)
    if icp:
        (staged / 'site.json').write_text(
            json.dumps({'icp': icp, 'icp_url': icp_url}, ensure_ascii=False) + '\n',
            encoding='utf-8')
    return staged


def verify(domain, release, tries=10, wait=3.0):
    """Whether https://domain/ serves the release's page (Caddy may still be fetching a
    certificate, so it tries a few times)."""
    want = (Path(release) / 'index.html').read_bytes()
    request = urllib.request.Request(f'https://{domain}/', headers={'Cache-Control': 'no-cache'})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                if response.status == 200 and response.read() == want:
                    return True
        except (OSError, urllib.error.URLError):
            pass
        if attempt + 1 < tries:
            time.sleep(wait)
    return False


# -- updating the checkout ------------------------------------------------------------------

def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True,
                          check=True).stdout.strip()


def fetch(root, tries=3, wait=5.0):
    """``git fetch``, tried again after a pause: a server's link to the git host can be flaky."""
    for attempt in range(tries):
        try:
            return git(root, 'fetch', '--quiet')
        except subprocess.CalledProcessError as exc:
            if attempt + 1 == tries:
                raise
            print(f'git fetch failed ({exc.stderr.strip() or exc.returncode}); trying again',
                  flush=True)
            time.sleep(wait)


def is_ancestor(root, older, newer):
    return subprocess.run(['git', '-C', str(root), 'merge-base', '--is-ancestor', older, newer],
                          capture_output=True).returncode == 0


def update_checkout(root=ROOT):
    """Bring the checkout to the latest published code; returns the commits before and after.

    A published history that was rewritten (amended and force-pushed) is followed too, as long
    as the checkout holds nothing of its own: no edits to tracked files and no commits that were
    never published. Ignored files, such as local/, are left as they are.
    """
    if git(root, 'status', '--porcelain', '--untracked-files=no'):
        raise ValueError('The checkout has edits to tracked files; commit or undo them first '
                         '(git status)')
    try:
        before = git(root, 'rev-parse', '@{upstream}')
    except subprocess.CalledProcessError:
        raise ValueError('The checkout is not on a branch that tracks a remote one '
                         '(git switch main)') from None
    head = git(root, 'rev-parse', 'HEAD')
    fetch(root)
    after = git(root, 'rev-parse', '@{upstream}')
    if head == after:
        return head, after
    if is_ancestor(root, head, after):
        git(root, 'merge', '--ff-only', '--quiet', after)
    elif is_ancestor(root, head, before):
        git(root, 'reset', '--hard', '--quiet', after)  # rewritten upstream; nothing here is lost
    else:
        raise ValueError('The checkout has commits that were never published; '
                         'merge them yourself (git pull --rebase), then publish')
    return head, after


# -- command line ---------------------------------------------------------------------------

def need_root(action):
    if hasattr(os, 'geteuid') and os.geteuid() != 0:
        raise ValueError(f"{action.capitalize()} changes /srv and Caddy's configuration: run it "
                         f'as root (sudo python3 deploy/deploy.py {action})')


def publish(args, server):
    domain, icp = check(load_settings(args.config), args.config)
    if not args.dry_run:
        need_root('publish')
    staged = stage(WEB / 'dist' if args.skip_build else build(), icp)
    if args.dry_run:
        print(f'Staged at {staged}; nothing was published.')
        return
    try:
        release = install.install(server, staged, domain)
    finally:
        shutil.rmtree(staged, ignore_errors=True)
    print(f'Installed {release}', flush=True)
    if args.no_verify:
        print(f'Published https://{domain}/')
    elif verify(domain, release):
        print(f'Published https://{domain}/ (checked)')
    else:
        raise ValueError(f'Installed, but https://{domain}/ does not serve it: check the DNS '
                         'record, ports 80 and 443, and "systemctl status caddy"')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('action', nargs='?', default='publish',
                        choices=['publish', 'configure', 'update', 'rollback', 'uninstall'])
    parser.add_argument('--domain', help="configure: the site's host name")
    parser.add_argument('--icp-number',
                        help='configure: filing number for the bottom of the page (- for none)')
    parser.add_argument('--dry-run', action='store_true',
                        help='publish: build and stage the site, but change nothing')
    parser.add_argument('--skip-build', action='store_true', help='publish: use web/dist as it is')
    parser.add_argument('--no-verify', action='store_true',
                        help="publish: don't check that the site serves the new release")
    parser.add_argument('--purge', action='store_true', help='uninstall: also delete every release')
    parser.add_argument('--config', type=Path, default=LOCAL, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    server = install.Server()
    try:
        if args.action == 'configure':
            given = {'domain': args.domain, 'icp_number': args.icp_number}
            ask = input if sys.stdin.isatty() and None in given.values() else None
            configure(args.config, given, ask)
            print(f'Saved {where(args.config)}')
        elif args.action == 'publish':
            publish(args, server)
        elif args.action == 'update':
            need_root('update')
            check(load_settings(args.config), args.config)
            old, new = update_checkout()
            print(f'Updated {old[:7]} -> {new[:7]}' if old != new else f'Up to date ({new[:7]})',
                  flush=True)
            # publish with the code just fetched, which may hold a new version of this script
            rest = ['--no-verify'] if args.no_verify else []
            os.execv(sys.executable, [sys.executable, str(HERE / 'deploy.py'), 'publish',
                                      '--config', str(args.config), *rest])
        elif args.action == 'rollback':
            need_root('rollback')
            print(f'Rolled back to {install.rollback(server)}')
        else:
            need_root('uninstall')
            install.uninstall(server, args.purge)
            print('Removed the brushgraft site')
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() if isinstance(exc.stderr, str) else ''
        sys.exit(f'{shlex.join(map(str, exc.cmd))} failed' + (f': {detail}' if detail else ''))
    except (ValueError, OSError) as exc:
        sys.exit(str(exc))


if __name__ == '__main__':
    main()
