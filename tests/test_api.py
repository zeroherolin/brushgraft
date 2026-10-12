import asyncio
import hashlib
import io
from urllib.parse import quote

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageChops, ImageDraw

import promptbrush as pb

from brushgraft import imaging
from brushgraft.events import EventBus

from .conftest import TOKEN, assert_private, make_png, noise_png, wait_job

REGION = {"shapes": [{"type": "rect", "x": 100, "y": 80, "w": 60, "h": 50}],
          "instruction": "a red teapot"}


def upload(client, project_id, data=None, name="cat.png"):
    resp = client.post(f"/api/projects/{project_id}/uploads",
                       files={"file": (name, data or noise_png(), "image/png")})
    assert resp.status_code == 201, resp.text
    return resp.json()


def submit(client, **body):
    return client.post("/api/jobs", json=body)


def scene_png(size=(640, 480), seed=1) -> bytes:
    """A textured picture (see test_imaging.scene), so the paste-back has detail to compare."""
    rng = np.random.RandomState(seed)
    blobs = rng.randint(10, 246, (size[1] // 8, size[0] // 8, 3)).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(blobs).resize(size, Image.Resampling.BICUBIC).save(buf, "PNG")
    return buf.getvalue()


def image(client, sha) -> Image.Image:
    resp = client.get(f"/api/images/{sha}")
    assert resp.status_code == 200
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


class TestSecurity:
    def test_foreign_host_rejected(self, app):
        with TestClient(app) as c:
            resp = c.get("/api/config", headers={"host": "evil.example:7788"})
        assert resp.status_code == 403

    def test_api_needs_token(self, app):
        with TestClient(app) as c:
            assert c.get("/api/config").status_code == 401
            assert c.post("/api/session", json={"token": "wrong"}).status_code == 401
            assert c.get("/api/config", headers={
                "authorization": f"Bearer {TOKEN}"}).status_code == 200
            resp = c.post("/api/session", json={"token": TOKEN})
            assert "httponly" in resp.headers["set-cookie"].lower()
            assert "samesite=strict" in resp.headers["set-cookie"].lower()
            assert c.get("/api/config").status_code == 200

    def test_oversized_request_rejected_before_parsing(self, client, project):
        resp = client.post(f"/api/projects/{project['id']}/uploads",
                           headers={"content-length": str(200 * 1024 * 1024)},
                           content=b"")
        assert resp.status_code == 413

    def test_frontend_page_is_public(self, app):
        with TestClient(app) as c:
            assert c.get("/").status_code == 200


class TestConfigAndSettings:
    def test_config_lists_models(self, client):
        cfg = client.get("/api/config").json()
        names = [m["name"] for m in cfg["models"]]
        assert cfg["default_model"] in names
        flare = next(m for m in cfg["models"] if m["name"] == "gpt-image-2.5-flare")
        assert flare["aligned"] is True and flare["size"] == "exact"
        assert cfg["settings"]["api_key_set"] is True
        assert "sk-test" not in str(cfg)  # the key itself is never sent back

    def test_save_settings(self, client, settings):
        resp = client.put("/api/settings", json={"api_key": "sk-new",
                                                 "base_url": "https://p.example/v1"})
        assert resp.status_code == 200
        assert resp.json()["base_url"] == "https://p.example/v1"
        assert settings.api_key == "sk-new"
        assert_private(settings.env_file)
        for body, code in (({"base_url": "ftp://x"}, "invalid_base_url"),
                           ({"base_url": "p.example/v1"}, "invalid_base_url"),
                           ({"api_key": "a b"}, "invalid_setting")):
            resp = client.put("/api/settings", json=body)
            assert (resp.status_code, resp.json()["code"]) == (400, code)

    def test_removing_the_key_removes_it_under_either_name(self, client, settings):
        # a file written by hand for promptbrush, in Notepad (with a BOM)
        settings.env_file.write_text("\ufeffPROMPTBRUSH_API_KEY=sk-old\nOTHER=1\n", "utf-8")
        assert settings.api_key == "sk-old"
        client.put("/api/settings", json={"api_key": "sk-new"})
        assert settings.api_key == "sk-new"
        assert client.put("/api/settings", json={"api_key": ""}).json()["api_key_set"] is False
        assert settings.api_key == ""
        assert pb.read_env_file(settings.env_file) == {"OTHER": "1"}

    def test_unreadable_env_file_is_reported_not_crashed(self, client, settings):
        settings.env_file.write_bytes(b"\xff\xfe\x80\x81" * 3)
        resp = client.get("/api/config")
        assert (resp.status_code, resp.json()["code"]) == (400, "env_file_unreadable")
        assert resp.json()["params"]["path"] == str(settings.env_file)


class TestProjectsAndNodes:
    def test_crud(self, client):
        p = client.post("/api/projects", json={"name": " Poster "}).json()
        assert p["name"] == "Poster"
        assert client.patch(f"/api/projects/{p['id']}",
                            json={"name": "海报 v2"}).json()["name"] == "海报 v2"  # non-ASCII
        assert [x["name"] for x in client.get("/api/projects").json()] == ["海报 v2"]
        assert client.delete(f"/api/projects/{p['id']}").status_code == 204
        assert client.get(f"/api/projects/{p['id']}/tree").status_code == 404

    def test_upload_star_delete(self, client, project):
        node = upload(client, project["id"], name="../../cat.png")
        assert node["label"] == "cat.png" and node["parent_id"] is None
        assert client.get(f"/api/thumbs/{node['image']}").status_code == 200
        dl = client.get(f"/api/images/{node['image']}?download=cat v1")
        assert "attachment" in dl.headers["content-disposition"]
        assert client.patch(f"/api/nodes/{node['id']}",
                            json={"starred": True}).json()["starred"] is True
        assert client.delete(f"/api/nodes/{node['id']}").status_code == 204
        assert client.get(f"/api/projects/{project['id']}/tree").json()["nodes"] == []

    def test_upload_rejects_non_image(self, client, project):
        resp = client.post(f"/api/projects/{project['id']}/uploads",
                           files={"file": ("x.png", b"<html>", "image/png")})
        assert resp.status_code == 400

    def test_bad_image_hash(self, client):
        assert client.get("/api/images/../../etc/passwd").status_code == 404
        assert client.get("/api/images/" + "0" * 64).status_code == 404


class TestJobs:
    def test_generate(self, client, project, fake_api):
        resp = submit(client, project_id=project["id"], prompt="a cat",
                      model="gpt-image-2", size="1536x1024", n=2)
        assert resp.status_code == 202, resp.text
        job = wait_job(client, project["id"], resp.json()["id"])
        assert (job["status"], job["done"], job["usage"]) == \
            ("done", 2, {"total_tokens": 20})
        assert len(fake_api.calls) == 2
        call = fake_api.calls[0]
        assert (call["prompt"], call["model"], call["size"], call["images"]) == \
            ("a cat", "gpt-image-2", "1536x1024", ())
        assert call["api_key"] == "sk-test"
        nodes = client.get(f"/api/projects/{project['id']}/tree").json()["nodes"]
        assert {n["job_id"] for n in nodes} == {job["id"]}
        logs = client.get(f"/api/jobs/{job['id']}/logs").json()
        assert any("fake API got a request" in line["msg"] for line in logs)
        assert any(line["level"] == "ok" and line["msg"].startswith("[1/2] Done")
                   for line in logs)

    def test_region_edit_composites_back(self, client, project, fake_api):
        def respond(call):
            # what a model does: the same picture, here at twice the size, plus the new object
            im = Image.open(io.BytesIO(noise_png((320, 240)))).convert("RGB")
            im = im.resize((640, 480), Image.Resampling.NEAREST)
            ImageDraw.Draw(im).rectangle((100, 60, 300, 260), fill=(255, 255, 255))
            buf = io.BytesIO()
            im.save(buf, "PNG")
            return pb.Generation([buf.getvalue()], None, 1)

        fake_api.respond = respond
        root = upload(client, project["id"], noise_png((320, 240)))
        resp = submit(client, project_id=project["id"], parent_id=root["id"],
                      regions=[REGION], model="gpt-image-2.5-flare")
        job = wait_job(client, project["id"], resp.json()["id"])
        assert job["status"] == "done", job["errors"]
        assert job["size"] == pb.fit_size(320, 240)  # same aspect as the original
        assert job["mask_image"] and job["annot_image"] and job["composite"]

        call = fake_api.calls[0]
        assert len(call["images"]) == 2  # original + annotated
        assert "Area 1 (red): a red teapot" in call["prompt"]

        (node,) = [n for n in client.get(f"/api/projects/{project['id']}/tree")
                   .json()["nodes"] if n["parent_id"] == root["id"]]
        assert node["raw_image"] and node["raw_image"] != node["image"]
        merged, original = image(client, node["image"]), image(client, root["image"])
        assert merged.size == original.size
        assert merged.getpixel((130, 105)) == (255, 255, 255)
        # pixel-identical outside the region, the new object and the feathered edge (where
        # changed pieces may be taken whole: imaging.whole_pieces)
        outside = Image.new("L", merged.size, 255)
        reach = imaging.PIECE_ZONE * imaging.feather_radius(merged.size)
        outside.paste(0, (40 - reach, 20 - reach, 220 + reach, 190 + reach))
        diff = ImageChops.difference(merged, original).convert("L")
        assert ImageChops.multiply(diff, outside).getbbox() is None

    @staticmethod
    def overcast(call):
        """What a model does with "make the sky overcast": every color goes grey-blue, the
        drawing stays where it was, and the region gets its new object."""
        im = Image.open(io.BytesIO(call["images"][0])).convert("RGB")
        gray = im.convert("L")
        out = Image.merge("RGB", (gray.point(lambda v: v * 0.55 + 20),
                                  gray.point(lambda v: v * 0.6 + 30),
                                  gray.point(lambda v: v * 0.7 + 70)))
        ImageDraw.Draw(out).rectangle((110, 90, 150, 120), fill=(255, 255, 255))
        buf = io.BytesIO()
        out.save(buf, "PNG")
        return pb.Generation([buf.getvalue()], None, 1)

    def test_an_overall_request_that_changed_the_whole_image_is_kept_whole(
            self, client, project, fake_api):
        fake_api.respond = self.overcast
        root = upload(client, project["id"], scene_png())
        job = submit(client, project_id=project["id"], parent_id=root["id"], regions=[REGION],
                     prompt="make the sky overcast", model="gpt-image-2.5-flare").json()
        wait_job(client, project["id"], job["id"])
        (node,) = [n for n in client.get(f"/api/projects/{project['id']}/tree").json()["nodes"]
                   if n["parent_id"] == root["id"]]
        assert node["note"] == "overall_change"
        assert node["image"] == node["raw_image"]  # the whole output is adopted...
        assert node["merged_image"] and node["merged_image"] != node["raw_image"]  # ...and kept
        back = client.patch(f"/api/nodes/{node['id']}", json={"use_raw": False}).json()
        assert back["image"] == node["merged_image"]  # one switch away
        logs = client.get(f"/api/jobs/{job['id']}/logs").json()
        assert any("overall request changed the whole image" in line["msg"] for line in logs)

    def test_the_same_change_without_an_overall_request_is_pasted_back(
            self, client, project, fake_api):
        fake_api.respond = self.overcast
        root = upload(client, project["id"], scene_png())
        job = submit(client, project_id=project["id"], parent_id=root["id"], regions=[REGION],
                     model="gpt-image-2.5-flare").json()
        wait_job(client, project["id"], job["id"])
        (node,) = [n for n in client.get(f"/api/projects/{project['id']}/tree").json()["nodes"]
                   if n["parent_id"] == root["id"]]
        assert node["note"] != "overall_change"
        assert node["image"] == node["merged_image"] != node["raw_image"]

    def test_spill_beyond_region_is_kept(self, client, project, fake_api):
        # the model draws the new object taller than the region: it must not be cut off
        def respond(call):
            im = Image.open(io.BytesIO(noise_png((320, 240)))).convert("RGB")
            from PIL import ImageDraw
            draw = ImageDraw.Draw(im)
            draw.rectangle((105, 85, 155, 125), fill=(250, 250, 250))
            draw.rectangle((120, 30, 140, 85), fill=(250, 250, 0))  # rises out of the region
            buf = io.BytesIO()
            im.save(buf, "PNG")
            return pb.Generation([buf.getvalue()], None, 1)

        fake_api.respond = respond
        root = upload(client, project["id"], noise_png((320, 240)))
        resp = submit(client, project_id=project["id"], parent_id=root["id"],
                      regions=[REGION], model="gpt-image-2.5-flare")
        wait_job(client, project["id"], resp.json()["id"])
        (node,) = [n for n in client.get(f"/api/projects/{project['id']}/tree")
                   .json()["nodes"] if n["parent_id"]]
        assert node["note"] == "spill_grown"
        assert image(client, node["image"]).getpixel((130, 45)) == (250, 250, 0)
        # the model's whole output can be adopted instead
        patched = client.patch(f"/api/nodes/{node['id']}", json={"use_raw": True}).json()
        assert patched["image"] == node["raw_image"]

    def test_redrawn_scene_is_kept_whole_not_pasted_back(self, client, project, fake_api):
        # same aspect, but the model drew another picture: there is nothing to paste back
        fake_api.respond = lambda call: pb.Generation([noise_png((640, 480), seed=5)], None, 1)
        root = upload(client, project["id"], noise_png((320, 240)))
        resp = submit(client, project_id=project["id"], parent_id=root["id"],
                      regions=[REGION], model="jimeng-4.5")
        job = wait_job(client, project["id"], resp.json()["id"])
        assert job["status"] == "done", job["errors"]
        (node,) = [n for n in client.get(f"/api/projects/{project['id']}/tree")
                   .json()["nodes"] if n["parent_id"] == root["id"]]
        assert node["note"] == "reframed"
        assert node["raw_image"] is None and node["merged_image"] is None
        assert image(client, node["image"]).size == (640, 480)   # the model's whole output
        logs = client.get(f"/api/jobs/{job['id']}/logs").json()
        assert any(line["level"] == "warn" and "redrew" in line["msg"] for line in logs)

    def test_mismatched_aspect_not_composited(self, client, project, fake_api):
        fake_api.respond = lambda call: pb.Generation([make_png((100, 100))], None, 1)
        root = upload(client, project["id"], noise_png((320, 240)))
        resp = submit(client, project_id=project["id"], parent_id=root["id"],
                      regions=[REGION], model="gemini-3.1-flash-image")
        wait_job(client, project["id"], resp.json()["id"])
        (node,) = [n for n in client.get(f"/api/projects/{project['id']}/tree")
                   .json()["nodes"] if n["parent_id"]]
        assert node["raw_image"] is None and node["note"] == "aspect_mismatch"

    def test_edit_with_refs_and_no_regions(self, client, project, fake_api):
        root = upload(client, project["id"])
        ref = upload(client, project["id"], make_png())
        resp = submit(client, project_id=project["id"], parent_id=root["id"],
                      refs=[ref["id"]], prompt="use the hat from reference image 1")
        job = wait_job(client, project["id"], resp.json()["id"])
        assert job["composite"] is False
        call = fake_api.calls[0]
        assert len(call["images"]) == 2
        assert call["prompt"].startswith(
            "Image 1 is the image to edit; the other images are, in order, reference image 1.")

    def test_failures_recorded(self, client, project, fake_api):
        def respond(call):
            raise pb.ImageAPIError("HTTP 451: unsafe", 451)
        fake_api.respond = respond
        resp = submit(client, project_id=project["id"], prompt="x", size="auto",
                      model="gpt-image-2.5-flare")
        job = wait_job(client, project["id"], resp.json()["id"])
        assert job["status"] == "failed"
        assert job["errors"] == [{"code": "moderated", "detail": "HTTP 451: unsafe",
                                  "variant": ""}]
        logs = client.get(f"/api/jobs/{job['id']}/logs").json()
        assert logs[-1]["msg"] == "Blocked by content moderation: HTTP 451: unsafe"
        assert client.delete(f"/api/jobs/{job['id']}").status_code == 204

    @pytest.mark.parametrize("message, status", [
        ('HTTP 413: {"detail": {"message": "你提交的消息过长", "code": "input_too_large"}}', 413),
        ("HTTP 500: 你提交的消息过长，请编辑后重新发送。", 500),
        ("HTTP 400: This model's maximum context length is 32000 tokens", 400),
    ])
    def test_an_api_that_finds_the_prompt_too_long_says_so(self, client, project, fake_api,
                                                            message, status):
        def respond(call):
            raise pb.ImageAPIError(message, status)
        fake_api.respond = respond
        resp = submit(client, project_id=project["id"], prompt="x", size="auto",
                      model="gpt-image-2.5-flare")
        job = wait_job(client, project["id"], resp.json()["id"])
        assert job["errors"][0]["code"] == "prompt_too_long"

    @pytest.mark.parametrize("body, status, code", [
        ({"prompt": ""}, 400, "prompt_required"),
        ({"prompt": "x", "regions": [REGION]}, 400, "regions_need_parent"),
        ({"prompt": "x", "size": "1000x1000"}, 400, "size_invalid"),
        ({"prompt": "x", "size": "1536*1024"}, 400, "size_format"),
        ({"prompt": "x", "size": None}, 400, "size_required"),
        ({"prompt": "x", "parent_id": "nope"}, 404, "not_found"),
        ({"prompt": "x" * 30001}, 400, "prompt_too_long"),
    ])
    def test_rejected_before_any_request(self, client, project, fake_api,
                                         body, status, code):
        body = {"project_id": project["id"], "model": "gpt-image-2.5-flare",
                "size": "1024x1024"} | body
        resp = submit(client, **body)
        assert (resp.status_code, resp.json()["code"]) == (status, code), resp.json()
        assert resp.json()["detail"]  # English text for clients that don't know the code
        assert fake_api.calls == []

    def test_refs_must_be_in_same_project(self, client, project, fake_api):
        other = client.post("/api/projects", json={"name": "Other"}).json()
        ref = upload(client, other["id"])
        resp = submit(client, project_id=project["id"], prompt="x",
                      size="1024x1024", refs=[ref["id"]])
        assert resp.json()["code"] == "cross_project" and fake_api.calls == []

    def test_missing_api_key(self, client, project, settings, fake_api):
        settings.env_file.write_text("")
        resp = submit(client, project_id=project["id"], prompt="x", size="1024x1024")
        assert (resp.status_code, resp.json()["code"]) == (400, "api_key_missing")

    def test_validation_limits(self, client, project):
        resp = submit(client, project_id=project["id"], prompt="x", n=9)
        assert (resp.status_code, resp.json()["code"]) == (422, "invalid_request")
        assert "n" in resp.json()["detail"]

    def test_coordinates_must_be_finite_and_in_range(self, client, project, fake_api):
        # NaN went through: billed, then stored, and every later reply listing it broke
        parent = upload(client, project["id"])
        for shape in ('{"type":"rect","x":NaN,"y":10,"w":50,"h":50}',
                      '{"type":"lasso","points":[[0,0],[1e400,5],[9,9]]}',
                      '{"type":"brush","points":[[1000000,5]],"radius":5}',
                      '{"type":"ellipse","x":0,"y":0,"w":1e9,"h":5}'):
            body = (f'{{"project_id":"{project["id"]}","parent_id":"{parent["id"]}",'
                    f'"regions":[{{"shapes":[{shape}],"instruction":"x"}}]}}')
            resp = client.post("/api/jobs", content=body,
                               headers={"content-type": "application/json"})
            assert (resp.status_code, resp.json()["code"]) == (422, "invalid_request"), shape
        assert fake_api.calls == []
        assert client.get(f"/api/projects/{project['id']}/tree").status_code == 200

    def test_a_name_of_spaces_only_is_refused(self, client, project):
        resp = client.patch(f"/api/projects/{project['id']}", json={"name": "   "})
        assert (resp.status_code, resp.json()["code"]) == (422, "invalid_request")


def add_asset(client, data=None, name="red hat.png"):
    resp = client.post("/api/assets", files={"file": (name, data or make_png(), "image/png")})
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestAssets:
    def test_upload_rename_list_and_delete(self, client):
        a = add_asset(client)
        assert a["name"] == "red hat" and (a["width"], a["height"]) == (64, 48)
        # the same image again is the asset already there
        assert add_asset(client, name="copy.png")["id"] == a["id"]
        renamed = client.patch(f"/api/assets/{a['id']}", json={"name": " hat "}).json()
        assert renamed["name"] == "hat"
        assert [x["name"] for x in client.get("/api/assets").json()] == ["hat"]
        assert client.delete(f"/api/assets/{a['id']}").status_code == 204
        assert client.get("/api/assets").json() == []
        assert client.delete(f"/api/assets/{a['id']}").json()["code"] == "not_found"

    def test_a_version_saved_as_an_asset(self, client, project):
        node = upload(client, project["id"])
        a = client.post("/api/assets/from-node", json={"node_id": node["id"], "name": "Fig. 1"})
        assert a.status_code == 201 and a.json()["image"] == node["image"]

    def test_any_project_can_use_an_asset_as_a_reference(self, client, project, fake_api):
        hat = add_asset(client, make_png(color=(10, 200, 30)))
        other = client.post("/api/projects", json={"name": "Other"}).json()
        for p in (project, other):
            root = upload(client, p["id"])
            resp = submit(client, project_id=p["id"], parent_id=root["id"],
                          refs=[f"asset:{hat['id']}"], prompt="add the hat of reference image 1")
            job = wait_job(client, p["id"], resp.json()["id"])
            assert job["status"] == "done", job["errors"]
            assert job["refs"] == [f"asset:{hat['id']}"] and job["ref_images"] == [hat["image"]]
        assert all(len(call["images"]) == 2 for call in fake_api.calls)
        # deleting the asset leaves what was made with it as it was
        client.delete(f"/api/assets/{hat['id']}")
        job = client.get(f"/api/projects/{other['id']}/tree").json()["jobs"][0]
        assert job["ref_images"] == [hat["image"]]
        assert client.get(f"/api/images/{hat['image']}").status_code == 200
        resp = submit(client, project_id=other["id"], prompt="x", size="1024x1024",
                      refs=[f"asset:{hat['id']}"])
        assert resp.json()["code"] == "not_found"

    def test_an_asset_as_a_new_root_version(self, client, project):
        hat = add_asset(client)
        node = client.post(f"/api/projects/{project['id']}/from-asset",
                           json={"asset_id": hat["id"]}).json()
        assert node["image"] == hat["image"] and node["label"] == "red hat"
        assert node["parent_id"] is None

    def test_an_asset_pack_round_trips_and_skips_what_is_there(self, client):
        add_asset(client, make_png(color=(1, 1, 1)), "a.png")
        add_asset(client, make_png(color=(2, 2, 2)), "b.png")
        resp = client.get("/api/assets/export")
        assert resp.headers["content-type"] == "application/zip"
        assert "brushgraft-assets.zip" in resp.headers["content-disposition"]
        pack = resp.content
        result = client.post("/api/assets/import", files={"file": ("p.zip", pack)}).json()
        assert result == {"added": 0, "skipped": 2}
        for a in client.get("/api/assets").json():
            client.delete(f"/api/assets/{a['id']}")
        result = client.post("/api/assets/import", files={"file": ("p.zip", pack)}).json()
        assert result == {"added": 2, "skipped": 0}
        assert sorted(a["name"] for a in client.get("/api/assets").json()) == ["a", "b"]

    def test_a_project_file_is_no_asset_pack(self, client, project):
        upload(client, project["id"])
        data = client.get(f"/api/projects/{project['id']}/export").content
        resp = client.post("/api/assets/import", files={"file": ("p.zip", data)})
        assert resp.json()["code"] == "bad_asset_pack"


def test_event_bus_crosses_threads():
    async def run():
        bus = EventBus()
        bus.bind(asyncio.get_running_loop())
        queue = bus.subscribe()
        await asyncio.to_thread(bus.publish, {"type": "x"})
        event = await asyncio.wait_for(queue.get(), 1)
        bus.unsubscribe(queue)
        bus.publish({"type": "y"})  # no subscribers is fine
        return event

    assert asyncio.run(run()) == {"type": "x"}


def test_event_bus_close_ends_streams():
    async def run():
        bus = EventBus()
        bus.bind(asyncio.get_running_loop())
        before = bus.subscribe()
        bus.close()
        after = bus.subscribe()  # subscribing after close ends at once too
        return [await asyncio.wait_for(q.get(), 1) for q in (before, after)]

    assert asyncio.run(run()) == [None, None]


class TestArchive:
    """Export a project as a zip and bring it back, on the server."""

    def _with_history(self, client, project):
        root = upload(client, project["id"], name="room.png")
        job = submit(client, project_id=project["id"], parent_id=root["id"],
                     model="gpt-image-2.5-flare", prompt="", composite=True,
                     regions=[REGION]).json()
        wait_job(client, project["id"], job["id"])
        client.patch(f"/api/nodes/{root['id']}", json={"starred": True})
        return root

    def _export(self, client, project_id) -> bytes:
        resp = client.get(f"/api/projects/{project_id}/export")
        assert resp.status_code == 200
        return resp.content

    def test_a_project_named_in_any_language_exports(self, client):
        # HTTP headers are Latin-1: a Chinese name goes in filename* (UTF-8), not in filename
        project = client.post("/api/projects", json={"name": "小猫的项目 2026"}).json()
        resp = client.get(f"/api/projects/{project['id']}/export")
        assert resp.status_code == 200
        header = resp.headers["content-disposition"]
        assert header.isascii()
        assert "filename*=UTF-8''brushgraft-" + quote("小猫的项目_2026.zip", safe="") in header
        assert 'filename="brushgraft-______2026.zip"' in header  # an ASCII stand-in

    def test_an_asset_used_as_a_reference_travels_with_the_project(self, client, project,
                                                                   fake_api):
        # the project file holds the asset's image, so its history is whole elsewhere too
        hat = add_asset(client, make_png(color=(30, 30, 200)))
        root = upload(client, project["id"])
        resp = submit(client, project_id=project["id"], parent_id=root["id"],
                      refs=[f"asset:{hat['id']}", root["id"]], prompt="x")
        wait_job(client, project["id"], resp.json()["id"])
        data = self._export(client, project["id"])
        client.delete(f"/api/assets/{hat['id']}")
        new = client.post("/api/projects/import", files={"file": ("p.zip", data)}).json()
        (job,) = client.get(f"/api/projects/{new['id']}/tree").json()["jobs"]
        (node,) = [n for n in client.get(f"/api/projects/{new['id']}/tree").json()["nodes"]
                   if n["parent_id"] is None]
        assert job["refs"] == [f"asset:{hat['id']}", node["id"]]
        assert job["ref_images"] == [hat["image"], root["image"]]
        assert client.get(f"/api/images/{hat['image']}").status_code == 200

    def test_a_file_from_before_reference_images_still_imports(self, client, project, fake_api):
        import json
        import zipfile
        root = upload(client, project["id"])
        resp = submit(client, project_id=project["id"], parent_id=root["id"],
                      refs=[root["id"]], prompt="x")
        wait_job(client, project["id"], resp.json()["id"])
        src = zipfile.ZipFile(io.BytesIO(self._export(client, project["id"])))
        manifest = json.loads(src.read("project.json"))
        manifest["version"] = 1
        for j in manifest["jobs"]:
            del j["ref_images"]
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as z:
            for info in src.infolist():
                z.writestr(info.filename, json.dumps(manifest) if info.filename == "project.json"
                           else src.read(info))
        new = client.post("/api/projects/import", files={"file": ("p.zip", out.getvalue())})
        (job,) = client.get(f"/api/projects/{new.json()['id']}/tree").json()["jobs"]
        assert job["ref_images"] == [root["image"]]

    def test_round_trip_keeps_versions_edits_and_images(self, client, project):
        self._with_history(client, project)
        before = client.get(f"/api/projects/{project['id']}/tree").json()
        resp = client.get(f"/api/projects/{project['id']}/export")
        assert resp.headers["content-type"] == "application/zip"
        assert resp.headers["content-disposition"].startswith('attachment; filename="brushgraft-')

        imported = client.post("/api/projects/import", files={"file": ("p.zip", resp.content)})
        assert imported.status_code == 201
        new = imported.json()
        assert new["name"] == project["name"] and new["id"] != project["id"]
        after = client.get(f"/api/projects/{new['id']}/tree").json()
        assert [n["image"] for n in after["nodes"]] == [n["image"] for n in before["nodes"]]
        assert [n["starred"] for n in after["nodes"]] == [n["starred"] for n in before["nodes"]]
        assert [n["note"] for n in after["nodes"]] == [n["note"] for n in before["nodes"]]
        # fresh ids, links kept
        ids = {n["id"] for n in after["nodes"]}
        assert not ids & {n["id"] for n in before["nodes"]}
        assert all(n["parent_id"] in ids for n in after["nodes"] if n["parent_id"])
        assert after["jobs"][0]["regions"] == before["jobs"][0]["regions"]
        assert after["jobs"][0]["parent_id"] in ids
        assert {n["job_id"] for n in after["nodes"] if n["job_id"]} == {after["jobs"][0]["id"]}
        for node in after["nodes"]:
            assert client.get(f"/api/images/{node['image']}").status_code == 200

    def test_importing_twice_makes_two_projects(self, client, project):
        upload(client, project["id"])
        data = self._export(client, project["id"])
        for _ in range(2):
            r = client.post("/api/projects/import", files={"file": ("p.zip", data)})
            assert r.status_code == 201
        assert len(client.get("/api/projects").json()) == 3

    def test_a_job_that_was_running_arrives_settled(self, client, project, store):
        root = upload(client, project["id"])
        store.create_job(project_id=project["id"], parent_id=root["id"], kind="edit", prompt="p",
                         full_prompt="p", regions=[], refs=[], model="m", size="1024x1024",
                         n=2, composite=False)
        data = self._export(client, project["id"])
        new = client.post("/api/projects/import", files={"file": ("p.zip", data)}).json()
        job = client.get(f"/api/projects/{new['id']}/tree").json()["jobs"][0]
        assert job["status"] == "failed"
        assert job["errors"][-1]["code"] == "interrupted"

    @pytest.mark.parametrize("body", [b"not a zip", b""])
    def test_rejects_files_that_are_not_projects(self, client, body):
        r = client.post("/api/projects/import", files={"file": ("p.zip", body)})
        assert (r.status_code, r.json()["code"]) == (400, "bad_archive")

    def test_rejects_damaged_or_newer_files_and_imports_nothing(self, client, project):
        import json
        import zipfile

        upload(client, project["id"])
        good = self._export(client, project["id"])

        def edit(fn) -> bytes:
            out = io.BytesIO()
            with zipfile.ZipFile(io.BytesIO(good)) as src, zipfile.ZipFile(out, "w") as z:
                fn(src, z)
            return out.getvalue()

        def rewrite(change):
            def run(src, z):
                for i in src.infolist():
                    data = src.read(i)
                    if i.filename == "project.json":
                        m = json.loads(data)
                        change(m)
                        data = json.dumps(m).encode()
                    z.writestr(i.filename, data)
            return run

        def no_manifest(src, z):
            for i in src.infolist():
                if i.filename != "project.json":
                    z.writestr(i.filename, src.read(i))

        def tampered(src, z):
            for i in src.infolist():
                data = src.read(i)
                z.writestr(i.filename, data + b"x" if i.filename.startswith("images/") else data)

        def missing_image(src, z):
            for i in src.infolist():
                if not i.filename.startswith("images/"):
                    z.writestr(i.filename, src.read(i))

        def self_parent(m):
            m["nodes"][0]["parent_id"] = m["nodes"][0]["id"]

        def newer(m):
            m["version"] = 99

        def bad_id(m):
            m["nodes"][0]["id"] = "../x"

        def huge_time(m):
            m["nodes"][0]["created_at"] = 2 ** 64

        def undecodable(src, z):  # PNG's signature, then nothing an image is made of
            data = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
            sha = hashlib.sha256(data).hexdigest()
            for i in src.infolist():
                body = src.read(i)
                if i.filename == "project.json":
                    m = json.loads(body)
                    m["nodes"][0]["image"] = sha
                    body = json.dumps(m).encode()
                z.writestr(i.filename, body)
            z.writestr(f"images/{sha}.png", data)

        def corrupt_deflate(src, z):
            for i in src.infolist():
                z.writestr(i, src.read(i), compress_type=zipfile.ZIP_DEFLATED)

        def nested(src, z):
            for i in src.infolist():
                z.writestr(i.filename, b"[" * 100_000 if i.filename == "project.json"
                           else src.read(i))

        cases = [(no_manifest, "bad_archive"), (tampered, "bad_archive"),
                 (missing_image, "bad_archive"), (rewrite(self_parent), "bad_archive"),
                 (rewrite(bad_id), "bad_archive"), (rewrite(newer), "archive_newer"),
                 (rewrite(huge_time), "bad_archive"), (undecodable, "bad_archive"),
                 (nested, "bad_archive")]
        for fn, code in cases:
            r = client.post("/api/projects/import", files={"file": ("p.zip", edit(fn))})
            assert (r.status_code, r.json()["code"]) == (400, code), fn
        # a member whose compressed data is damaged
        damaged = bytearray(edit(corrupt_deflate))
        at = damaged.find(b"project.json") + len("project.json") + 10
        damaged[at:at + 20] = b"\xff" * 20
        r = client.post("/api/projects/import", files={"file": ("p.zip", bytes(damaged))})
        assert (r.status_code, r.json()["code"]) == (400, "bad_archive")
        assert len(client.get("/api/projects").json()) == 1  # nothing half imported

    def test_unknown_project_is_not_found(self, client):
        assert client.get("/api/projects/nope/export").status_code == 404

    def test_import_needs_the_token(self, app):
        with TestClient(app) as c:
            r = c.post("/api/projects/import", files={"file": ("p.zip", b"x")})
            assert r.status_code == 401


def test_a_paste_back_failure_keeps_the_paid_for_image(client, project, fake_api, monkeypatch):
    from brushgraft import imaging

    def broken(*args, **kwargs):
        raise MemoryError("no room")

    monkeypatch.setattr(imaging, "paste_back", broken)
    root = upload(client, project["id"], noise_png((640, 480), seed=2))
    fake_api.respond = lambda call: pb.Generation([noise_png((640, 480), seed=3)], None, 1)
    job = submit(client, project_id=project["id"], parent_id=root["id"], prompt="",
                 model="gpt-image-2.5-flare", composite=True, regions=[REGION]).json()
    done = wait_job(client, project["id"], job["id"])
    assert done["status"] == "done"
    node = next(n for n in client.get(f"/api/projects/{project['id']}/tree").json()["nodes"]
                if n["job_id"] == job["id"])
    assert node["note"] == "paste_failed" and node["raw_image"] is None
    logs = client.get(f"/api/jobs/{job['id']}/logs").json()
    assert any(line["level"] == "warn" and "Pasting back failed" in line["msg"] for line in logs)
