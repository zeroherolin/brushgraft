import pytest

from brushgraft.errors import UserError
from brushgraft import imaging
from brushgraft.prompts import (COLOR_NAMES, MAX_FULL_PROMPT, MAX_INSTRUCTION, MAX_PROMPT,
                                MAX_REGIONS, compile_prompt)

RECT = {"type": "rect", "x": 0, "y": 0, "w": 1, "h": 1}


def region(text=""):
    return {"shapes": [RECT], "instruction": text}


def test_plain_generation_and_edit_pass_prompt_through():
    for lang in ("en", "zh"):
        assert compile_prompt(" a cat ", [], has_parent=False, lang=lang) == "a cat"
        assert compile_prompt("make it night", [], has_parent=True, lang=lang) == \
            "make it night"


def test_refs_are_named_in_order():
    gen = compile_prompt("a lighthouse in this style", [], has_parent=False, ref_count=2)
    assert gen.startswith(
        "The attached images are, in order, reference image 1, reference image 2.")
    edit = compile_prompt("use the hat from reference image 1", [], has_parent=True,
                          ref_count=1)
    assert edit.startswith(
        "Image 1 is the image to edit; the other images are, in order, reference image 1.")


def test_regions_numbered_with_overall_request():
    text = compile_prompt("warmer tones", [region("a red teapot"), region()],
                          has_parent=True, ref_count=1)
    lines = text.splitlines()
    assert "Image 2 is the same image with colored, numbered outlines" in lines[0]
    assert lines[1] == "Images 3 onward are, in order, reference image 1."
    assert "Area 1 (red): a red teapot" in lines
    assert "Area 2 (blue): follow the overall request" in lines
    assert "Overall: warmer tones" in lines
    # the closing line leaves room for what the overall request asks
    assert lines[-1].startswith("Apart from the overall request, change only the outlined areas")
    assert "must not contain any outlines, numbers or other annotations" in lines[-1]


def test_chinese_wrapper():
    text = compile_prompt("整体偏暖色", [region("换成红色茶壶"), region()],
                          has_parent=True, ref_count=1, lang="zh")
    lines = text.splitlines()
    assert "第 2 张图是在原图上用彩色线条圈出、并标了编号的修改位置" in lines[0]
    assert lines[1] == "第 3 张图起依次是参考图 1。"
    assert "① 号圈（红色）内：换成红色茶壶" in lines
    assert "② 号圈（蓝色）内：按整体要求修改" in lines
    assert "整体要求：整体偏暖色" in lines
    assert lines[-1].startswith("除整体要求外，只修改圈出的区域")


def test_without_an_overall_request_only_the_boxes_may_change():
    for lang, start in (("en", "Change only the outlined areas"), ("zh", "只修改圈出的区域")):
        text = compile_prompt("", [region("a hat")], has_parent=True, lang=lang)
        assert text.splitlines()[-1].startswith(start)


def test_every_box_color_has_a_name_and_colors_repeat_with_the_boxes():
    for lang in ("en", "zh"):
        assert len(COLOR_NAMES[lang]) == len(imaging.REGION_COLORS)
    text = compile_prompt("", [region(f"r{k}") for k in range(10)], has_parent=True)
    assert "Area 9 (red): r8" in text and "Area 10 (blue): r9" in text


def test_a_close_up_names_its_regions_by_their_own_numbers():
    text = compile_prompt("keep the light", [region("a cup"), region("")], has_parent=True,
                          numbers=[1, 4], lang="zh")
    assert "② 号圈（蓝色）内：a cup" in text and "⑤ 号圈（紫色）内：按整体要求修改" in text
    assert "整体要求：keep the light" in text


def test_regions_without_overall_request_need_every_instruction():
    compile_prompt("", [region("remove it")], has_parent=True)
    with pytest.raises(UserError) as exc:
        compile_prompt("", [region("remove it"), region()], has_parent=True)
    assert exc.value.code == "instruction_required"


@pytest.mark.parametrize("kwargs, code", [
    ({"prompt": "", "regions": [], "has_parent": False}, "prompt_required"),
    ({"prompt": "x", "regions": [region("a")], "has_parent": False},
     "regions_need_parent"),
    ({"prompt": "x", "regions": [region("a")] * (MAX_REGIONS + 1),
      "has_parent": True}, "too_many_regions"),
])
def test_invalid(kwargs, code):
    with pytest.raises(UserError) as exc:
        compile_prompt(**kwargs)
    assert exc.value.code == code


def test_length_limits_count_characters_and_say_how_long():
    # what was written is trimmed first; Chinese characters count one each, as everywhere
    assert compile_prompt("  " + "猫" * MAX_PROMPT + "\n", [], has_parent=False)
    with pytest.raises(UserError) as exc:
        compile_prompt("猫" * (MAX_PROMPT + 1), [], has_parent=False)
    assert (exc.value.code, exc.value.params) == (
        "prompt_too_long", {"max": MAX_PROMPT, "length": MAX_PROMPT + 1})
    with pytest.raises(UserError) as exc:
        compile_prompt("", [region("a"), region("b" * (MAX_INSTRUCTION + 1))], has_parent=True)
    assert exc.value.code == "instruction_too_long" and exc.value.params["k"] == 2
    # each part within its limit, but too much together for the API
    regions = [region("x" * (MAX_FULL_PROMPT // 2))] * 2
    with pytest.raises(UserError) as exc:
        compile_prompt("", regions, has_parent=True)
    assert exc.value.code == "full_prompt_too_long"
    assert exc.value.params["length"] > MAX_FULL_PROMPT
