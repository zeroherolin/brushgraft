# Publishing the website

The website build is a folder of static files: no application server, no database. Anyone can host it behind Caddy. These steps build and publish it on the server itself, from a git checkout of brushgraft; `update` fetches the latest code and publishes it again.

## What you need

- A Linux server with [Caddy](https://caddyserver.com/) 2 running as a service, root (or `sudo`) access, `git` and Python 3.9+.
- Node.js 20.19+ or 22.12+ to build the site. Ubuntu 22.04's own `nodejs` package is too old: install a current LTS release from [nodejs.org](https://nodejs.org/en/download) or [NodeSource](https://github.com/nodesource/distributions).
- A DNS record pointing your domain at the server, and ports 80 and 443 open (Caddy fetches the HTTPS certificate itself).

## Clone and configure

```bash
cd ~
git clone https://github.com/zeroherolin/brushgraft.git
cd brushgraft
python3 deploy/deploy.py configure
```

`configure` asks for the domain and, optionally, a filing number, and saves them to `local/site.json`, which git ignores, so your details are never committed. Enter keeps the current value. Without questions: `python3 deploy/deploy.py configure --domain brush.example.com --icp-number "your filing number"`.

| Setting | What to enter |
| --- | --- |
| `domain` | The site's host name, such as `brush.example.com`; no scheme, port or path |
| `icp_number` | Optional. Where the law of your country asks for a filing number on the site, it is shown as a link at the bottom of the page, to <https://beian.miit.gov.cn/>; `-` for none |

The number lives only in that local file and in the published `site.json`, never in this repository.

## Publish

```bash
sudo python3 deploy/deploy.py
```

It builds the site into `web/dist` (installing the build tools in `web/node_modules` first, and again whenever `web/package-lock.json` changes; no package install scripts are run), then `deploy/install.py`:

1. copies it into `/srv/brushgraft/releases/<time>-<hash>/` and keeps the last five;
2. writes `/etc/caddy/sites-enabled/brushgraft.caddy` for your domain;
3. makes sure `/etc/caddy/Caddyfile` imports `sites-enabled/*.caddy` (or this file), adding `import /etc/caddy/sites-enabled/brushgraft.caddy` if it has neither;
4. validates the configuration, switches `/srv/brushgraft/current` to the new release in one atomic step, and reloads Caddy.

If validation or the reload fails, the previous configuration and release are put back and the command exits with Caddy's message. One publish, rollback or uninstall runs at a time: a second one, started meanwhile, stops at once and says so (the lock is `/srv/brushgraft/.lock`). Publishing again with the same domain and the same headers only adds a release and switches the link; Caddy is reloaded only when its configuration changed.

Last, it checks that `https://<domain>/` serves the new page (`--no-verify` skips that). `--dry-run` builds and stages the site in a temporary folder, without root, and publishes nothing.

## Update

```bash
sudo python3 deploy/deploy.py update
```

This fetches the latest code and publishes it. It follows a rewritten history too (the main branch amended and force-pushed), as long as the checkout holds nothing of its own; with edits to tracked files or commits that were never published, it stops and says so. Use it rather than `git pull`, which stops on a rewritten history. `local/` is kept. After `configure`, publish again for the change to show.

## Roll back or remove

```bash
sudo python3 deploy/deploy.py rollback     # the release before the live one
sudo python3 deploy/deploy.py uninstall    # take the site down; --purge also deletes the releases
```

Uninstalling removes `brushgraft.caddy` and the `import` line the installer added, validates and reloads Caddy.

## What the server sends

The site file sets a strict `Content-Security-Policy` (the page may run its own scripts and its Worker, show its own images and `blob:` ones, and connect to itself, `https:` services and a service on your own computer; nothing may embed it), HSTS, `nosniff`, `Referrer-Policy: no-referrer`, and a permissions policy that turns off the camera, microphone and location. Built files carry a hash in their name and are cached for a year; the page itself is revalidated each time, so a new release shows at once.

The page never sends your key or images to this server, which only serves files. The image service is called from the page, so it has to allow web pages to call it (CORS, with the `Authorization` header); a plain `http:` service works only on the visitor's own computer (`localhost`, `127.0.0.1`).

## Other sites on the same Caddy

The installer owns `brushgraft.caddy` and the `/srv/brushgraft` folder, and touches the main Caddyfile only to add an `import` line, never to rewrite it. It refuses to edit a Caddyfile whose first line says another tool manages it ("# Managed by …"), unless that file already imports the `sites-enabled` folder; make the other tool import `/etc/caddy/sites-enabled/*.caddy`, run it, then publish again. Nothing in brushgraft reads or depends on that other tool, and a redeployment of it leaves `brushgraft.caddy` alone as long as it keeps that import.

Both sites live in one Caddy configuration, so a file in `sites-enabled/` that Caddy rejects makes every deployment into that configuration fail validation, with Caddy's message, until it is fixed.
