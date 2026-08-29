import { describe, expect, it } from "vitest";
import { matchCoreTechnicalQa, routeCoreTechnicalQa } from "./core-technical-qa";

describe("CoreTechnicalQaRouter", () => {
  it("keeps exact and multi-slot DMA questions on the verified core card", () => {
    expect(routeCoreTechnicalQa("DMA 有什么用？")).toMatchObject({ level: "exact", card: { id: "dma-purpose" } });
    expect(routeCoreTechnicalQa("请说明DMA相比普通中断搬运数据的优势是什么？在ADC采样或UART接收场景下，使用DMA要注意什么？")).toMatchObject({ level: "strong", card: { id: "dma-purpose" } });
    expect(matchCoreTechnicalQa("随便聊聊你的经历")).toBeUndefined();
  });
});
