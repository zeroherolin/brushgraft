"""brushgraft (the local server) with the image API faked, for the browser tests of server mode.

Runs on a fresh temporary workspace with a fixed token and a placeholder key; no network.
"""
import io
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw

import promptbrush as pb


def fake(prompt, images=(), model="", size="", **kwargs):
    # the prompt can ask for a slow request, or a blocked one, as a test needs
    time.sleep(1.5 if "[slow]" in prompt else 0.3)
    if model == "fail-451" or "[blocked]" in prompt:
        raise pb.ImageAPIError('HTTP 451: {"error":"blocked"}', 451)
    if images:
        out = Image.open(io.BytesIO(images[0])).convert("RGB").point(lambda v: min(255, v + 6))
        if len(images) > 1:  # paint where the annotated copy has its box
            w, h = out.size
            ImageDraw.Draw(out).ellipse((w * 0.4, h * 0.35, w * 0.6, h * 0.65), fill=(190, 40, 60))
    else:
        out = Image.new("RGB", (256, 192), (120, 150, 180))
    buf = io.BytesIO()
    out.save(buf, "PNG")
    return pb.Generation([buf.getvalue()], {"total_tokens": 9}, 0.3)


pb.create_image = fake
home = Path(tempfile.mkdtemp(prefix="brushgraft-e2e-"))
(home / ".token").write_text("e2e-token\n")
(home / ".env").write_text("BRUSHGRAFT_API_KEY=placeholder\n")

from brushgraft import cli  # noqa: E402  (after the patch)

cli.main(["--dir", str(home), "--no-browser", "--port", sys.argv[1] if len(sys.argv) > 1 else "4175"])
