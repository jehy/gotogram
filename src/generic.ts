import fetchRetry from "fetch-retry";
import Pino from "pino";

const PHOTO_DOWNLOAD_ATTEMPTS = 3;
const PHOTO_DOWNLOAD_RETRY_DELAY_MS = 1000;

export const retryFetch = fetchRetry(fetch, {
  retries: PHOTO_DOWNLOAD_ATTEMPTS - 1,
  retryDelay: (attempt) => PHOTO_DOWNLOAD_RETRY_DELAY_MS * 2 ** attempt,
  retryOn: (_attempt, error, response) => Boolean(error) || !response?.ok,
});

type ParsedMarkdownMessage = {
  text: string;
  photo: string | undefined;
};

export function extractMarkdownImage(
  text: string | undefined,
): ParsedMarkdownMessage {
  let photo = undefined as string | undefined;
  const imagePattern =
    /(?:\[\s*)?!\[[^\]]*]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)(?:\s*]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))?/g;
  let firstImageFound = false;
  const messageText = (text || "")
    .replace(imagePattern, (match: string, rawPhoto: string) => {
      if (!firstImageFound) {
        firstImageFound = true;
        photo =
          rawPhoto.startsWith("<") && rawPhoto.endsWith(">")
            ? rawPhoto.slice(1, -1)
            : rawPhoto;
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: messageText,
    photo,
  };
}

export function getFilenameFromUrl(photoUrl: string): string | undefined {
  try {
    const pathname = new URL(photoUrl).pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : undefined;
  } catch {
    return undefined;
  }
}

export function getDefaultPhotoFilename(
  contentType: string | undefined,
): string {
  const mimeType = contentType?.split(";", 1)[0].trim().toLowerCase();
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      return "gotify-photo.jpg";
    case "image/png":
      return "gotify-photo.png";
    case "image/gif":
      return "gotify-photo.gif";
    case "image/webp":
      return "gotify-photo.webp";
    default:
      return "gotify-photo.jpg";
  }
}

export const logger = Pino({
  level: process.env.DEBUG ? "debug" : "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true, // Colorize the output
      translateTime: "SYS:standard", // Translate the timestamp to a human-readable format
      ignore: "pid,hostname", // Hide the pid and hostname fields
      // messageFormat: '{method} {url} {msg} - {res.statusCode}', // Customize the message format
    },
  },
});

export function getErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }

  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  for (const key of Object.getOwnPropertyNames(error)) {
    details[key] = (error as unknown as Record<string, unknown>)[key];
  }

  if ("cause" in error) {
    details.cause = getErrorDetails(error.cause);
  }

  return details;
}

export function getPriorityEmoji(priority: number): string {
  if (priority >= 8) return "🔴";
  if (priority >= 6) return "🟠";
  if (priority >= 4) return "🟡";
  return "⚪";
}

export function formatAppName(appName: string | undefined, title: string) {
  if (appName === title) {
    return "";
  }
  return appName ? `[${appName}] ` : "";
}
