import type { CancellationToken } from "vscode";

/**
 * Streaming completion contract — ported from the Chrome extension's
 * `src/background/providers/provider.ts`.
 *
 * The only signature change: the browser version took a DOM `AbortSignal`;
 * here we accept a VS Code `CancellationToken`, which every command/chat
 * handler already has. Implementations bridge it to whatever their transport
 * needs (an AbortController for `fetch`, the token itself for `vscode.lm`).
 */
export interface Provider {
  /**
   * Streams a completion for the given system + user messages. Calls `onDelta`
   * with each text chunk as it arrives and resolves with the full text.
   */
  stream(
    system: string,
    user: string,
    onDelta: (text: string) => void,
    token: CancellationToken,
  ): Promise<string>;
}
