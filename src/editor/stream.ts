/**
 * Streams replacement text into a text editor, growing a tracked range as each
 * delta arrives. This is the editor-side analog of the Chrome content script's
 * streaming loop in `injector.ts`, which rewrote a textarea/contenteditable in
 * place and offered an Undo.
 *
 * VS Code coalesces our edits into the normal undo stack, so a single Ctrl+Z
 * reverts the whole rewrite — replacing the explicit "Undo toast" the browser
 * version had to build by hand.
 */
import * as vscode from "vscode";

export class EditorStreamer {
  /** The range currently occupied by streamed-in text; grows on each delta. */
  private range: vscode.Range;
  private accumulated = "";

  constructor(
    private readonly editor: vscode.TextEditor,
    target: vscode.Range,
    private readonly streamLive: boolean,
  ) {
    this.range = target;
  }

  /** Append a delta. When `streamLive` is false, this only accumulates. */
  async push(delta: string): Promise<void> {
    this.accumulated += delta;
    if (this.streamLive) await this.render();
  }

  /** Force the final text into the editor (used for non-streaming providers). */
  async finalize(text?: string): Promise<void> {
    if (text !== undefined) this.accumulated = text;
    await this.render();
  }

  private async render(): Promise<void> {
    const start = this.range.start;
    const ok = await this.editor.edit(
      (b) => b.replace(this.range, this.accumulated),
      { undoStopBefore: false, undoStopAfter: false },
    );
    if (!ok) return;
    // Recompute the range now occupied by `accumulated`, starting at `start`.
    const lines = this.accumulated.split("\n");
    const endLine = start.line + lines.length - 1;
    const endChar =
      lines.length === 1 ? start.character + lines[0].length : lines[lines.length - 1].length;
    this.range = new vscode.Range(start, new vscode.Position(endLine, endChar));
  }
}
