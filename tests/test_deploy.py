"""The server-side installer (deploy/install.py): config, releases, rollback, undo on failure."""

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

# The installer runs on the Linux server: it works with POSIX paths, file modes and symlinks
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the installer runs on Linux")

SPEC = importlib.util.spec_from_file_location(
    "bg_install", Path(__file__).resolve().parent.parent / "deploy" / "install.py")
install_mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(install_mod)

DOMAIN = "brush.example.com"


@pytest.fixture
def box(tmp_path):
    """A fake server: its own root, Caddyfile and sites dir, commands recorded."""
    calls = []
    server = install_mod.Server(
        root=tmp_path / "srv", main=tmp_path / "etc" / "Caddyfile",
        site_file=tmp_path / "etc" / "sites-enabled" / "brushgraft.caddy",
        validate=lambda: calls.append("validate"), reload=lambda: calls.append("reload"))
    server.main.parent.mkdir(parents=True)
    server.calls = calls
    return server


def make_site(tmp_path, name="site", body="<title>x</title>"):
    site = tmp_path / name
    (site / "assets").mkdir(parents=True, exist_ok=True)
    (site / "index.html").write_text(body)
    (site / "assets" / "app.js").write_text("1")
    return site


class TestSiteBlock:
    def test_serves_current_with_strict_headers_and_caching(self):
        block = install_mod.site_block(DOMAIN)
        assert block.startswith("# Managed by brushgraft")
        assert f"\n{DOMAIN} {{" in block
        assert "root * /srv/brushgraft/current" in block
        for part in ("Content-Security-Policy", "Strict-Transport-Security",
                     "X-Content-Type-Options nosniff", "Referrer-Policy no-referrer",
                     "-Server", "immutable", "no-cache", "file_server", "encode zstd gzip"):
            assert part in block

    def test_only_files_that_exist_get_the_year_long_cache_lifetime(self):
        # a missing asset (an old page open during a deploy) must not be remembered as missing
        block = install_mod.site_block(DOMAIN)
        matcher = block[block.index("@assets {"):block.index("header @assets")]
        assert "path /assets/*" in matcher and "\n        file\n" in matcher

    def test_the_policy_allows_only_what_the_page_needs(self):
        csp = install_mod.CSP
        assert "default-src 'none'" in csp and "script-src 'self'" in csp
        assert "'unsafe-inline'" not in csp and "'unsafe-eval'" not in csp
        assert "frame-ancestors 'none'" in csp and "object-src 'none'" in csp
        assert '"' not in csp and "\n" not in csp  # safe inside a quoted Caddy value

    @pytest.mark.parametrize("bad", [
        "", "localhost", "a b.com", "x.com {", "x.com\nimport /etc/passwd", "-a.example.com",
        "ex_ample.com", "https://x.com", "brush.example.com\n"])
    def test_refuses_anything_that_isnt_a_host_name(self, bad):
        with pytest.raises(ValueError):
            install_mod.site_block(bad)


class TestMainFile:
    MAIN = Path("/etc/caddy/Caddyfile")
    SITE = Path("/etc/caddy/sites-enabled/brushgraft.caddy")

    def merged(self, text):
        return install_mod.merged_main(text, self.MAIN, self.SITE)

    def test_a_missing_or_empty_file_gets_just_the_import(self):
        assert self.merged("") == f"import {self.SITE}\n"

    @pytest.mark.parametrize("line", ["import /etc/caddy/sites-enabled/*.caddy",
                                      "import sites-enabled/*",
                                      "import /etc/caddy/sites-enabled/brushgraft.caddy"])
    def test_an_import_that_covers_the_file_is_left_alone(self, line):
        text = f"{{\n    email a@b.c\n}}\n\n{line}\n"
        assert self.merged(text) == text

    def test_an_import_inside_a_block_does_not_count(self):
        text = "example.com {\n    import /etc/caddy/sites-enabled/*.caddy\n}\n"
        out = self.merged(text)
        assert out.startswith(text.rstrip()) and out.endswith(f"import {self.SITE}\n")

    @pytest.mark.parametrize("line", ["import /etc/caddy/*.caddy", "import *"])
    def test_a_glob_one_folder_up_does_not_cover_the_file(self, line):
        # Caddy's * stops at a /, so these don't load sites-enabled/brushgraft.caddy
        assert self.merged(f"{line}\n").endswith(f"import {self.SITE}\n")

    def test_an_apostrophe_elsewhere_in_the_file_is_no_trouble(self):
        text = "example.com {\n    respond `it's fine`\n}\n"
        assert self.merged(text) == text + f"\nimport {self.SITE}\n"

    def test_other_sites_are_kept_and_the_import_is_added_once(self):
        text = "other.com {\n    respond ok\n}\n"
        out = self.merged(text)
        assert out == text + f"\nimport {self.SITE}\n"
        assert self.merged(out) == out

    def test_a_file_managed_by_another_tool_is_not_edited(self):
        with pytest.raises(ValueError, match="another tool manages it"):
            self.merged("# Managed by othertool. Edit it elsewhere.\n"
                        "import /etc/caddy/sites-enabled/othertool.caddy\n")


class TestInstall:
    def test_first_install_writes_config_link_and_reloads_after_validating(self, box, tmp_path):
        release = install_mod.install(box, make_site(tmp_path), DOMAIN)
        assert (release / "index.html").read_text() == "<title>x</title>"
        assert os.path.realpath(box.root / "current") == str(release.resolve())
        assert (box.root / "current" / "assets" / "app.js").exists()
        assert box.site_file.read_text() == install_mod.site_block(DOMAIN, box.root)
        assert box.main.read_text() == f"import {box.site_file}\n"
        assert box.calls == ["validate", "reload"]

    def test_files_are_readable_by_the_web_server(self, box, tmp_path):
        release = install_mod.install(box, make_site(tmp_path), DOMAIN)
        assert (release.stat().st_mode & 0o777) == 0o755
        assert ((release / "index.html").stat().st_mode & 0o777) == 0o644

    def test_a_new_version_only_switches_the_link(self, box, tmp_path):
        first = install_mod.install(box, make_site(tmp_path, "a", "one"), DOMAIN)
        box.calls.clear()
        second = install_mod.install(box, make_site(tmp_path, "b", "two"), DOMAIN)
        assert second != first
        assert (box.root / "current" / "index.html").read_text() == "two"
        assert box.calls == []  # same config: nothing to validate or reload
        assert first.exists()  # kept for rollback

    def test_the_same_site_again_adds_no_release(self, box, tmp_path):
        # an update with nothing new must not push the previous versions out of rollback's reach
        first = install_mod.install(box, make_site(tmp_path, "a", "one"), DOMAIN)
        live = install_mod.install(box, make_site(tmp_path, "b", "two"), DOMAIN)
        for k in range(install_mod.KEEP_RELEASES + 1):
            assert install_mod.install(box, make_site(tmp_path, f"c{k}", "two"), DOMAIN) == live
        assert install_mod.releases(box.root) == [first, live]

    def test_rollback_goes_back_one_release(self, box, tmp_path):
        first = install_mod.install(box, make_site(tmp_path, "a", "one"), DOMAIN)
        install_mod.install(box, make_site(tmp_path, "b", "two"), DOMAIN)
        assert install_mod.rollback(box) == first
        assert (box.root / "current" / "index.html").read_text() == "one"
        with pytest.raises(ValueError, match="no earlier release"):
            install_mod.rollback(box)

    def test_old_releases_are_pruned_but_not_the_live_one(self, box, tmp_path):
        for k in range(install_mod.KEEP_RELEASES + 3):
            old = box.root / "releases" / f"2026010{k}T000000-{k:08d}"
            old.mkdir(parents=True)
            (old / "index.html").write_text(str(k))
        live = install_mod.install(box, make_site(tmp_path), DOMAIN)
        names = [r.name for r in install_mod.releases(box.root)]
        assert len(names) == install_mod.KEEP_RELEASES
        assert live.name in names

    def test_the_copy_is_renamed_into_place_and_a_stale_one_is_cleared(self, box, tmp_path):
        stale = box.root / "releases" / ".tmp-20260101T000000-aaaaaaaa"
        stale.mkdir(parents=True)
        os.utime(stale, (0, 0))
        release = install_mod.install(box, make_site(tmp_path), DOMAIN)
        assert (release / "index.html").exists()
        assert list((box.root / "releases").glob(".tmp-*")) == []

    def test_rollback_skips_a_copy_cut_short(self, box, tmp_path):
        folder = box.root / "releases"
        for name, complete in (("20260101T000000-aaaaaaaa", True),
                               ("20260102T000000-bbbbbbbb", False),  # no index.html
                               ("20260103T000000-cccccccc", True)):
            (folder / name).mkdir(parents=True)
            if complete:
                (folder / name / "index.html").write_text(name)
        install_mod.swap_link(box.root, folder / "20260103T000000-cccccccc")
        assert install_mod.rollback(box).name == "20260101T000000-aaaaaaaa"

    def test_other_sites_in_the_main_file_are_kept(self, box, tmp_path):
        box.main.write_text("other.com {\n    respond ok\n}\n")
        install_mod.install(box, make_site(tmp_path), DOMAIN)
        text = box.main.read_text()
        assert text.startswith("other.com {") and text.endswith(f"import {box.site_file}\n")

    def test_a_managed_main_file_is_refused_before_anything_changes(self, box, tmp_path):
        box.main.write_text("# Managed by sometool. Do not edit.\nimport /etc/other/*.caddy\n")
        with pytest.raises(ValueError, match="another tool manages it"):
            install_mod.install(box, make_site(tmp_path), DOMAIN)
        assert not box.site_file.exists() and not (box.root / "releases").exists()
        assert box.calls == []

    def test_a_managed_main_file_that_imports_the_folder_is_left_as_it_is(self, box, tmp_path):
        text = f"# Managed by sometool.\nimport {box.site_file.parent}/*.caddy\n"
        box.main.write_text(text)
        install_mod.install(box, make_site(tmp_path), DOMAIN)
        assert box.main.read_text() == text
        assert box.site_file.exists() and box.calls == ["validate", "reload"]

    def test_without_a_site_there_is_nothing_to_install(self, box, tmp_path):
        (tmp_path / "empty").mkdir()
        with pytest.raises(ValueError, match="no index.html"):
            install_mod.install(box, tmp_path / "empty", DOMAIN)


class TestFailure:
    def test_a_config_caddy_rejects_is_undone_and_the_old_site_stays_live(self, box, tmp_path):
        first = install_mod.install(box, make_site(tmp_path, "a", "one"), DOMAIN)
        old_config = box.site_file.read_text()
        old_main = box.main.read_text()

        def reject():
            raise subprocess.CalledProcessError(1, ["caddy"], stderr="bad config")

        box.validate = reject
        with pytest.raises(subprocess.CalledProcessError):
            install_mod.install(box, make_site(tmp_path, "b", "two"), "other.example.com")
        assert box.site_file.read_text() == old_config
        assert box.main.read_text() == old_main
        assert os.path.realpath(box.root / "current") == str(first.resolve())
        assert [r.name for r in install_mod.releases(box.root)] == [first.name]

    def test_a_first_install_that_fails_leaves_nothing_behind(self, box, tmp_path):
        def reject():
            raise subprocess.CalledProcessError(1, ["caddy"], stderr="bad")

        box.validate = reject
        with pytest.raises(subprocess.CalledProcessError):
            install_mod.install(box, make_site(tmp_path), DOMAIN)
        assert not box.site_file.exists() and not box.main.exists()
        assert not (box.root / "current").exists() and install_mod.releases(box.root) == []

    def test_a_failed_reload_goes_back_to_the_previous_release(self, box, tmp_path):
        first = install_mod.install(box, make_site(tmp_path, "a", "one"), DOMAIN)
        calls = []

        def reload():
            calls.append(1)
            if len(calls) == 1:
                raise subprocess.CalledProcessError(1, ["systemctl"], stderr="no")

        box.reload = reload
        with pytest.raises(subprocess.CalledProcessError):
            install_mod.install(box, make_site(tmp_path, "b", "two"), "other.example.com")
        assert (box.root / "current" / "index.html").read_text() == "one"
        assert len(calls) == 2  # asked Caddy to load the restored config too
        assert box.site_file.read_text() == install_mod.site_block(DOMAIN, box.root)
        assert first.exists()


class TestUninstall:
    def test_removes_the_site_and_the_import_it_added_but_not_other_sites(self, box, tmp_path):
        box.main.write_text("other.com {\n    respond ok\n}\n")
        install_mod.install(box, make_site(tmp_path), DOMAIN)
        box.calls.clear()
        install_mod.uninstall(box)
        assert not box.site_file.exists()
        assert box.main.read_text() == "other.com {\n    respond ok\n}\n"
        assert box.calls == ["validate", "reload"]
        assert (box.root / "releases").exists()  # kept unless purged
        install_mod.uninstall(box, purge=True)
        assert not box.root.exists()

    def test_a_covering_glob_import_is_not_ours_to_remove(self, box):
        box.main.write_text(f"import {box.site_file.parent}/*.caddy\n")
        install_mod.uninstall(box)
        assert box.main.read_text() == f"import {box.site_file.parent}/*.caddy\n"


def test_command_line_reports_problems_without_a_traceback(tmp_path, capsys):
    with pytest.raises(SystemExit) as exc:
        install_mod.main(["--root", str(tmp_path / "r"), "--caddyfile", str(tmp_path / "C"),
                          "--site-file", str(tmp_path / "s" / "b.caddy"),
                          "install", "--src", str(tmp_path), "--domain", DOMAIN])
    assert "no index.html" in str(exc.value)
