import { describe, expect, it } from "vitest";
import { DEFAULT_OVERLAY_PREFERENCES } from "../../shared/overlay-preferences";
import { overlayWindowStyle } from "./OverlayRoot";

describe("overlay window preference variables", () => {
  it("maps independent window typography and appearance to CSS variables", () => {
    const style = overlayWindowStyle({
      ...DEFAULT_OVERLAY_PREFERENCES.interview.answerWindow,
      fontSize: 19,
      titleFontSize: 23,
      fontWeight: 400,
      lineHeight: 1.8,
      paragraphGap: 14,
      itemGap: 11,
      padding: 17,
      textOpacity: 0.72,
      textColor: "#123456"
    }, DEFAULT_OVERLAY_PREFERENCES.appearance);
    expect(style["--overlay-font-size"]).toBe("19px");
    expect(style["--overlay-title-font-size"]).toBe("23px");
    expect(style["--overlay-font-weight"]).toBe("400");
    expect(style["--overlay-line-height"]).toBe("1.8");
    expect(style["--overlay-paragraph-gap"]).toBe("14px");
    expect(style["--overlay-text-color"]).toBe("#123456");
  });
});
