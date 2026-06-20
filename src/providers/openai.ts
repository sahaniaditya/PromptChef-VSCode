/**
 * OpenAI provider — ported from the Chrome `providers/openai.ts`.
 * Also serves the "proxy" provider kind: a self-hosted endpoint that speaks the
 * OpenAI chat-completions wire format. Reuses the shared SSE reader.
 */
import type { Provider } from "./provider";
import { abortSignalFor, failForResponse, readSse } from "./http";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODELS_URL = "https://platform.openai.com/docs/models";

export function makeOpenAIProvider(
  apiKey: string,
  model: string,
  endpoint: string = OPENAI_ENDPOINT,
): Provider {
  return {
    async stream(system, user, onDelta, token): Promise<string> {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: true,
          max_tokens: 1024,
        }),
        signal: abortSignalFor(token),
      });

      if (!resp.ok) {
        await failForResponse(resp, { label: "OpenAI", model, modelsUrl: OPENAI_MODELS_URL });
      }

      let full = "";
      await readSse(resp, (event) => {
        const choices = event.choices as
          | Array<{ delta?: { content?: string } }>
          | undefined;
        const delta = choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      });
      return full;
    },
  };
}
