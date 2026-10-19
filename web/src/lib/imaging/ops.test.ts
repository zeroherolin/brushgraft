import { describe, expect, it } from "vitest";
import { testCodec } from "../../test/codec";
import { decodePng } from "../../test/png";
import { forApi } from "./ops";
import { newRaster } from "./raster";

describe("forApi", () => {
  it("sends an opaque image within the limits as it is", async () => {
    const data = await testCodec.encodePng(newRaster(64, 48, 3, 120));
    expect(await forApi(testCodec, data)).toBe(data);
  });

  it("sends a transparent image over white, as PNG (imaging.for_api)", async () => {
    const im = newRaster(40, 30, 4);
    for (let i = 0; i < 40 * 30; i++) if (i % 40 >= 20) im.data.set([200, 30, 30, 255], i * 4);
    const out = decodePng(Buffer.from(await forApi(testCodec, await testCodec.encodePng(im))), "RGBA");
    expect([out.width, out.height]).toEqual([40, 30]);
    expect([...out.data.slice(0, 4)]).toEqual([255, 255, 255, 255]); // was clear, stored black
    expect([...out.data.slice(30 * 4, 30 * 4 + 4)]).toEqual([200, 30, 30, 255]);
  });
});
