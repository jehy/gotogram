import { describe, expect, it } from "vitest";

import {
  extractMarkdownImage,
  formatGotifyMessage,
  getPriorityEmoji,
  type GotifyMessage,
} from "./index.js";

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

describe("formatGotifyMessage", () => {
  it("formats the provided camera movement message", () => {
    const message: GotifyMessage = {
      id: 8554,
      appid: 1,
      message: "Movement detected. Camera: Entry",
      title: "notify from camera",
      priority: 1,
      extras: {
        "client::display": {
          contentType: "text/markdown",
        },
      },
      date: "2026-07-19T01:08:13.121018132+03:00",
    };

    expect(formatGotifyMessage(message, undefined, 0)).toBe(
      "* ⚪ notify from camera *\n Movement detected. Camera: Entry",
    );
  });

  it("formats the provided update message", () => {
    const message: GotifyMessage = {
      id: 8552,
      appid: 6,
      message:
        "Container gotogram running with tag 1.0.9 can be updated to tag 1.0.14",
      title: "New tag found for container gotogram",
      priority: 0,
      date: "2026-07-19T01:08:07.44256099+03:00",
      extras: {},
    };

    expect(formatGotifyMessage(message, undefined, 0)).toBe(
      "* ⚪ New tag found for container gotogram *\n Container gotogram running with tag 1.0.9 can be updated to tag 1.0.14",
    );
    expect(formatGotifyMessage(message, undefined, 1)).toBe(
      "* ⚪ New tag found for container gotogram *\n Container gotogram running with tag 1\\.0\\.9 can be updated to tag 1\\.0\\.14",
    );
    expect(formatGotifyMessage(message, undefined, 2)).toBe(
      "* ⚪ New tag found for container gotogram *\n RetryMode: 2\n Container gotogram running with tag 1\\.0\\.9 can be updated to tag 1\\.0\\.14",
    );
  });
  it("escapes the title for MarkdownV2", () => {
    const message: GotifyMessage = {
      id: 1,
      appid: 1,
      message: "Body",
      title: "Camera [Entry]",
      priority: 1,
      extras: {},
      date: "2026-07-19T01:08:13.121018132+03:00",
    };

    expect(formatGotifyMessage(message, undefined, 0)).toBe(
      "* ⚪ Camera \\[Entry\\] *\n Body",
    );
  });
});
