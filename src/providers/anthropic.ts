/**
 * Anthropic provider — ported from the Chrome `providers/anthropic.ts`.
 * Drops the browser-only `anthropic-dangerous-direct-browser-access` header
 * (not needed from the Node extension host) and reuses the shared SSE reader.
 */
import type { Provider } from "./provider";
import { abortSignalFor, failForResponse, readSse } from "./http";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODELS_URL = "https://docs.anthropic.com/en/docs/about-claude/models/overview";

export function makeAnthropicProvider(apiKey: string, model: string): Provider {
  return {
    async stream(system, user, onDelta, token): Promise<string> {
      const resp = await fetch(ANTHROPIC_ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system,
          messages: [{ role: "user", content: user }],
          stream: true,
        }),
        signal: abortSignalFor(token),
      });

      if (!resp.ok) {
        await failForResponse(resp, { label: "Anthropic", model, modelsUrl: ANTHROPIC_MODELS_URL });
      }

      let full = "";
      await readSse(resp, (event) => {
        if (event.type !== "content_block_delta") return;
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          full += delta.text;
          onDelta(delta.text);
        }
      });
      return full;
    },
  };
}
