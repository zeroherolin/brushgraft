"""Write web/src/generated/spec.json: the values the browser build shares with Python.

The browser build re-implements the request client, the prompt wrapper and the
paste-back in TypeScript. What they have in common (model list, size rules,
retry policy, prompt texts, paste-back constants) is defined once, in Python,
and exported here so the two can't drift apart.

    python scripts/export_spec.py          # rewrite the file
    python scripts/export_spec.py --check  # fail if the file is out of date (CI)
"""

import json
import sys
from pathlib import Path

import promptbrush as pb

from brushgraft import __version__, archive, imaging, prompts
from brushgraft.app import SIZE_PRESETS
from brushgraft.store import (NOTE_ASPECT_MISMATCH, NOTE_OVERALL, NOTE_PART_FAILED,
                              NOTE_PASTE_FAILED, NOTE_REFRAMED, NOTE_SPILL_GROWN,
                              NOTE_SPILL_TOO_LARGE, NOTE_TOO_LARGE)

OUT = Path(__file__).resolve().parent.parent / "web" / "src" / "generated" / "spec.json"

IMAGING = (
    "ASPECT_TOLERANCE", "ANNOT_GAP", "ECHO_MIN_SHARE", "SPILL_SCALE", "SPILL_MIN_DELTA",
    "SPILL_DRIFT_FACTOR", "SPILL_NEAR", "BRIDGE_RADII", "SPILL_MIN_PATCH", "SPILL_PATCH_SHARE",
    "SPILL_MAX_GROWTH", "SPILL_MAX_SHARE", "SPILL_ESCALATE", "SPILL_NOTE_GROWTH", "ALIGN_MARGIN",
    "ALIGN_MIN_CORR", "ALIGN_COARSE_CORR", "ALIGN_MIN_DETAIL", "BACKDROP_SHARE",
    "BACKDROP_TOLERANCE", "BACKDROP_MIN_PIXELS", "KEY_NOISE", "KEY_MIN_SPAN", "CLOSE_UP_NEAR",
    "TONE_MAX_GAIN", "TONE_MAX_OFFSET", "TONE_MIN_SPAN", "TONE_FADE", "TONE_TIE",
    "TONE_KEEP", "API_MAX_BYTES", "MAX_IMAGE_PIXELS", "REF_MAX_PIXELS",
    "REGISTER_COARSE", "REGISTER_REACH", "REGISTER_TILE", "REGISTER_MAX_TILES",
    "REGISTER_MIN_SHIFT", "REGISTER_MAX_SPREAD", "REGISTER_NEAR", "REPEAT_MIN_STEP", "REPEAT_DIP",
    "PIECE_BLUR", "PIECE_WEAK", "PIECE_CORE", "PIECE_ZONE", "PIECE_FLAT", "PIECE_SPACE",
    "PIECE_LINE", "MAX_COORD",
    "ZOOM_CONTEXT", "ZOOM_MIN_PIXELS", "ZOOM_MAX_SHARE", "ZOOM_OUTPUT_PIXELS", "ZOOM_MAX_PARTS",
)


def build() -> dict:
    return {
        "version": __version__,
        "promptbrush_version": pb.__version__,
        "models": [{"name": name, **vars(info)} for name, info in pb.MODELS.items()],
        "default_model": pb.DEFAULT_MODEL,
        "lenient_model": pb.LENIENT_MODERATION_MODEL,
        "size_presets": SIZE_PRESETS,
        "default_size": pb.DEFAULT_SIZE,
        "default_base_url": pb.DEFAULT_BASE_URL,
        "region_colors": list(imaging.REGION_COLORS),
        "max_regions": prompts.MAX_REGIONS,
        "max_shapes": prompts.MAX_SHAPES,
        "max_prompt": prompts.MAX_PROMPT,
        "max_instruction": prompts.MAX_INSTRUCTION,
        "max_full_prompt": prompts.MAX_FULL_PROMPT,
        "sizes": {
            # JavaScript has no \Z: its $ (without the m flag) is the very end already
            "pattern": pb.SIZE_PATTERN.pattern.replace(r"\Z", "$"),
            "multiple": pb.SIZE_MULTIPLE,
            "max_edge": pb.MAX_EDGE,
            "min_pixels": pb.MIN_PIXELS,
            "max_pixels": pb.MAX_PIXELS,
            "max_aspect": pb.MAX_ASPECT,
            "strict_prefix": pb.STRICT_SIZE_PREFIX,
        },
        "http": {
            "max_retries": pb.MAX_RETRIES,
            "retry_backoff": pb.RETRY_BACKOFF,
            "max_retry_after": pb.MAX_RETRY_AFTER,
            "retry_status": sorted(pb.RETRY_STATUS),
            "safe_retry_status": sorted(pb.SAFE_RETRY_STATUS),
            "uncertain_retries": pb.UNCERTAIN_RETRIES,
            "quota_codes": sorted(pb.QUOTA_CODES),
            "max_download_bytes": pb.MAX_DOWNLOAD_BYTES,
            "connect_timeout": pb.CONNECT_TIMEOUT,
            "timeout_generate": pb.TIMEOUT_GENERATE[1],
            "timeout_edit": pb.TIMEOUT_EDIT[1],
            "timeout_download": pb.TIMEOUT_DOWNLOAD[1],
            "max_parallel": pb.MAX_PARALLEL,
            "moderation_codes": sorted(pb.MODERATION_CODES),
            "no_image": pb.NO_IMAGE,
        },
        "prompt": {"circled": prompts.CIRCLED, "text": prompts._TEXT,
                   "colors": {lang: list(names) for lang, names in prompts.COLOR_NAMES.items()}},
        "notes": {
            "spill_grown": NOTE_SPILL_GROWN,
            "spill_too_large": NOTE_SPILL_TOO_LARGE,
            "aspect_mismatch": NOTE_ASPECT_MISMATCH,
            "reframed": NOTE_REFRAMED,
            "paste_failed": NOTE_PASTE_FAILED,
            "overall_change": NOTE_OVERALL,
            "part_failed": NOTE_PART_FAILED,
            "too_large": NOTE_TOO_LARGE,
        },
        "archive": {
            "format": archive.FORMAT,
            "version": archive.VERSION,
            "max_nodes": archive.MAX_NODES,
            "max_file_bytes": archive.MAX_FILE_BYTES,
            "max_total_bytes": archive.MAX_TOTAL_BYTES,
            "assets_format": archive.ASSETS_FORMAT,
            "assets_version": archive.ASSETS_VERSION,
            "max_assets": archive.MAX_ASSETS,
        },
        "imaging": {name.lower(): getattr(imaging, name) for name in IMAGING},
    }


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=2) + "\n"


def main(argv: list[str]) -> int:
    text = render()
    if "--check" in argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print(f"{OUT.relative_to(OUT.parents[3])} is out of date: "
                  "run python scripts/export_spec.py", file=sys.stderr)
            return 1
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
