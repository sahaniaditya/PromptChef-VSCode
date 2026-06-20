/**
 * Builder tests — mirror the Chrome project's vitest setup. These cover the
 * pure prompt-construction logic, which has no VS Code dependency and so runs
 * in plain Node.
 */
import { describe, expect, it } from "vitest";
import {
  buildGenerateSystemPrompt,
  buildSystemPrompt,
  buildUserMessage,
} from "./builder";

describe("buildSystemPrompt", () => {
  it("includes the mode instruction", () => {
    expect(buildSystemPrompt("concise")).toContain("as short and tight as possible");
  });

  it("adds a domain line for non-general types", () => {
    expect(buildSystemPrompt("refine", "coding")).toContain("coding domain");
  });

  it("omits the domain line for the general type", () => {
    expect(buildSystemPrompt("refine", "general")).not.toContain("domain —");
  });
});

describe("buildUserMessage", () => {
  it("wraps the draft and includes selection when present", () => {
    const out = buildUserMessage("do a thing", "some code");
    expect(out).toContain("<draft_prompt>\ndo a thing\n</draft_prompt>");
    expect(out).toContain("<selected_editor_text>");
  });

  it("omits the selection block when empty", () => {
    expect(buildUserMessage("hi", "   ")).not.toContain("selected_editor_text");
  });
});

describe("buildGenerateSystemPrompt", () => {
  it("reflects the requested length and tone", () => {
    const out = buildGenerateSystemPrompt({
      description: "x",
      promptType: "research",
      length: "long",
      tone: "formal",
    });
    expect(out).toContain("Tone: formal");
    expect(out).toContain("220–320 words");
  });
});
