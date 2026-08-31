import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("desktop density and content shell contract", () => {
  it("uses explicit compact density tokens without page scaling", () => {
    expect(styles).toContain("--sidebar-width: 224px");
    expect(styles).toContain("--page-title-size: 28px");
    expect(styles).toContain("--control-height: 36px");
    expect(styles).not.toMatch(/(?:^|[;{\s])zoom\s*:/m);
    expect(styles).not.toMatch(/transform\s*:\s*scale\s*\(/);
  });

  it("reserves a real composer dock row for scrollable page content", () => {
    expect(styles).toContain(".content-viewport { display: grid; grid-template-rows: minmax(0, 1fr) auto;");
    expect(styles).toContain(".composer-dock { min-width: 0;");
    expect(styles).toContain(".modern-main { height: auto; min-height: 0; overflow: auto;");
  });
});
