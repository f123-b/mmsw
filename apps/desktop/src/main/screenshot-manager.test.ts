import { describe, expect, it } from "vitest";
import { selectPrimaryScreenSource } from "./screenshot-manager";

describe("selectPrimaryScreenSource", () => {
  const sources = [
    { id: "screen-2", display_id: "2" },
    { id: "screen-1", display_id: "1" },
    { id: "screen-3", display_id: "3" }
  ];

  it("matches the primary display regardless of source order", () => {
    expect(selectPrimaryScreenSource(sources, 1)?.id).toBe("screen-1");
  });

  it("falls back to the first source when no primary source matches", () => {
    expect(selectPrimaryScreenSource(sources, 9)?.id).toBe("screen-2");
  });
});
