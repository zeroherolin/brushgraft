"""Tests run fully offline: outside connections are blocked and
promptbrush.create_image is replaced by a local fake."""

import io
import os
import random
import threading
import time

import pytest
import urllib3.util.connection
from fastapi.testclient import TestClient
from PIL import Image

import promptbrush as pb

from brushgraft.app import create_app
from brushgraft.config import ENV_PREFIXES, Settings
from brushgraft.store import Store

TOKEN = "test-token"


def assert_private(path) -> None:
    """The file is readable and writable by its owner only (POSIX; Windows has
    no permission bits to check)."""
    if os.name != "nt":
        assert os.stat(path).st_mode & 0o777 == 0o600
_LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    """Block the network and clear real settings: no paid calls, no real keys."""
    real_connect = urllib3.util.connection.create_connection

    def loopback_only(address, *args, **kwargs):
        if address[0] not in _LOOPBACK:
            raise AssertionError(f"tests may not reach the network: {address[0]}")
        return real_connect(address, *args, **kwargs)

    monkeypatch.setattr(urllib3.util.connection, "create_connection",
                        loopback_only)
    for key in list(os.environ):
        if key.startswith(ENV_PREFIXES) or key == "BRUSHGRAFT_HOME":
            monkeypatch.delenv(key)


def make_png(size=(64, 48), color=(200, 30, 30), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, "PNG")
    return buf.getvalue()


def noise_png(size=(320, 240), seed=0) -> bytes:
    """Random noise: any changed pixel shows up in a comparison."""
    rnd = random.Random(seed)
    im = Image.frombytes("RGB", size, bytes(rnd.randrange(256)
                                            for _ in range(size[0] * size[1] * 3)))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


class FakeAPI:
    """Stands in for promptbrush.create_image: records calls, answers via respond."""

    def __init__(self):
        self.calls: list[dict] = []
        self.lock = threading.Lock()
        self.respond = lambda call: pb.Generation(
            [make_png((96, 64), (255, 255, 255))], {"total_tokens": 10}, 0.1)

    def __call__(self, prompt, **kwargs):
        call = {"prompt": prompt, **kwargs}
        with self.lock:
            self.calls.append(call)
        pb.log("info", "fake API got a request")
        return self.respond(call)


@pytest.fixture
def fake_api(monkeypatch):
    fake = FakeAPI()
    monkeypatch.setattr(pb, "create_image", fake)
    return fake


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "home")
    yield s
    s.close()


@pytest.fixture
def settings(tmp_path):
    env = tmp_path / "home" / ".env"
    env.parent.mkdir(parents=True, exist_ok=True)
    env.write_text("BRUSHGRAFT_API_KEY=sk-test\n")
    return Settings(env)


@pytest.fixture
def app(store, settings, fake_api):
    return create_app(store, settings, TOKEN,
                      allowed_hosts=frozenset({"testserver"}))


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        assert c.post("/api/session", json={"token": TOKEN}).status_code == 204
        yield c


@pytest.fixture
def project(client):
    return client.post("/api/projects", json={"name": "Test"}).json()


def wait_job(client, project_id, job_id, timeout=60) -> dict:
    """Wait for a job to finish (it runs in the thread pool); return the job. The limit only
    catches a job that never ends: an edit sent in parts pastes back on a large image, under 4 s
    here and three times that on a shared CI machine."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        tree = client.get(f"/api/projects/{project_id}/tree").json()
        job = next(j for j in tree["jobs"] if j["id"] == job_id)
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} didn't finish in time")
