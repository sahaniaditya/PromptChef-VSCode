/**
 * Provider factory + request gating — ports the gating logic from the Chrome
 * extension's `orchestrator.ts` (`makeProvider` + the NO_KEY / RATE_LIMIT
 * checks), minus the message-port plumbing, which VS Code doesn't need.
 */
import type { ConfigProvider } from "../config/settings";
import { checkRateLimit } from "../util/rateLimit";
import { PromptMateError } from "../shared/types";
import type { Provider } from "./provider";
import { makeAnthropicProvider } from "./anthropic";
import { makeOpenAIProvider } from "./openai";
import { makeGeminiProvider } from "./gemini";
import { makeLmProvider } from "./lm";

/**
 * Resolves a ready-to-use provider for the current settings, throwing a typed
 * `PromptMateError` if a precondition fails (no key, no proxy URL, rate limit).
 */
export async function resolveProvider(config: ConfigProvider): Promise<Provider> {
  const settings = config.read();

  if (!checkRateLimit()) {
    throw new PromptMateError(
      "RATE_LIMIT",
      "Too many requests. Wait a moment and try again.",
    );
  }

  switch (settings.provider) {
    case "vscode-lm":
      // No key required — billed through the host AI extension.
      return makeLmProvider(settings.model);

    case "anthropic": {
      const key = await requireKey(config);
      return makeAnthropicProvider(key, settings.model);
    }

    case "openai": {
      const key = await requireKey(config);
      return makeOpenAIProvider(key, settings.model);
    }

    case "gemini": {
      const key = await requireKey(config);
      return makeGeminiProvider(key, settings.model);
    }

    case "proxy": {
      if (!settings.proxyUrl?.trim()) {
        throw new PromptMateError(
          "NETWORK",
          "Proxy provider selected but `promptmate.proxyUrl` is empty.",
        );
      }
      // Proxy is assumed to speak the OpenAI wire format; key is optional.
      const key = (await config.getApiKey()) ?? "";
      return makeOpenAIProvider(key, settings.model, settings.proxyUrl);
    }
  }
}

async function requireKey(config: ConfigProvider): Promise<string> {
  const key = (await config.getApiKey())?.trim();
  if (!key) {
    throw new PromptMateError(
      "NO_KEY",
      "No API key set. Run “PromptMate: Set API Key” to add one.",
    );
  }
  return key;
}
