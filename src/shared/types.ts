/**
 * Shared domain types — ported from the Chrome extension's `src/shared/types.ts`.
 *
 * Differences from the Chrome version:
 *  - `apiKey` no longer lives on `Settings`; secrets are kept in VS Code's
 *    SecretStorage (see `config/settings.ts`), never in plain configuration.
 *  - Added the `"vscode-lm"` provider kind, which reuses a chat model already
 *    available in the editor (Copilot / Claude) instead of a raw HTTP call.
 *  - Dropped browser-overlay-only fields (`wandPosition`, `theme`).
 */

export type EnhanceMode = "concise" | "refine" | "detail";

export type PromptType =
  | "coding"
  | "marketing"
  | "research"
  | "education"
  | "professional"
  | "general"
  | "personal";

export type PromptLength = "short" | "moderate" | "long";

export type PromptTone =
  | "formal"
  | "casual"
  | "professional"
  | "friendly"
  | "persuasive"
  | "technical";

export interface GenerateParams {
  description: string;
  promptType: PromptType;
  length: PromptLength;
  tone: PromptTone;
}

/**
 * `vscode-lm` resolves a model already present in the editor (Copilot, Claude in
 * VS Code, …) through the Language Model API — no key required. The other kinds
 * are direct HTTP calls and need a key from SecretStorage.
 */
export type ProviderKind = "vscode-lm" | "anthropic" | "openai" | "gemini" | "proxy";

/** Plain, non-secret configuration mirrored from `contributes.configuration`. */
export interface Settings {
  provider: ProviderKind;
  model: string;
  proxyUrl?: string;
  defaultMode: EnhanceMode;
  defaultType: PromptType;
  streamIntoEditor: boolean;
}

export type ErrorCode =
  | "NO_KEY"
  | "NO_MODEL"
  | "BAD_MODEL"
  | "RATE_LIMIT"
  | "NETWORK"
  | "PARSE_ERROR"
  | "ABORT"
  | "UNKNOWN";

/** A typed error the UI layer can map to friendly messages / actions. */
export class PromptMateError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromptMateError";
  }
}
