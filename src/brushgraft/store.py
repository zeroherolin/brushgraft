"""Project data: metadata in SQLite, images as content-addressed files.

The data model is a tree of image versions:
  - node: one image. Roots are uploads or images generated from scratch; every
    other node is an edit of its parent;
  - job: one operation (an edge of the tree) recording the prompt, regions,
    references and model settings. A job sends n requests and yields up to n
    sibling nodes (variants).

The asset library holds images every project can use as references. A job
records the image of each reference as it was sent, so what made a version
stays known after the reference (a version or an asset) is deleted.

Image files never change and identical content is stored once. Images no
longer referenced after a delete are removed on the next start.
"""

import contextlib
import hashlib
import io
import json
import os
import secrets
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

import promptbrush as pb

from brushgraft.errors import NotFound, UserError

DB_FILE = "brushgraft.sqlite3"
SCHEMA_VERSION = 4
# A reference to an asset, in a job's refs (anything else is a version's id)
ASSET_REF = "asset:"
THUMB_EDGE = 384
# The largest image taken in (an upload, a project file, a model's output): 100 MP decodes to
# 400 MB. Pillow alone stops only at 179 MP, and a file of a few hundred KB can claim that many
MAX_IMAGE_PIXELS = 100_000_000
# Pillow warns past its own limit, and stops at twice it: ours is checked first, with a clear error
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

# Codes stored in nodes.note; the web UI shows them in the user's language.
NOTE_SPILL_GROWN = "spill_grown"          # paste-back area grown to keep new content
NOTE_SPILL_TOO_LARGE = "spill_too_large"  # new content spread too far; region only
NOTE_ASPECT_MISMATCH = "aspect_mismatch"  # output aspect differs; not pasted back
NOTE_REFRAMED = "reframed"                # same aspect but redrawn; not pasted back
NOTE_PASTE_FAILED = "paste_failed"        # pasting back failed; the whole output is kept
NOTE_OVERALL = "overall_change"           # the overall request changed the whole image; whole
                                          # output adopted, the pasted-back one kept beside it
NOTE_PART_FAILED = "part_failed"          # of an edit sent in several requests, some failed:
                                          # their regions are left as they were
NOTE_TOO_LARGE = "too_large"              # too large to paste back in this browser; whole output

_SCHEMA = """
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
    kind         TEXT NOT NULL,             -- generate | edit
    prompt       TEXT NOT NULL,             -- the user's overall request
    full_prompt  TEXT NOT NULL,             -- the prompt actually sent
    regions      TEXT NOT NULL,             -- JSON
    refs         TEXT NOT NULL,             -- JSON: node ids, or "asset:" + an asset id
    ref_images   TEXT NOT NULL DEFAULT '[]', -- JSON: each reference's image as sent (or null)
    model        TEXT NOT NULL,
    size         TEXT NOT NULL,
    n            INTEGER NOT NULL,
    composite    INTEGER NOT NULL,          -- paste the regions back onto the parent
    mask_image   TEXT,                      -- region mask (white = selected)
    annot_image  TEXT,                      -- annotated copy sent to the model
    requests     TEXT NOT NULL DEFAULT '[]', -- JSON: an edit sent in parts, each request
                                            -- [{prompt, box, regions, size, annot_image}]
    status       TEXT NOT NULL,             -- queued | running | done | failed
    done         INTEGER NOT NULL DEFAULT 0,
    failed       INTEGER NOT NULL DEFAULT 0,
    errors       TEXT NOT NULL DEFAULT '[]', -- JSON: [{code, detail, variant}]
    usage        TEXT,                      -- JSON: usage summed over requests
    created_at   REAL NOT NULL,
    finished_at  REAL
);
CREATE TABLE IF NOT EXISTS nodes (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id    TEXT REFERENCES nodes(id) ON DELETE CASCADE,
    job_id       TEXT REFERENCES jobs(id) ON DELETE CASCADE,
    image        TEXT NOT NULL REFERENCES images(sha),  -- the adopted image
    raw_image    TEXT REFERENCES images(sha),  -- the model's whole output (if pasted back)
    merged_image TEXT REFERENCES images(sha),  -- the pasted-back result (if pasted back)
    note         TEXT NOT NULL DEFAULT '',     -- a NOTE_* code
    parts        TEXT NOT NULL DEFAULT '[]',   -- JSON: for an edit sent in several requests, what
                                               -- each made on its own (see add_node)
    label        TEXT NOT NULL DEFAULT '',     -- uploaded file name or user label
    starred      INTEGER NOT NULL DEFAULT 0,
    created_at   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    image       TEXT NOT NULL UNIQUE REFERENCES images(sha),  -- an image is in the library once
    created_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_project ON nodes(project_id);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS jobs_parent ON jobs(parent_id);
"""

_JSON_FIELDS = ("regions", "refs", "ref_images", "requests", "errors", "usage", "parts")


def new_id() -> str:
    return secrets.token_hex(6)


def _publish(tmp: str, path: Path) -> None:
    """Move a finished temp file to its content-addressed name.

    Another thread may have stored the same content a moment ago; on Windows
    that makes the rename fail while the target is in use. The name is the
    content, so if the target exists there is nothing left to do.
    """
    try:
        os.replace(tmp, path)
    except OSError:
        if not path.exists():
            raise
        os.unlink(tmp)


class Store:
    """Thread-safe: every query goes through one connection behind a lock."""

    def __init__(self, home: Path):
        self.home = home
        self.image_dir = home / "images"
        self.thumb_dir = home / "thumbs"
        for d in (home, self.image_dir, self.thumb_dir):
            d.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(home / DB_FILE, check_same_thread=False,
                                   isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.execute("PRAGMA journal_mode = WAL")
        version = self._db.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError(f"{home / DB_FILE} was created by a newer "
                               "brushgraft; upgrade to open it")
        if version == 0:  # a new workspace
            self._db.executescript(_SCHEMA)
            self._db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        elif version < SCHEMA_VERSION:
            # all or nothing: a migration cut short would otherwise run again on a half-changed
            # database and fail on a column it already added
            self._db.execute("BEGIN")
            try:
                for statement in _SCHEMA.split(";"):
                    if statement.strip():
                        self._db.execute(statement)
                if version == 1:
                    self._migrate_from_1()
                if version in (1, 2):
                    # version 3: jobs.requests
                    self._db.execute(
                        "ALTER TABLE jobs ADD COLUMN requests TEXT NOT NULL DEFAULT '[]'")
                if version in (1, 2, 3):
                    # version 4: nodes.parts
                    self._db.execute(
                        "ALTER TABLE nodes ADD COLUMN parts TEXT NOT NULL DEFAULT '[]'")
                self._db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise

    def _migrate_from_1(self) -> None:
        """Version 2 adds the asset library (made by _SCHEMA) and jobs.ref_images: filled in
        from the references that still exist."""
        self._db.execute("ALTER TABLE jobs ADD COLUMN ref_images TEXT NOT NULL DEFAULT '[]'")
        images = dict(self._db.execute("SELECT id, image FROM nodes").fetchall())
        for job_id, refs in self._db.execute("SELECT id, refs FROM jobs WHERE refs != '[]'"
                                             ).fetchall():
            shas = [images.get(r) for r in json.loads(refs)]
            self._db.execute("UPDATE jobs SET ref_images = ? WHERE id = ?",
                             (json.dumps(shas), job_id))

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # -- low level ----------------------------------------------------------
    def _exec(self, sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, params)

    def _rows(self, sql: str, params: tuple | dict = ()) -> list[dict]:
        with self._lock:
            return [_decode(r) for r in self._db.execute(sql, params)]

    def _one(self, sql: str, params: tuple | dict, what: str, ident: str) -> dict:
        rows = self._rows(sql, params)
        if not rows:
            raise NotFound(what, ident)
        return rows[0]

    # -- images -------------------------------------------------------------
    def put_image(self, data: bytes) -> dict:
        """Store image bytes (reusing an identical copy); return {sha, width, height}."""
        ext = pb.detect_image_ext(data)
        if ext is None:
            raise UserError("not_an_image",
                            "Only PNG, JPEG, WebP and GIF images are supported")
        with Image.open(io.BytesIO(data)) as im:
            width, height = im.size
        if width * height > MAX_IMAGE_PIXELS:
            raise UserError("image_too_large", f"The image is {width} × {height}; at most "
                            f"{MAX_IMAGE_PIXELS // 1_000_000} megapixels can be used",
                            width=width, height=height, max_mp=MAX_IMAGE_PIXELS // 1_000_000)
        sha = hashlib.sha256(data).hexdigest()
        path = self._image_file(sha, ext)
        # a copy cut short by a power cut (the rename got to the disk, the data didn't) is replaced
        if not path.exists() or path.stat().st_size != len(data):
            path.parent.mkdir(exist_ok=True)
            # Write then rename, so a crash never leaves half an image behind
            fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".part")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())
                _publish(tmp, path)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise
        self._exec("INSERT OR IGNORE INTO images VALUES (?, ?, ?, ?, ?)",
                   (sha, ext, width, height, len(data)))
        return {"sha": sha, "width": width, "height": height}

    def image_info(self, sha: str) -> dict:
        return self._one("SELECT * FROM images WHERE sha = ?", (sha,), "image", sha)

    def image_path(self, sha: str) -> Path:
        return self._image_file(sha, self.image_info(sha)["ext"])

    def read_image(self, sha: str) -> bytes:
        return self.image_path(sha).read_bytes()

    def thumb_path(self, sha: str) -> Path:
        """Thumbnail (WebP, long edge THUMB_EDGE), made on first request."""
        path = self.thumb_dir / sha[:2] / f"{sha}.webp"
        if not path.exists():
            with Image.open(self.image_path(sha)) as im:
                im = ImageOps.exif_transpose(im)
                im.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.Resampling.LANCZOS)
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGBA" if im.has_transparency_data else "RGB")
                path.parent.mkdir(exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".part")
                with os.fdopen(fd, "wb") as f:
                    im.save(f, "WEBP", quality=82)
                _publish(tmp, path)
        return path

    def _image_file(self, sha: str, ext: str) -> Path:
        return self.image_dir / sha[:2] / f"{sha}{ext}"

    def collect_garbage(self) -> int:
        """Delete images no node, job or asset refers to; return how many were deleted."""
        with self._lock:
            unused = [r["sha"] for r in self._db.execute("""
                SELECT sha FROM images WHERE sha NOT IN (
                    SELECT image FROM nodes
                    UNION SELECT raw_image FROM nodes WHERE raw_image IS NOT NULL
                    UNION SELECT merged_image FROM nodes WHERE merged_image IS NOT NULL
                    UNION SELECT mask_image FROM jobs WHERE mask_image IS NOT NULL
                    UNION SELECT annot_image FROM jobs WHERE annot_image IS NOT NULL
                    UNION SELECT r.value FROM jobs, json_each(jobs.ref_images) r
                        WHERE r.value IS NOT NULL
                    UNION SELECT json_extract(r.value, '$.annot_image')
                        FROM jobs, json_each(jobs.requests) r
                        WHERE json_extract(r.value, '$.annot_image') IS NOT NULL
                    UNION SELECT json_extract(p.value, '$.raw_image')
                        FROM nodes, json_each(nodes.parts) p
                        WHERE json_extract(p.value, '$.raw_image') IS NOT NULL
                    UNION SELECT json_extract(p.value, '$.merged_image')
                        FROM nodes, json_each(nodes.parts) p
                        WHERE json_extract(p.value, '$.merged_image') IS NOT NULL
                    UNION SELECT image FROM assets)
            """)]
            for sha in unused:
                info = self.image_info(sha)
                self._image_file(sha, info["ext"]).unlink(missing_ok=True)
                (self.thumb_dir / sha[:2] / f"{sha}.webp").unlink(missing_ok=True)
                self._db.execute("DELETE FROM images WHERE sha = ?", (sha,))
        return len(unused)

    # -- projects -----------------------------------------------------------
    def list_projects(self) -> list[dict]:
        return self._rows("""
            SELECT p.*, (SELECT COUNT(*) FROM nodes WHERE project_id = p.id)
                AS node_count
            FROM projects p ORDER BY updated_at DESC""")

    def get_project(self, project_id: str) -> dict:
        return self._one("SELECT * FROM projects WHERE id = ?", (project_id,),
                         "project", project_id)

    def create_project(self, name: str) -> dict:
        now = time.time()
        pid = new_id()
        self._exec("INSERT INTO projects VALUES (?, ?, ?, ?)",
                   (pid, name, now, now))
        return self.get_project(pid)

    def rename_project(self, project_id: str, name: str) -> dict:
        self.get_project(project_id)
        self._exec("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
                   (name, time.time(), project_id))
        return self.get_project(project_id)

    def delete_project(self, project_id: str) -> None:
        self.get_project(project_id)
        with self._lock:
            active = self._db.execute(
                "SELECT COUNT(*) FROM jobs WHERE project_id = ? "
                "AND status IN ('queued', 'running')", (project_id,)).fetchone()[0]
            if active:
                raise UserError("project_busy",
                                "Jobs in this project are still generating; "
                                "delete it once they finish")
            roots = [r[0] for r in self._db.execute(
                "SELECT id FROM nodes WHERE project_id = ? AND parent_id IS NULL", (project_id,))]
            self._delete_subtrees(roots,
                                  lambda: self._db.execute("DELETE FROM projects WHERE id = ?",
                                                           (project_id,)))

    def touch_project(self, project_id: str) -> None:
        self._exec("UPDATE projects SET updated_at = ? WHERE id = ?",
                   (time.time(), project_id))

    def project_tree(self, project_id: str) -> dict:
        """Every node and job of a project; the web UI assembles the tree."""
        self.get_project(project_id)
        return {
            "nodes": self._rows(_NODE_SELECT + " WHERE n.project_id = ? "
                                "ORDER BY n.created_at", (project_id,)),
            "jobs": self._rows("SELECT * FROM jobs WHERE project_id = ? "
                               "ORDER BY created_at", (project_id,)),
        }

    def project_images(self, project_id: str) -> dict[str, bytes]:
        """Every image the project's versions and jobs refer to: {sha: bytes}."""
        return {sha: self.read_image(sha) for sha in self.project_image_shas(project_id)}

    def project_image_shas(self, project_id: str) -> set[str]:
        """Every image the project's versions and jobs refer to."""
        tree = self.project_tree(project_id)
        shas: set[str] = set()
        for n in tree["nodes"]:
            shas.update(s for s in (n["image"], n["raw_image"], n["merged_image"],
                                    *part_images(n)) if s)
        for j in tree["jobs"]:
            shas.update(s for s in (j["mask_image"], j["annot_image"], *j["ref_images"],
                                    *(r["annot_image"] for r in j["requests"])) if s)
        return shas

    def import_project(self, project: dict, nodes: list[dict], jobs: list[dict],
                       images: dict[str, bytes]) -> dict:
        """Add a project read from an archive (see brushgraft.archive); jobs come in settled.

        Ids are already fresh. Everything goes in one transaction, so a failure leaves nothing
        half imported; the images are stored first (identical ones are reused).
        """
        for data in images.values():
            self.put_image(data)
        pid = new_id()
        with self._lock:
            self._db.execute("BEGIN")
            try:
                # jobs and versions refer to each other: check the links when everything is in
                self._db.execute("PRAGMA defer_foreign_keys = ON")
                self._db.execute("INSERT INTO projects VALUES (?, ?, ?, ?)",
                                 (pid, project["name"], project["created_at"],
                                  project["updated_at"]))
                for j in jobs:
                    fields = {**j, "project_id": pid, "composite": int(j["composite"]),
                              "regions": json.dumps(j["regions"], ensure_ascii=False),
                              "refs": json.dumps(j["refs"]),
                              "ref_images": json.dumps(j["ref_images"]),
                              "requests": json.dumps(j["requests"], ensure_ascii=False),
                              "errors": json.dumps(j["errors"], ensure_ascii=False),
                              "usage": json.dumps(j["usage"]) if j["usage"] else None}
                    # a job that was still running when it was exported never finishes here
                    if fields["status"] in ("queued", "running"):
                        fields["status"] = "done" if fields["done"] else "failed"
                        fields["errors"] = json.dumps(
                            j["errors"] + [{"code": "interrupted", "detail": "", "variant": ""}],
                            ensure_ascii=False)
                    cols = ", ".join(fields)
                    marks = ", ".join(f":{k}" for k in fields)
                    self._db.execute(f"INSERT INTO jobs ({cols}) VALUES ({marks})", fields)
                for n in nodes:
                    self._db.execute(
                        """INSERT INTO nodes (id, project_id, parent_id, job_id, image, raw_image,
                           merged_image, note, parts, label, starred, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (n["id"], pid, n["parent_id"], n["job_id"], n["image"], n["raw_image"],
                         n["merged_image"], n["note"], json.dumps(n["parts"]), n["label"],
                         int(n["starred"]), n["created_at"]))
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
        return self.get_project(pid)

    # -- assets -------------------------------------------------------------
    def list_assets(self) -> list[dict]:
        return self._rows(_ASSET_SELECT + " ORDER BY a.created_at DESC")

    def get_asset(self, asset_id: str) -> dict:
        return self._one(_ASSET_SELECT + " WHERE a.id = ?", (asset_id,), "asset", asset_id)

    def add_asset(self, image: str, name: str) -> dict:
        """Put a stored image in the library; an image already there is returned as it is."""
        self.image_info(image)
        self._exec("INSERT OR IGNORE INTO assets VALUES (?, ?, ?, ?)",
                   (new_id(), name, image, time.time()))
        return self._one(_ASSET_SELECT + " WHERE a.image = ?", (image,), "asset", image)

    def rename_asset(self, asset_id: str, name: str) -> dict:
        self.get_asset(asset_id)
        self._exec("UPDATE assets SET name = ? WHERE id = ?", (name, asset_id))
        return self.get_asset(asset_id)

    def delete_asset(self, asset_id: str) -> None:
        """Take an asset out of the library. Versions made with it keep its image (their jobs
        refer to it); it goes with the next clean-up once nothing does."""
        self.get_asset(asset_id)
        self._exec("DELETE FROM assets WHERE id = ?", (asset_id,))

    def import_assets(self, assets: list[dict], images: dict[str, bytes]) -> tuple[int, int]:
        """Add assets read from an asset pack: (added, skipped as already in the library)."""
        for data in images.values():
            self.put_image(data)
        added = 0
        with self._lock:
            self._db.execute("BEGIN")
            try:
                for a in assets:
                    added += self._db.execute(
                        "INSERT OR IGNORE INTO assets VALUES (?, ?, ?, ?)",
                        (new_id(), a["name"], a["image"], a["created_at"])).rowcount
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
        return added, len(assets) - added

    # -- nodes --------------------------------------------------------------
    def get_node(self, node_id: str) -> dict:
        return self._one(_NODE_SELECT + " WHERE n.id = ?", (node_id,),
                         "version", node_id)

    def add_node(self, *, project_id: str, image: str,
                 parent_id: str | None = None, job_id: str | None = None,
                 raw_image: str | None = None, merged_image: str | None = None,
                 note: str = "", label: str = "", parts: list[dict] | None = None) -> dict:
        """Add a version. With ``raw_image`` (the model's whole output) there is a pasted-back
        result too: ``merged_image``, by default ``image`` itself.

        ``parts``, for an edit sent in several requests: what each made on its own, to be looked
        at, as {"request": its index in jobs.requests, "note", "raw_image", "raw_at",
        "merged_image", "merged_at"}: its output, and its regions pasted back onto the original
        (null when they can't be), each an image to put on the parent's image at [x, y].
        """
        nid = new_id()
        merged = (merged_image or image) if raw_image else None
        self._exec("""INSERT INTO nodes (id, project_id, parent_id, job_id,
                      image, raw_image, merged_image, note, parts, label, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                   (nid, project_id, parent_id, job_id, image, raw_image,
                    merged, note, json.dumps(parts or []), label, time.time()))
        self.touch_project(project_id)
        return self.get_node(nid)

    def update_node(self, node_id: str, *, starred: bool | None = None,
                    label: str | None = None,
                    use_raw: bool | None = None) -> dict:
        node = self.get_node(node_id)
        if starred is not None:
            self._exec("UPDATE nodes SET starred = ? WHERE id = ?",
                       (int(starred), node_id))
        if label is not None:
            self._exec("UPDATE nodes SET label = ? WHERE id = ?",
                       (label, node_id))
        if use_raw is not None:
            if not (node["raw_image"] and node["merged_image"]):
                raise UserError("no_alternative",
                                "This version wasn't pasted back, so there is "
                                "nothing to switch to")
            with self._lock:
                # Later versions, and jobs still generating or failed (to retry), were made
                # from the adopted image: swapping it would break that link, and their regions
                # would no longer fit
                children = self._db.execute(
                    "SELECT COUNT(*) FROM nodes WHERE parent_id = ?",
                    (node_id,)).fetchone()[0]
                active = self._db.execute(
                    "SELECT COUNT(*) FROM jobs WHERE parent_id = ? "
                    "AND status != 'done'", (node_id,)).fetchone()[0]
                if children or active:
                    raise UserError("has_successors",
                                    "This version has later versions or unfinished jobs; "
                                    "its image can no longer change")
                self._db.execute(
                    "UPDATE nodes SET image = ? WHERE id = ?",
                    (node["raw_image"] if use_raw else node["merged_image"],
                     node_id))
        return self.get_node(node_id)

    def delete_node(self, node_id: str) -> None:
        """Delete a node and its whole subtree.

        Refused while a job in the subtree is still running: those requests
        are most likely billed already, and their results must have somewhere
        to go.
        """
        self.get_node(node_id)
        with self._lock:
            if self._active_jobs_under([node_id]):
                raise UserError("branch_busy",
                                "A version in this branch is still generating; "
                                "delete it once that finishes")
            self._delete_subtrees([node_id])

    def _delete_subtrees(self, node_ids: list[str], then=None) -> None:
        """Delete these nodes and everything under them, the deepest first, in one transaction
        (then ``then``). The foreign-key cascade alone would nest a trigger per generation, and
        SQLite stops at 1000: a long chain of edits couldn't be deleted."""
        marks = ", ".join("?" * len(node_ids))
        rows = self._db.execute(f"""
            WITH RECURSIVE sub(id, depth) AS (
                SELECT id, 0 FROM nodes WHERE id IN ({marks}) UNION ALL
                SELECT n.id, sub.depth + 1 FROM nodes n JOIN sub ON n.parent_id = sub.id)
            SELECT id FROM sub ORDER BY depth DESC""", node_ids).fetchall() if node_ids else []
        self._db.execute("BEGIN")
        try:
            self._db.executemany("DELETE FROM nodes WHERE id = ?", rows)
            if then:
                then()
            self._db.execute("COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK")
            raise

    def _active_jobs_under(self, node_ids: list[str]) -> int:
        """How many queued or running jobs sit in the subtrees of these nodes."""
        if not node_ids:
            return 0
        marks = ", ".join("?" * len(node_ids))
        return self._db.execute(f"""
            WITH RECURSIVE sub(id) AS (
                SELECT id FROM nodes WHERE id IN ({marks}) UNION ALL
                SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
            SELECT COUNT(*) FROM jobs
            WHERE parent_id IN sub AND status IN ('queued', 'running')
        """, node_ids).fetchone()[0]

    # -- jobs ---------------------------------------------------------------
    def create_job(self, *, parent_image: str | None = None, **fields: Any) -> dict:
        """Add a job. ``parent_image`` is the parent's image the request was prepared from: if
        the version adopted another one meanwhile (Whole output), the job is refused."""
        fields = {"id": new_id(), "status": "queued", "created_at": time.time(),
                  **fields}
        for key in _JSON_FIELDS:
            if key in fields:
                fields[key] = json.dumps(fields[key], ensure_ascii=False)
        if "composite" in fields:
            fields["composite"] = int(fields["composite"])
        cols = ", ".join(fields)
        marks = ", ".join(f":{k}" for k in fields)
        with self._lock:  # the same lock as update_node's switch
            if parent_image and self.get_node(fields["parent_id"])["image"] != parent_image:
                raise UserError("parent_changed", "This version's image changed while the "
                                "request was being prepared; send it again")
            self._exec(f"INSERT INTO jobs ({cols}) VALUES ({marks})", fields)
        self.touch_project(fields["project_id"])
        return self.get_job(fields["id"])

    def get_job(self, job_id: str) -> dict:
        return self._one("SELECT * FROM jobs WHERE id = ?", (job_id,), "job", job_id)

    def set_job_running(self, job_id: str) -> None:
        self._exec("UPDATE jobs SET status = 'running' "
                   "WHERE id = ? AND status = 'queued'", (job_id,))

    def record_attempt(self, job_id: str, *, ok: bool, error: dict | None = None,
                       usage: dict | None = None) -> dict:
        """Record one request's outcome; once all n are in, mark the job done/failed.

        ``error`` is ``{"code", "detail", "variant"}`` (see JobRunner).
        """
        with self._lock:
            job = self.get_job(job_id)
            errors = job["errors"] + ([error] if error else [])
            total = add_usage(job["usage"], usage)
            done = job["done"] + int(ok)
            failed = job["failed"] + int(not ok)
            status, finished = job["status"], None
            if done + failed >= job["n"]:
                status = "done" if done else "failed"
                finished = time.time()
            self._db.execute(
                """UPDATE jobs SET done = ?, failed = ?, errors = ?, usage = ?,
                   status = ?, finished_at = ? WHERE id = ?""",
                (done, failed, json.dumps(errors, ensure_ascii=False),
                 json.dumps(total) if total else None, status, finished,
                 job_id))
            return self.get_job(job_id)

    def add_job_request(self, job_id: str, request: dict) -> int:
        """Record a request a job sent besides those it was made with (the whole image, for an
        edit sent in close-ups), once; return its index in jobs.requests."""
        with self._lock:
            requests = self.get_job(job_id)["requests"]
            if request in requests:
                return requests.index(request)
            self._db.execute("UPDATE jobs SET requests = ? WHERE id = ?",
                             (json.dumps(requests + [request], ensure_ascii=False), job_id))
            return len(requests)

    def delete_job(self, job_id: str) -> None:
        """Delete a job with the nodes it produced (and their subtrees)."""
        job = self.get_job(job_id)
        if job["status"] in ("queued", "running"):
            raise UserError("job_active", "This job is still running")
        with self._lock:
            outputs = [r[0] for r in self._db.execute(
                "SELECT id FROM nodes WHERE job_id = ?", (job_id,))]
            if self._active_jobs_under(outputs):
                raise UserError("branch_busy",
                                "A version in this branch is still generating; "
                                "delete it once that finishes")
            # its versions first, the deepest first (see _delete_subtrees), then the job
            self._delete_subtrees(outputs, then=lambda: self._db.execute(
                "DELETE FROM jobs WHERE id = ?", (job_id,)))

    def recover_interrupted(self) -> int:
        """On start, settle jobs left unfinished: done if any image came back."""
        with self._lock:
            jobs = self._rows("SELECT * FROM jobs "
                              "WHERE status IN ('queued', 'running')")
            for job in jobs:
                errors = job["errors"] + [
                    {"code": "interrupted", "detail": "", "variant": ""}]
                self._db.execute(
                    "UPDATE jobs SET status = ?, errors = ?, finished_at = ? "
                    "WHERE id = ?",
                    ("done" if job["done"] else "failed",
                     json.dumps(errors, ensure_ascii=False), time.time(),
                     job["id"]))
            return len(jobs)


_NODE_SELECT = """
SELECT n.*, i.width, i.height FROM nodes n JOIN images i ON i.sha = n.image
"""
_ASSET_SELECT = """
SELECT a.*, i.width, i.height FROM assets a JOIN images i ON i.sha = a.image
"""


def part_images(node: dict) -> list[str]:
    """The images a version's parts refer to (see Store.add_node)."""
    return [s for p in node.get("parts") or () for s in (p["raw_image"], p["merged_image"]) if s]


def _decode(row: sqlite3.Row) -> dict:
    d = dict(row)
    for key in _JSON_FIELDS:
        if key in d and isinstance(d[key], str):
            d[key] = json.loads(d[key])
    for key in ("starred", "composite"):
        if key in d:
            d[key] = bool(d[key])
    return d


def add_usage(total: dict | None, usage: dict | None) -> dict | None:
    if not usage:
        return total
    total = dict(total or {})
    for key, value in usage.items():
        if isinstance(value, (int, float)):
            total[key] = total.get(key, 0) + value
    return total
