/**
 * Google Gemini provider — NET-NEW (no Chrome analog).
 *
 * Gemini's wire format differs from both Anthropic and OpenAI, so this is a
 * dedicated module rather than a reuse of the OpenAI provider:
 *   - endpoint encodes the model in the path and streams via `:streamGenerateContent?alt=sse`
 *   - auth is the `x-goog-api-key` header
 *   - the system prompt is a separate `systemInstruction` (not a message role)
 *   - turns live under `contents[]` with `{ role, parts: [{ text }] }`
 *   - streamed chunks arrive as `candidates[].content.parts[].text`
 *
 * It reuses the shared SSE reader and cancellation bridge in `http.ts`.
 */
import type { Provider } from "./provider";
import { abortSignalFor, failForResponse, readSse } from "./http";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS_URL = "https://ai.google.dev/gemini-api/docs/models";
const MAX_OUTPUT_TOKENS = 1024;

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
}

export function makeGeminiProvider(apiKey: string, model: string): Provider {
  return {
    async stream(system, user, onDelta, token): Promise<string> {
      const endpoint = `${GEMINI_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
        signal: abortSignalFor(token),
      });

      if (!resp.ok) {
        await failForResponse(resp, { label: "Gemini", model, modelsUrl: GEMINI_MODELS_URL });
      }

      let full = "";
      await readSse(resp, (event) => {
        const candidates = event.candidates as GeminiCandidate[] | undefined;
        const parts = candidates?.[0]?.content?.parts;
        if (!parts) return;
        for (const part of parts) {
          if (typeof part.text === "string" && part.text) {
            full += part.text;
            onDelta(part.text);
          }
        }
      });
      return full;
    },
  };
}
