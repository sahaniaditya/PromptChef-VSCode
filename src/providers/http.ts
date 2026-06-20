/**
 * Shared helpers for the direct-HTTP providers (Anthropic / OpenAI / proxy).
 *
 * Ported from the two Chrome provider files, with the SSE-parsing loop factored
 * out (it was duplicated there). Key environment difference: this runs in the
 * Node-based extension host, so `fetch` has no CORS restriction and we drop the
 * `anthropic-dangerous-direct-browser-access` header the browser build needed.
 */
import type { CancellationToken } from "vscode";
import { PromptMateError } from "../shared/types";

/** Identifies the calling provider for error messages (incl. where to find model ids). */
export interface ProviderErrorInfo {
  /** Human label, e.g. "Anthropic". */
  label: string;
  /** The model id the user configured (echoed back so they can spot a typo). */
  model: string;
  /** Docs URL listing valid model ids for this provider. */
  modelsUrl: string;
}

/**
 * Classifies a non-OK HTTP response into a typed `PromptMateError` and throws.
 * A wrong/unknown model id is the common foot-gun (free-text model setting), so
 * 404s — and 400s that mention "model" — are surfaced as a clear `BAD_MODEL`
 * message that names the id and links to the provider's model list.
 */
export async function failForResponse(resp: Response, info: ProviderErrorInfo): Promise<never> {
  const body = await resp.text();
  if (resp.status === 429) {
    throw new PromptMateError("RATE_LIMIT", `${info.label} 429: ${body}`);
  }
  if (resp.status === 404 || (resp.status === 400 && /model/i.test(body))) {
    throw new PromptMateError(
      "BAD_MODEL",
      `Model "${info.model}" wasn't accepted by ${info.label} (HTTP ${resp.status}). ` +
        `Check the model id — valid ids are listed at ${info.modelsUrl}`,
    );
  }
  throw new PromptMateError("NETWORK", `${info.label} ${resp.status}: ${body}`);
}

/** Bridges a VS Code CancellationToken to a DOM AbortSignal for `fetch`. */
export function abortSignalFor(token: CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/**
 * Reads a `text/event-stream` body line by line, handing each parsed `data:`
 * JSON event to `onEvent`. Identical framing logic to the Chrome providers.
 */
export async function readSse(
  resp: Response,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  if (!resp.body) throw new PromptMateError("NETWORK", "Empty response body.");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process complete lines; keep any trailing partial line in the buffer.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        onEvent(JSON.parse(raw));
      } catch {
        // Skip malformed/partial JSON, as the browser version did.
      }
    }
  }
}
