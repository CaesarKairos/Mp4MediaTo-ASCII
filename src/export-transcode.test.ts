import { describe, expect, it } from "vitest";
import { transcodeArguments } from "./export-transcode";

describe("transcodeArguments", () => {
  it("creates a broadly compatible MP4 with optional audio", () => {
    const args = transcodeArguments("mp4");
    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
    expect(args).toContain("0:a?");
    expect(args.at(-1)).toBe("output.mp4");
  });

  it("creates a looping palette-based GIF", () => {
    const args = transcodeArguments("gif");
    expect(args.join(" ")).toContain("palettegen");
    expect(args.join(" ")).toContain("paletteuse");
    expect(args.at(-1)).toBe("output.gif");
  });
});
