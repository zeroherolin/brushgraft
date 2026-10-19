"""Turn region instructions and the overall request into the prompt sent.

Images are always sent in this order: the original, the annotated copy (when
there are regions), reference image 1, reference image 2, ... The prompt
explains each image by position, so instructions can say "reference image 1":
image by image ("image 3 is reference image 1; image 4 is reference image 2"),
as a model given only "images 3 onward are reference images 1 to 8" was seen
to take image 9 for reference image 8.

The wrapper text follows the UI language: models handle either, and the
user's instructions read more naturally inside text in the same language.

Each outlined area is named by its number and its color. Models read the colors far
more reliably than the small numbers: given only "1" and "2" they were seen to swap
two instructions every time, and given "1 (red)" never.
"""

from collections.abc import Sequence
from typing import Literal

from brushgraft.errors import UserError

Lang = Literal["en", "zh"]
CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
MAX_REGIONS = len(CIRCLED)
# shapes in one region (the strokes and marquees added to or taken from it)
MAX_SHAPES = 200
# How long what the user writes may be, in characters (Unicode code points, which is what
# Python's len counts and the web UI counts too). The image APIs set the real limit on the whole
# prompt sent: measured, gpt-image-2 takes about 17,000 Chinese or 39,000 English characters,
# Gemini more than 60,000. These are well past anything written by hand, and an API that turns a
# prompt down as too long says so (see prompt_too_long below).
MAX_PROMPT = 30000
MAX_INSTRUCTION = 30000
# The whole prompt sent may be no longer than this (the instructions, the request and the text
# around them)
MAX_FULL_PROMPT = 40000
# Names of imaging.REGION_COLORS, in the same order
COLOR_NAMES = {
    "en": ("red", "blue", "green", "orange", "purple", "pink", "teal", "yellow"),
    "zh": ("红色", "蓝色", "绿色", "橙色", "紫色", "粉色", "青色", "黄色"),
}

_TEXT = {
    "en": {
        "ref": "image {n} is reference image {k}",
        "sep": "; ",
        "gen_refs": "Of the attached images, {refs}.",
        "edit_refs": "Image 1 is the image to edit; {refs}.",
        "intro": ("Image 1 is the image to edit. Image 2 is the same image with colored, "
                  "numbered outlines drawn around the areas to change; the outlines only "
                  "mark where to make changes."),
        "region_refs": "Of the other images, {refs}.",
        "lead": "Make the following changes to image 1:",
        "region": "Area {k} ({color}): {text}",
        "region_default": "follow the overall request",
        "overall": "Overall: {text}",
        "outro": ("Change only the outlined areas, not other parts of the image that look "
                  "the same, and keep everything else exactly as it is. The output must not "
                  "contain any outlines, numbers or other annotations."),
        "outro_overall": ("Apart from the overall request, change only the outlined areas, "
                          "not other parts of the image that look the same, and keep "
                          "everything else exactly as it is. The output must not contain any "
                          "outlines, numbers or other annotations."),
    },
    "zh": {
        "ref": "第 {n} 张图是参考图 {k}",
        "sep": "；",
        "gen_refs": "{refs}。",
        "edit_refs": "第 1 张图是要修改的原图；{refs}。",
        "intro": ("第 1 张图是要修改的原图；第 2 张图是在原图上用彩色线条圈出、"
                  "并标了编号的修改位置，线条仅用于指示位置。"),
        "region_refs": "{refs}。",
        "lead": "请在第 1 张图的基础上完成以下修改：",
        "region": "{circled} 号圈（{color}）内：{text}",
        "region_default": "按整体要求修改",
        "overall": "整体要求：{text}",
        "outro": ("只修改圈出的区域，图中其他位置相同或相似的内容不要跟着改，其余内容保持不变；"
                  "输出的图片中不要出现任何线条、编号或标注。"),
        "outro_overall": ("除整体要求外，只修改圈出的区域，图中其他位置相同或相似的内容不要跟着改，"
                          "其余内容保持不变；输出的图片中不要出现任何线条、编号或标注。"),
    },
}


def overall_applies_to_whole(prompt: str, regions: Sequence[dict]) -> bool:
    """Whether the overall request is about the whole image: when some region has an
    instruction of its own. When none has, it is what the regions are to become (the editor
    asks for an instruction for every region, or an overall request)."""
    return bool(prompt.strip()) and any(r.get("instruction", "").strip() for r in regions)


def compile_prompt(prompt: str, regions: Sequence[dict], *, has_parent: bool,
                   ref_count: int = 0, lang: Lang = "en",
                   numbers: Sequence[int] | None = None) -> str:
    """Return the prompt to send; raise UserError if there is nothing to send. ``numbers``
    gives each region's place among all of an edit's (from 0), when only some are sent (a
    close-up): it keeps its number and color, as in imaging.annotate. An overall request
    with no region instructions is given as every region's instruction (see
    overall_applies_to_whole)."""
    prompt = prompt.strip()
    instructions = [r.get("instruction", "").strip() for r in regions]
    if regions and not has_parent:
        raise UserError("regions_need_parent",
                        "Regions can only be used when editing an existing image")
    if len(regions) > MAX_REGIONS:
        raise UserError("too_many_regions",
                        f"At most {MAX_REGIONS} regions are allowed", max=MAX_REGIONS)
    if not prompt and not regions:
        raise UserError("prompt_required", "Write a prompt")
    if not prompt and not all(instructions):
        raise UserError("instruction_required",
                        "Write an instruction for every region, or an overall request")
    if len(prompt) > MAX_PROMPT:
        raise UserError("prompt_too_long", f"The prompt can have at most {MAX_PROMPT} characters",
                        max=MAX_PROMPT, length=len(prompt))
    for k, instruction in enumerate(instructions):
        if len(instruction) > MAX_INSTRUCTION:
            raise UserError("instruction_too_long",
                            f"Region {k + 1}'s instruction can have at most {MAX_INSTRUCTION} "
                            "characters", k=k + 1, max=MAX_INSTRUCTION, length=len(instruction))

    text = _TEXT[lang]

    def refs(first: int) -> str:
        """Which image each reference is, the first being image ``first``."""
        return text["sep"].join(text["ref"].format(n=first + k, k=k + 1)
                                for k in range(ref_count))

    if not has_parent:
        return f"{text['gen_refs'].format(refs=refs(1))}\n{prompt}" if ref_count else prompt
    if not regions:
        return f"{text['edit_refs'].format(refs=refs(2))}\n{prompt}" if ref_count else prompt

    lines = [text["intro"]]
    if ref_count:
        lines.append(text["region_refs"].format(refs=refs(3)))
    lines.append(text["lead"])
    colors = COLOR_NAMES[lang]
    if not any(instructions):  # the overall request is what the regions are to become
        instructions, prompt = [prompt] * len(instructions), ""
    for i, instruction in enumerate(instructions):
        k = numbers[i] if numbers is not None else i
        lines.append(text["region"].format(
            k=k + 1, circled=CIRCLED[k], color=colors[k % len(colors)],
            text=instruction or text["region_default"]))
    # An overall request may change things outside the boxes (a new sky): the closing line
    # must not forbid what it asks for
    if prompt:
        lines.append(text["overall"].format(text=prompt))
    lines.append(text["outro_overall"] if prompt else text["outro"])
    return _checked("\n".join(lines))


def _checked(full: str) -> str:
    """The prompt to send, if it isn't too long for the API altogether."""
    if len(full) > MAX_FULL_PROMPT:
        raise UserError("full_prompt_too_long",
                        f"The instructions and the request together can have at most about "
                        f"{MAX_FULL_PROMPT} characters", max=MAX_FULL_PROMPT, length=len(full))
    return full
