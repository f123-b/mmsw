const TERM_EXPANSIONS: readonly [string, string][] = [
  ["CAN", "CAN（控制器局域网）"],
  ["DMA", "DMA（直接存储器访问）"],
  ["ADC", "ADC（模数转换器）"],
  ["PWM", "PWM（脉宽调制）"],
  ["RTOS", "RTOS（实时操作系统）"],
  ["volatile", "volatile（易变关键字）"],
  ["static", "static（静态关键字）"],
  ["const", "const（只读限定符）"],
  ["virtual", "virtual（虚函数关键字）"]
];

function protectCode(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const protectedText = text.replace(/```[\s\S]*?```/g, (block) => {
    const index = blocks.push(block) - 1;
    return `\u0000CODE_${index}\u0000`;
  });
  return { text: protectedText, blocks };
}

/** Adds a short Chinese explanation on first use while leaving code untouched. */
export function applyChineseTechnicalLanguagePolicy(text: string): string {
  if (!/[\u4e00-\u9fff]/.test(text)) return text;
  const protectedText = protectCode(text);
  let result = protectedText.text;
  for (const [term, expansion] of TERM_EXPANSIONS) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${term}(?![A-Za-z0-9])`, term === term.toUpperCase() ? "g" : "gi");
    let expanded = false;
    result = result.replace(pattern, (match, offset: number, source: string) => {
      if (expanded || /[（(][^）)]{1,18}[）)]/.test(source.slice(Math.max(0, offset - 2), offset + match.length + 20))) return match;
      expanded = true;
      return expansion;
    });
  }
  return result.replace(/\u0000CODE_(\d+)\u0000/g, (_match, index: string) => protectedText.blocks[Number(index)] ?? "");
}
