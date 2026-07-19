import { describe, expect, it } from "vitest";

import { extractMarkdownImage, getPriorityEmoji } from "./generic.ts";

describe("extractMarkdownImage", () => {
  it("extracts a standalone markdown image and removes it from text", () => {
    expect(
      extractMarkdownImage(
        "Before\n![Camera](https://example.com/camera.jpg)\nAfter",
      ),
    ).toEqual({
      text: "Before\n\nAfter",
      photo: "https://example.com/camera.jpg",
    });
  });

  it("extracts an image wrapped by a markdown link and removes the whole linked image", () => {
    expect(
      extractMarkdownImage(
        "Before [![Camera](https://example.com/camera.jpg)](https://example.com/event) After",
      ),
    ).toEqual({
      text: "Before  After",
      photo: "https://example.com/camera.jpg",
    });
  });

  it("unwraps angle-bracket image URLs", () => {
    expect(
      extractMarkdownImage(
        "![Camera](<https://example.com/camera with spaces.jpg>)",
      ),
    ).toEqual({
      text: "",
      photo: "https://example.com/camera with spaces.jpg",
    });
  });
});

describe("getPriorityEmoji", () => {
  it.each([
    [1, "⚪"],
    [4, "🟡"],
    [6, "🟠"],
    [8, "🔴"],
  ])("returns %s priority emoji", (priority, emoji) => {
    expect(getPriorityEmoji(priority)).toBe(emoji);
  });
});
