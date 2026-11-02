import type { HTTPEvent } from "h3";

// The framework's separate follow-up completion retains the request tail, but
// does not receive the app system prompt. Its digest uses displayMessage, so
// include the guidance there too, using the framework's hidden-context format.
export const ENGLISH_OUTPUT_INSTRUCTION = "Write all generated text in English, including replies, suggested-action labels and prompts, question options and titles, regardless of the language in customer content.";

export function prepareEnglishAgentRequest({ message, displayMessage }: { message: string; displayMessage?: string }) {
  return {
    message: `${message}\n\n<context>${ENGLISH_OUTPUT_INSTRUCTION}</context>`,
    displayMessage: `${displayMessage ?? message}\n\n<context>${ENGLISH_OUTPUT_INSTRUCTION}</context>`,
  };
}
export const ENGLISH_TITLE_INSTRUCTION = "Write the chat title in English. The user's request follows:\n";

// Title generation has no plugin prompt option. Nitro's documented request
// middleware seam supplies app instructions before Core cleans/truncates input.
export async function prepareEnglishChatTitle(event: HTTPEvent) {
  if (event.req.method !== "POST" || new URL(event.req.url).pathname !== "/_agent-native/agent-chat/generate-title") return;
  const body: unknown = await event.req.clone().json().catch(() => undefined);
  if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string" || !body.message) return;
  const headers = new Headers(event.req.headers);
  headers.delete("content-length");
  event.req = new Request(event.req.url, {
    method: "POST",
    headers,
    signal: event.req.signal,
    body: JSON.stringify({ ...body, message: ENGLISH_TITLE_INSTRUCTION + body.message }),
  });
}
