export interface ChatHistoryMessage {
  role: "system" | "user" | "assistant";
  content: string;
  status?: string;
}

export function buildConversationHistory(messages: ChatHistoryMessage[], maxMessages = 20, maxChars = 8_000): string {
  let budget = maxChars;
  return messages
    .filter((message) => message.role !== "system" && message.status !== "streaming" && message.content.trim())
    .slice(-maxMessages)
    .reverse()
    .map((message) => {
      if (budget <= 0) return "";
      const content = message.content.trim().slice(0, Math.min(2_000, budget));
      budget -= content.length;
      return `${message.role === "user" ? "用户" : "助手"}：${content}`;
    })
    .filter(Boolean)
    .reverse()
    .join("\n");
}
