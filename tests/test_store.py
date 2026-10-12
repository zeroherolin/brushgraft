import os

import pytest
from PIL import Image

from brushgraft.config import AlreadyRunning, Settings, load_or_create_token, lock_home
from brushgraft.errors import NotFound, UserError
from brushgraft.store import Store

from .conftest import assert_private, make_png


V1_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
    sha     TEXT PRIMARY KEY,
    ext     TEXT NOT NULL,
    width   INTEGER NOT NULL,
    height  INTEGER NOT NULL,
    bytes   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id    TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    full_prompt  TEXT NOT NULL,
    regions      TEXT NOT NULL,
    refs         TEXT NOT NULL,
    model        TEXT NOT NULL,
    size         TEXT NOT NULL,
    n            INTEGER NOT NULL,
    composite    INTEGER NOT NULL,
    mask_image   TEXT,
    annot_image  TEXT,
    status       TEXT NOT NULL,
    done         INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    errors       TEXT NOT NULL DEFAULT '[]',
    usage        TEXT,
    created_at   REAL NOT NULL,
    finished_at  REAL
);
CREATE TABLE IF NOT EXISTS nodes (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id    TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    job_id       TEXT REFERENCES jobs(id) ON DELETE CASCADE,
    image        TEXT NOT NULL REFERENCES images(sha),
    raw_image    TEXT REFERENCES images(sha),
    merged_image TEXT REFERENCES images(sha),
    note         TEXT NOT NULL DEFAULT '',
    label        TEXT NOT NULL DEFAULT '',
    starred      INTEGER NOT NULL DEFAULT 0,
    created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_project ON nodes(project_id);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS jobs_parent ON jobs(parent_id);
"""


def job_fields(project_id, **kw):
    return {"project_id": project_id, "kind": "generate", "prompt": "p",
            "full_prompt": "p", "regions": [], "refs": [], "model": "m",
            "size": "1024x1024", "n": 2, "composite": False, **kw}


class TestImages:
    def test_content_addressed_and_deduplicated(self, store):
        a = store.put_image(make_png())
        b = store.put_image(make_png())
        assert a == b and (a["width"], a["height"]) == (64, 48)
        assert store.image_path(a["sha"]).suffix == ".png"
        assert len(list(store.image_dir.rglob("*.png"))) == 1

    def test_concurrent_identical_writes_both_succeed(self, store, monkeypatch):
        # Windows refuses to replace a file another thread just stored (or is
        # reading): the same content is already there, so that isn't an error
        real_replace = os.replace
        calls = []

        def racing_replace(src, dst):
            if not calls:
                calls.append(src)
                real_replace(src, dst)           # the other thread wins...
                with open(src, "wb"):            # ...and our rename then fails
                    pass
                raise PermissionError("target in use")
            return real_replace(src, dst)

        data = make_png()
        monkeypatch.setattr("brushgraft.store.os.replace", racing_replace)
        info = store.put_image(data)
        assert store.read_image(info["sha"]) == data
        assert not list(store.image_dir.rglob("*.part"))

    def test_rejects_non_image(self, store):
        with pytest.raises(UserError) as exc:
            store.put_image(b"<html>")
        assert exc.value.code == "not_an_image"

    def test_thumbnail_generated_once(self, store):
        sha = store.put_image(make_png((1200, 600)))["sha"]
        path = store.thumb_path(sha)
        assert Image.open(path).size == (384, 192)
        assert store.thumb_path(sha) == path

    def test_garbage_collection_keeps_referenced(self, store):
        p = store.create_project("p")
        kept = store.put_image(make_png(color=(1, 2, 3)))["sha"]
        store.add_node(project_id=p["id"], image=kept)
        orphan = store.put_image(make_png(color=(9, 9, 9)))["sha"]
        store.thumb_path(orphan)
        assert store.collect_garbage() == 1
        store.image_path(kept)
        with pytest.raises(NotFound):
            store.image_path(orphan)
        assert not list(store.thumb_dir.rglob(f"{orphan}*"))


class TestAssets:
    def test_an_image_is_in_the_library_once_and_names_change(self, store):
        sha = store.put_image(make_png(color=(1, 2, 3)))["sha"]
        a = store.add_asset(sha, "hat")
        assert store.add_asset(sha, "hat again")["id"] == a["id"]
        assert (a["width"], a["height"]) == (64, 48)
        assert store.rename_asset(a["id"], "red hat")["name"] == "red hat"
        assert [x["id"] for x in store.list_assets()] == [a["id"]]

    def test_a_deleted_asset_keeps_its_image_while_a_job_used_it(self, store):
        p = store.create_project("p")
        sha = store.put_image(make_png(color=(4, 5, 6)))["sha"]
        a = store.add_asset(sha, "hat")
        store.create_job(**job_fields(p["id"], refs=[f"asset:{a['id']}"], ref_images=[sha]))
        store.delete_asset(a["id"])
        assert store.collect_garbage() == 0
        store.image_path(sha)
        with pytest.raises(NotFound):
            store.get_asset(a["id"])

    def test_importing_skips_what_is_there(self, store):
        data = make_png(color=(7, 7, 7))
        sha = store.put_image(data)["sha"]
        store.add_asset(sha, "mine")
        other = make_png(color=(8, 8, 8))
        import hashlib
        new = hashlib.sha256(other).hexdigest()
        added, skipped = store.import_assets(
            [{"name": "same", "image": sha, "created_at": 1.0},
             {"name": "new", "image": new, "created_at": 2.0}], {sha: data, new: other})
        assert (added, skipped) == (1, 1)
        assert sorted(a["name"] for a in store.list_assets()) == ["mine", "new"]


class TestTree:
    def test_delete_node_removes_subtree_and_child_jobs(self, store):
        p = store.create_project("p")["id"]
        img = store.put_image(make_png())["sha"]
        root = store.add_node(project_id=p, image=img)
        job = store.create_job(**job_fields(p, parent_id=root["id"], kind="edit", n=1))
        child = store.add_node(project_id=p, image=img, parent_id=root["id"],
                               job_id=job["id"])
        store.record_attempt(job["id"], ok=True)
        store.add_node(project_id=p, image=img, parent_id=child["id"])
        other = store.add_node(project_id=p, image=img)

        store.delete_node(root["id"])
        tree = store.project_tree(p)
        assert [n["id"] for n in tree["nodes"]] == [other["id"]]
        assert tree["jobs"] == []

    def test_active_jobs_block_deleting_their_ancestors(self, store):
        p = store.create_project("p")["id"]
        img = store.put_image(make_png())["sha"]
        root = store.add_node(project_id=p, image=img)
        child = store.add_node(project_id=p, image=img, parent_id=root["id"])
        job = store.create_job(**job_fields(p, parent_id=child["id"], kind="edit", n=1))
        for target in (root["id"], child["id"]):
            with pytest.raises(UserError) as exc:
                store.delete_node(target)
            assert exc.value.code == "branch_busy"
        with pytest.raises(UserError) as exc:
            store.delete_project(p)
        assert exc.value.code == "project_busy"
        store.record_attempt(job["id"], ok=False)
        store.delete_node(root["id"])

    def test_switch_between_merged_and_raw(self, store):
        p = store.create_project("p")["id"]
        merged = store.put_image(make_png(color=(1, 1, 1)))["sha"]
        raw = store.put_image(make_png(color=(2, 2, 2)))["sha"]
        node = store.add_node(project_id=p, image=merged, raw_image=raw)
        assert node["merged_image"] == merged
        assert store.update_node(node["id"], use_raw=True)["image"] == raw
        assert store.update_node(node["id"], use_raw=False)["image"] == merged
        job = store.create_job(**job_fields(p, parent_id=node["id"], kind="edit", n=1))
        with pytest.raises(UserError) as exc:  # a job still generating counts too
            store.update_node(node["id"], use_raw=True)
        assert exc.value.code == "has_successors"
        store.record_attempt(job["id"], ok=False)
        store.update_node(node["id"], use_raw=True)
        store.add_node(project_id=p, image=merged, parent_id=node["id"])
        with pytest.raises(UserError) as exc:
            store.update_node(node["id"], use_raw=False)
        assert exc.value.code == "has_successors"
        plain = store.add_node(project_id=p, image=merged)
        with pytest.raises(UserError) as exc:
            store.update_node(plain["id"], use_raw=True)
        assert exc.value.code == "no_alternative"

    def test_node_has_dimensions_and_flags(self, store):
        p = store.create_project("p")["id"]
        node = store.add_node(project_id=p, image=store.put_image(make_png())["sha"],
                              label="cat.png")
        assert (node["width"], node["height"], node["starred"]) == (64, 48, False)
        assert store.update_node(node["id"], starred=True)["starred"] is True

    def test_delete_project_cascades(self, store):
        p = store.create_project("p")["id"]
        store.add_node(project_id=p, image=store.put_image(make_png())["sha"])
        job = store.create_job(**job_fields(p, n=1))
        store.record_attempt(job["id"], ok=True)
        store.delete_project(p)
        assert store.list_projects() == []
        with pytest.raises(NotFound):
            store.project_tree(p)


class TestJobs:
    def test_status_follows_attempts(self, store):
        p = store.create_project("p")["id"]
        job = store.create_job(**job_fields(p))
        assert job["status"] == "queued" and job["regions"] == []
        store.set_job_running(job["id"])
        error = {"code": "api_error", "detail": "HTTP 500", "variant": "1/2"}
        job = store.record_attempt(job["id"], ok=False, error=error)
        assert (job["status"], job["failed"]) == ("running", 1)
        job = store.record_attempt(job["id"], ok=True, usage={"total_tokens": 5})
        assert (job["status"], job["done"], job["errors"], job["usage"]) == \
            ("done", 1, [error], {"total_tokens": 5})
        assert job["finished_at"]

    def test_all_failed(self, store):
        p = store.create_project("p")["id"]
        job = store.create_job(**job_fields(p, n=1))
        assert store.record_attempt(job["id"], ok=False)["status"] == "failed"

    def test_job_with_running_descendants_cannot_be_deleted(self, store):
        p = store.create_project("p")["id"]
        img = store.put_image(make_png())["sha"]
        root = store.add_node(project_id=p, image=img)
        done = store.create_job(**job_fields(p, parent_id=root["id"], kind="edit", n=1))
        out = store.add_node(project_id=p, image=img, parent_id=root["id"], job_id=done["id"])
        store.record_attempt(done["id"], ok=True)
        running = store.create_job(**job_fields(p, parent_id=out["id"], kind="edit", n=1))
        with pytest.raises(UserError) as exc:
            store.delete_job(done["id"])
        assert exc.value.code == "branch_busy"
        store.record_attempt(running["id"], ok=False)
        store.delete_job(done["id"])
        assert [n["id"] for n in store.project_tree(p)["nodes"]] == [root["id"]]

    def test_running_job_cannot_be_deleted(self, store):
        p = store.create_project("p")["id"]
        job = store.create_job(**job_fields(p))
        with pytest.raises(UserError) as exc:
            store.delete_job(job["id"])
        assert exc.value.code == "job_active"

    def test_recover_interrupted(self, tmp_path):
        store = Store(tmp_path)
        p = store.create_project("p")["id"]
        half = store.create_job(**job_fields(p))
        store.record_attempt(half["id"], ok=True)
        lost = store.create_job(**job_fields(p))
        store.close()

        store = Store(tmp_path)
        assert store.recover_interrupted() == 2
        assert store.get_job(half["id"])["status"] == "done"
        lost = store.get_job(lost["id"])
        assert lost["status"] == "failed"
        assert lost["errors"][-1]["code"] == "interrupted"
        store.close()

    def test_a_version_1_database_gets_the_library_and_reference_images(self, tmp_path):
        # made by brushgraft before the asset library: the schema as it was then
        import json
        import sqlite3
        home = tmp_path / "old"
        home.mkdir()
        db = sqlite3.connect(home / "brushgraft.sqlite3")
        db.executescript(V1_SCHEMA)
        db.execute("PRAGMA user_version = 1")
        db.execute("INSERT INTO projects VALUES ('p', 'P', 1, 1)")
        db.execute("INSERT INTO images VALUES (?, '.png', 4, 4, 10)", ("a" * 64,))
        db.execute("INSERT INTO nodes (id, project_id, image, created_at) "
                   "VALUES ('n1', 'p', ?, 1)", ("a" * 64,))
        db.execute("""INSERT INTO jobs (id, project_id, kind, prompt, full_prompt, regions, refs,
                      model, size, n, composite, status, created_at)
                      VALUES ('j', 'p', 'generate', 'x', 'x', '[]', ?, 'm', 'auto', 1, 0,
                      'done', 1)""", (json.dumps(["n1", "gone"]),))
        db.commit()
        db.close()
        store = Store(home)
        assert store.get_job("j")["ref_images"] == ["a" * 64, None]
        assert store.list_assets() == []
        store.close()

    def test_newer_schema_refused(self, tmp_path):
        Store(tmp_path).close()
        import sqlite3
        db = sqlite3.connect(tmp_path / "brushgraft.sqlite3")
        db.execute("PRAGMA user_version = 99")
        db.close()
        with pytest.raises(RuntimeError, match="newer brushgraft"):
            Store(tmp_path)


class TestConfig:
    def test_home_lock_is_exclusive(self, tmp_path):
        first = lock_home(tmp_path)
        with pytest.raises(AlreadyRunning):
            lock_home(tmp_path)
        first.close()
        lock_home(tmp_path).close()

    def test_token_stable_and_private(self, tmp_path):
        token = load_or_create_token(tmp_path)
        assert load_or_create_token(tmp_path) == token
        assert_private(tmp_path / ".token")

    def test_lookup_order(self, tmp_path, monkeypatch):
        env = tmp_path / ".env"
        env.write_text("PROMPTBRUSH_API_KEY=pb-file\n")
        settings = Settings(env)
        assert settings.lookup("API_KEY") == ("pb-file", "file")
        env.write_text("PROMPTBRUSH_API_KEY=pb-file\nBRUSHGRAFT_API_KEY=bg-file\n")
        assert settings.api_key == "bg-file"
        monkeypatch.setenv("PROMPTBRUSH_API_KEY", "pb-env")
        assert settings.lookup("API_KEY") == ("pb-env", "env")
        assert settings.base_url == "https://api.openai.com/v1"

    def test_save_keeps_other_lines_and_is_private(self, tmp_path):
        env = tmp_path / ".env"
        env.write_text("# comment\nOTHER=1\nexport BRUSHGRAFT_API_KEY=old\n")
        settings = Settings(env)
        settings.save(api_key="new", base_url="https://p.example/v1")
        assert env.read_text() == ("# comment\nOTHER=1\nBRUSHGRAFT_API_KEY=new\n"
                                   "BRUSHGRAFT_BASE_URL=https://p.example/v1\n")
        assert_private(env)
        settings.save(base_url="")
        assert "BASE_URL" not in env.read_text()
        with pytest.raises(UserError) as exc:
            settings.save(api_key="has space")
        assert exc.value.code == "invalid_setting"
