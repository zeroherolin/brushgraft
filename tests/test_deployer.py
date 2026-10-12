"""The deployer (deploy/deploy.py), run on the server from a checkout: settings, the build, what
gets published, and updating the checkout."""

import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# The deployer runs on the Linux server: POSIX file modes, git and root
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the deployer runs on Linux")

SPEC = importlib.util.spec_from_file_location(
    "bg_deploy", Path(__file__).resolve().parent.parent / "deploy" / "deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)

ICP = "京ICP备00000000号-1"


def built(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<title>x</title>")
    (dist / "assets" / "a.js").write_text("1")
    return dist


def settings_file(tmp_path, **values):
    path = tmp_path / "local" / "site.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(values), encoding="utf-8")
    return path


class TestSettings:
    def test_the_settings_live_in_the_ignored_local_folder(self):
        root = Path(__file__).resolve().parent.parent
        assert deploy.LOCAL == root / "local" / "site.json"
        assert "/local/" in (root / ".gitignore").read_text().splitlines()

    def test_a_missing_file_is_no_settings_and_a_broken_one_is_reported(self, tmp_path):
        assert deploy.load_settings(tmp_path / "none.json") == {}
        path = tmp_path / "site.json"
        path.write_text("{nope")
        with pytest.raises(ValueError, match="Cannot read"):
            deploy.load_settings(path)

    def test_an_unknown_setting_is_named(self, tmp_path):
        path = settings_file(tmp_path, domain="a.example.com", icp=ICP)
        with pytest.raises(ValueError, match="unknown setting 'icp'.*icp_number"):
            deploy.load_settings(path)


class TestCheck:
    def test_accepts_ordinary_values(self):
        assert deploy.check({"domain": "brush.example.com", "icp_number": ICP}) == (
            "brush.example.com", ICP)
        assert deploy.check({"domain": "a.b.example.org"}) == ("a.b.example.org", None)

    def test_without_a_domain_it_says_how_to_set_one(self):
        with pytest.raises(ValueError, match="deploy.py configure.*local/site.json"):
            deploy.check({})

    @pytest.mark.parametrize("domain", ["localhost", "x.com;ls", "x.com/y", "A B.com", 7])
    def test_refuses_things_that_are_not_host_names(self, domain):
        with pytest.raises(ValueError, match="host name"):
            deploy.check({"domain": domain})

    @pytest.mark.parametrize("icp", ["<script>", "a\nb", "x" * 101, "a;b", 'a"b', 5])
    def test_refuses_filing_numbers_that_could_break_out_of_the_page(self, icp):
        with pytest.raises(ValueError, match="filing number"):
            deploy.check({"domain": "brush.example.com", "icp_number": icp})


class TestConfigure:
    def test_saves_a_private_file_in_a_private_folder(self, tmp_path):
        path = tmp_path / "local" / "site.json"
        deploy.configure(path, {"domain": "brush.example.com", "icp_number": ICP})
        assert json.loads(path.read_text(encoding="utf-8")) == {
            "domain": "brush.example.com", "icp_number": ICP}
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700

    def test_enter_keeps_a_value_and_a_dash_clears_the_number(self, tmp_path):
        path = tmp_path / "local" / "site.json"
        deploy.configure(path, {"domain": "a.example.com", "icp_number": ICP})
        answers, prompts = iter(["", "-"]), []
        def ask(prompt):
            prompts.append(prompt)
            return next(answers)
        assert deploy.configure(path, {}, ask) == {"domain": "a.example.com"}
        assert "[a.example.com]" in prompts[0] and f"[{ICP}]" in prompts[1]

    def test_given_values_are_not_asked_for(self, tmp_path):
        asked = []
        deploy.configure(tmp_path / "site.json", {"domain": "b.example.com"},
                         lambda prompt: asked.append(prompt) or "")
        assert len(asked) == 1 and asked[0].startswith("Filing number")

    def test_nothing_is_written_when_the_result_is_invalid(self, tmp_path):
        path = tmp_path / "local" / "site.json"
        deploy.configure(path, {"domain": "a.example.com"})
        with pytest.raises(ValueError, match="host name"):
            deploy.configure(path, {"domain": "not a domain"})
        assert json.loads(path.read_text()) == {"domain": "a.example.com"}


class TestBuild:
    @pytest.mark.parametrize("version, ok", [
        (None, False), ((18, 20), False), ((20, 18), False), ((20, 19), True), ((21, 7), False),
        ((22, 11), False), ((22, 12), True), ((24, 0), True)])
    def test_the_node_versions_vite_runs_on(self, version, ok):
        assert deploy.node_ok(version) is ok

    def test_an_old_node_is_reported_before_anything_runs(self, monkeypatch, tmp_path):
        monkeypatch.setattr(deploy, "node_version", lambda: (18, 20))
        ran = []
        monkeypatch.setattr(deploy, "run", lambda args, **kw: ran.append(args))
        with pytest.raises(ValueError, match=r"20\.19\+ or 22\.12\+ \(found v18\.20\)"):
            deploy.build(tmp_path)
        assert ran == []

    def test_build_tools_are_installed_again_when_the_lock_changes(self, monkeypatch, tmp_path):
        web = tmp_path / "web"
        (web / "node_modules").mkdir(parents=True)
        (web / "package-lock.json").write_text('{"v": 1}')
        monkeypatch.setattr(deploy, "node_version", lambda: (24, 1))
        ran = []
        monkeypatch.setattr(deploy, "run", lambda args, **kw: ran.append(args))
        deploy.build(web)
        deploy.build(web)
        (web / "package-lock.json").write_text('{"v": 2}')
        assert deploy.build(web) == web / "dist"
        assert [a[:2] for a in ran] == [["npm", "ci"], ["npm", "run"], ["npm", "run"],
                                        ["npm", "ci"], ["npm", "run"]]
        assert "--ignore-scripts" in ran[0]  # no package runs code while installing


class TestStage:
    def test_copies_the_build_and_adds_the_filing_line(self, tmp_path):
        staged = deploy.stage(built(tmp_path), ICP)
        try:
            assert (staged / "index.html").read_text() == "<title>x</title>"
            assert (staged / "assets" / "a.js").exists()
            data = json.loads((staged / "site.json").read_text(encoding="utf-8"))
            assert data == {"icp": ICP, "icp_url": "https://beian.miit.gov.cn/"}
        finally:
            shutil.rmtree(staged)

    def test_without_a_number_there_is_no_site_json_even_if_the_build_has_one(self, tmp_path):
        dist = built(tmp_path)
        (dist / "site.json").write_text('{"icp": "stale"}')
        staged = deploy.stage(dist, None)
        try:
            assert not (staged / "site.json").exists()
            assert (dist / "site.json").exists()  # the build itself is left alone
        finally:
            shutil.rmtree(staged)

    def test_refuses_a_directory_that_isnt_a_built_site(self, tmp_path):
        with pytest.raises(ValueError, match="no index.html"):
            deploy.stage(tmp_path)


class TestVerify:
    def serve(self, monkeypatch, body, seen):
        def urlopen(request, timeout):
            seen.append(request.full_url)
            response = io.BytesIO(body)
            response.status = 200
            return response
        monkeypatch.setattr(deploy.urllib.request, "urlopen", urlopen)

    def test_the_new_page_has_to_be_the_one_served(self, monkeypatch, tmp_path):
        release = built(tmp_path)
        seen = []
        self.serve(monkeypatch, b"<title>x</title>", seen)
        assert deploy.verify("brush.example.com", release, tries=3, wait=0)
        assert seen == ["https://brush.example.com/"]
        self.serve(monkeypatch, b"<title>the old one</title>", seen)
        assert not deploy.verify("brush.example.com", release, tries=3, wait=0)
        assert len(seen) == 4  # tried again before giving up


@pytest.fixture
def repos(tmp_path, monkeypatch):
    """A published repository (``dev`` pushes to ``origin``) and the server's checkout of it."""
    env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    def git(cwd, *args):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                              text=True).stdout.strip()

    origin, dev, server = tmp_path / "origin.git", tmp_path / "dev", tmp_path / "server"
    git(tmp_path, "init", "--quiet", "--bare", "-b", "main", str(origin))
    dev.mkdir()
    git(dev, "init", "--quiet", "-b", "main")
    (dev / "app.txt").write_text("1\n")
    (dev / ".gitignore").write_text("/local/\n")
    git(dev, "add", ".")
    git(dev, "commit", "--quiet", "-m", "app 0.1.0")
    git(dev, "remote", "add", "origin", str(origin))
    git(dev, "push", "--quiet", "-u", "origin", "main")
    git(tmp_path, "clone", "--quiet", str(origin), str(server))
    settings_file(server, domain="brush.example.com")
    return SimpleNamespace(dev=dev, server=server, git=git)


class TestUpdate:
    def test_up_to_date(self, repos):
        head = repos.git(repos.server, "rev-parse", "HEAD")
        assert deploy.update_checkout(repos.server) == (head, head)

    def test_new_commits_are_fast_forwarded(self, repos):
        (repos.dev / "app.txt").write_text("2\n")
        repos.git(repos.dev, "commit", "--quiet", "-am", "more")
        repos.git(repos.dev, "push", "--quiet")
        old, new = deploy.update_checkout(repos.server)
        assert old != new == repos.git(repos.dev, "rev-parse", "HEAD")
        assert (repos.server / "app.txt").read_text() == "2\n"

    def test_a_rewritten_history_is_followed_and_local_is_kept(self, repos):
        # the project keeps one commit: changes are amended into it and force-pushed
        (repos.dev / "app.txt").write_text("2\n")
        repos.git(repos.dev, "commit", "--quiet", "--amend", "-am", "app 0.1.0")
        repos.git(repos.dev, "push", "--quiet", "--force")
        (repos.server / "notes.txt").write_text("untracked, and kept")
        old, new = deploy.update_checkout(repos.server)
        assert new == repos.git(repos.server, "rev-parse", "HEAD")
        assert new == repos.git(repos.dev, "rev-parse", "HEAD")
        assert (repos.server / "app.txt").read_text() == "2\n"
        local = json.loads((repos.server / "local" / "site.json").read_text())
        assert local == {"domain": "brush.example.com"}
        assert (repos.server / "notes.txt").exists()

    def test_a_failed_fetch_is_tried_again(self, repos, monkeypatch, capsys):
        (repos.dev / "app.txt").write_text("2\n")
        repos.git(repos.dev, "commit", "--quiet", "-am", "more")
        repos.git(repos.dev, "push", "--quiet")
        real, fetches = deploy.git, []
        def flaky(root, *args):
            if args[0] == "fetch":
                fetches.append(args)
                if len(fetches) == 1:
                    raise subprocess.CalledProcessError(128, ["git", *args], "", "RPC failed")
            return real(root, *args)
        monkeypatch.setattr(deploy, "git", flaky)
        monkeypatch.setattr(deploy.time, "sleep", lambda s: None)
        old, new = deploy.update_checkout(repos.server)
        assert old != new and len(fetches) == 2
        assert "RPC failed" in capsys.readouterr().out

    def test_commits_that_were_never_published_stop_it(self, repos):
        (repos.server / "app.txt").write_text("mine\n")
        repos.git(repos.server, "commit", "--quiet", "-am", "a change of my own")
        mine = repos.git(repos.server, "rev-parse", "HEAD")
        (repos.dev / "app.txt").write_text("2\n")
        repos.git(repos.dev, "commit", "--quiet", "--amend", "-am", "app 0.1.0")
        repos.git(repos.dev, "push", "--quiet", "--force")
        with pytest.raises(ValueError, match="never published"):
            deploy.update_checkout(repos.server)
        assert repos.git(repos.server, "rev-parse", "HEAD") == mine

    def test_edits_to_tracked_files_stop_it(self, repos):
        (repos.server / "app.txt").write_text("edited here\n")
        with pytest.raises(ValueError, match="edits to tracked files"):
            deploy.update_checkout(repos.server)
        assert (repos.server / "app.txt").read_text() == "edited here\n"


class TestCommandLine:
    def test_publishing_needs_root_and_says_how(self, monkeypatch, tmp_path):
        monkeypatch.setattr(deploy.os, "geteuid", lambda: 1000)
        monkeypatch.setattr(deploy, "build", lambda: pytest.fail("built without root"))
        path = settings_file(tmp_path, domain="brush.example.com")
        with pytest.raises(SystemExit, match=r"as root \(sudo python3 deploy/deploy.py publish\)"):
            deploy.main(["--config", str(path)])

    def test_without_settings_it_says_how_to_configure(self, tmp_path):
        with pytest.raises(SystemExit, match="deploy.py configure"):
            deploy.main(["--dry-run", "--config", str(tmp_path / "none.json")])

    def test_a_dry_run_needs_no_root_and_publishes_nothing(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setattr(deploy.os, "geteuid", lambda: 1000)
        monkeypatch.setattr(deploy, "build", lambda: built(tmp_path))
        monkeypatch.setattr(deploy.install, "install", lambda *a: pytest.fail("installed"))
        path = settings_file(tmp_path, domain="brush.example.com", icp_number=ICP)
        deploy.main(["--dry-run", "--config", str(path)])
        staged = Path(capsys.readouterr().out.split("Staged at ")[1].split(";")[0])
        assert json.loads((staged / "site.json").read_text(encoding="utf-8"))["icp"] == ICP
        shutil.rmtree(staged)

    def test_publishing_installs_the_staged_site_and_checks_it(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setattr(deploy.os, "geteuid", lambda: 0)
        monkeypatch.setattr(deploy, "build", lambda: built(tmp_path))
        got = {}
        def install(server, src, domain):
            got.update(domain=domain, files=sorted(p.name for p in Path(src).iterdir()), src=src)
            return built(tmp_path / "release")
        monkeypatch.setattr(deploy.install, "install", install)
        monkeypatch.setattr(deploy, "verify", lambda domain, release: True)
        path = settings_file(tmp_path, domain="brush.example.com", icp_number=ICP)
        deploy.main(["--config", str(path)])
        assert got["domain"] == "brush.example.com"
        assert got["files"] == ["assets", "index.html", "site.json"]
        assert not Path(got["src"]).exists()  # the staging copy is cleaned up
        assert "Published https://brush.example.com/ (checked)" in capsys.readouterr().out

    def test_a_site_that_does_not_show_up_is_an_error(self, monkeypatch, tmp_path):
        monkeypatch.setattr(deploy.os, "geteuid", lambda: 0)
        monkeypatch.setattr(deploy, "build", lambda: built(tmp_path))
        monkeypatch.setattr(deploy.install, "install", lambda *a: built(tmp_path / "release"))
        monkeypatch.setattr(deploy, "verify", lambda domain, release: False)
        with pytest.raises(SystemExit, match="does not serve it"):
            deploy.main(["--config", str(settings_file(tmp_path, domain="brush.example.com"))])
