import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("compact interview setup layout contract", () => {
  it("pins header and footer while making only the body scroll", () => {
    expect(styles).toContain(".interview-setup-modal { display: grid; grid-template-rows: auto minmax(0, 1fr) auto;");
    expect(styles).toContain("max-height: calc(100vh - 32px)");
    expect(styles).toContain(".setup-modal-body { min-height: 0; overflow-y: auto;");
    expect(styles).toContain(".setup-modal-footer { display: flex;");
  });

  it("has a compact-height rule for 620px-class windows and remains fluid for 780/1080px", () => {
    expect(styles).toContain("@media (max-height: 700px)");
    expect(styles).toContain("max-height: calc(100vh - 18px)");
    expect(styles).toContain("width: min(620px, calc(100vw - 32px))");
  });
});
