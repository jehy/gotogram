import { Telegraf } from "telegraf";
import type { Types } from "telegraf";
import Pino from "pino";
import WebSocket from "ws";
import fetchRetry from "fetch-retry";
import { escapers } from "@telegraf/entity";
import { convert as tgMdV2ConverV2Convert } from "telegram-markdown-v2";

const GOTIFY_WS_URL = process.env.GOTIFY_WS_URL as string;
const GOTIFY_HTTP_URL = process.env.GOTIFY_HTTP_URL as string | undefined;
const GOTIFY_TOKEN = process.env.GOTIFY_TOKEN as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID as string;
const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID as string | undefined; // optional

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 2000;
const MAX_TIME_WITHOUT_PINGS = 60_000; // ping should happen every 45 seconds
const PHOTO_DOWNLOAD_ATTEMPTS = 3;
const PHOTO_DOWNLOAD_RETRY_DELAY_MS = 1000;

const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const retryFetch = fetchRetry(fetch, {
  retries: PHOTO_DOWNLOAD_ATTEMPTS - 1,
  retryDelay: (attempt) => PHOTO_DOWNLOAD_RETRY_DELAY_MS * 2 ** attempt,
  retryOn: (_attempt, error, response) => Boolean(error) || !response?.ok,
});

const sendAttempts = {
  first: 0,
  fallbackToMdConvertor: 1,
  fallbackToStripAll: 2,
};
const logger = Pino({
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

export type GotifyMessage = {
  id: number;
  type?: string;
  title?: string;
  message: string | undefined;
  priority: number;
  appid: number;
  date: string;
  extras: Record<string, unknown>;
};

type GotifyApplication = {
  id: number;
  name: string;
};

const gotifyApplicationNames = new Map<number, string>();

function validateConfig(): void {
  if (
    !GOTIFY_WS_URL ||
    !GOTIFY_TOKEN ||
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    logger.error("Missing required environment variables.");
    process.exit(1);
  }
  if (!GOTIFY_WS_URL.endsWith("/stream")) {
    logger.warn(
      'Gotify WebSocket URL should end with "/stream", did you make a mistake?',
    );
  }
  if (
    !GOTIFY_WS_URL.startsWith("ws://") &&
    !GOTIFY_WS_URL.startsWith("wss://")
  ) {
    logger.warn(
      'Gotify WebSocket URL should start with "ws://" or "wss://", did you make a mistake?',
    );
  }
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN, {
  telegram: {
    webhookReply: false, // Disabling webhook reply can often stabilize file transfers
  },
  handlerTimeout: 10000, // Increase timeout limits to 10 seconds
});

type TelegramPhotoInput = {
  source: Buffer;
  url: string;
  filename?: string;
  contentType?: string;
  contentLength?: number;
  magicBytes: string;
};

type TelegramApiErrorDetails = {
  ok: false;
  error_code?: number;
  description?: string;
};

type TelegramMessageOptions = Types.ExtraReplyMessage & {
  photo?: string;
};

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

function getFilenameFromUrl(photoUrl: string): string | undefined {
  try {
    const pathname = new URL(photoUrl).pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : undefined;
  } catch {
    return undefined;
  }
}

function getDefaultPhotoFilename(contentType: string | undefined): string {
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

function getGotifyApplicationsUrl(): string | undefined {
  if (!GOTIFY_HTTP_URL) {
    return undefined;
  }

  const url = new URL(
    "application",
    GOTIFY_HTTP_URL.endsWith("/") ? GOTIFY_HTTP_URL : `${GOTIFY_HTTP_URL}/`,
  );
  url.searchParams.set("token", GOTIFY_TOKEN);
  return url.toString();
}

function isGotifyApplication(value: unknown): value is GotifyApplication {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as GotifyApplication).id === "number" &&
    typeof (value as GotifyApplication).name === "string"
  );
}

async function loadGotifyApplications(): Promise<void> {
  const applicationsUrl = getGotifyApplicationsUrl();
  if (!applicationsUrl) {
    logger.info(
      "GOTIFY_HTTP_URL is not set, Gotify application names won't be loaded",
    );
    return;
  }

  logger.info(`Loading Gotify applications from ${applicationsUrl}`);
  const response = await retryFetch(applicationsUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to load Gotify applications: ${response.status} ${response.statusText}`,
    );
  }

  const applications: unknown = await response.json();
  if (!Array.isArray(applications)) {
    throw new Error(
      "Failed to load Gotify applications: response is not an array",
    );
  }

  gotifyApplicationNames.clear();
  for (const application of applications) {
    if (isGotifyApplication(application)) {
      gotifyApplicationNames.set(application.id, application.name);
    } else {
      logger.warn(
        `Skipping invalid Gotify application: ${JSON.stringify(application)}`,
      );
    }
  }
  logger.info(`Loaded ${gotifyApplicationNames.size} Gotify applications`);
}

function getErrorDetails(error: unknown): Record<string, unknown> {
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

async function downloadTelegramPhoto(
  photoUrl: string,
): Promise<TelegramPhotoInput> {
  logger.debug({ photoUrl }, "Downloading photo before sending it to Telegram");

  const response = await retryFetch(photoUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download photo ${photoUrl}: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : undefined;
  const arrayBuffer = await response.arrayBuffer();
  const source = Buffer.from(arrayBuffer);
  const photoDetails = {
    photoUrl,
    contentType,
    contentLength,
    actualSize: source.length,
    filename:
      getFilenameFromUrl(photoUrl) ?? getDefaultPhotoFilename(contentType),
    magicBytes: source.subarray(0, 16).toString("hex"),
  };

  if (!contentType?.startsWith("image/")) {
    logger.warn(
      photoDetails,
      "Downloaded photo response does not look like an image by Content-Type",
    );
  }

  if (source.length > TELEGRAM_MAX_PHOTO_BYTES) {
    logger.warn(
      photoDetails,
      "Downloaded photo is larger than Telegram sendPhoto limit and will likely fail",
    );
  }

  logger.debug(photoDetails, "Downloaded photo");
  return {
    source,
    url: photoUrl,
    filename: photoDetails.filename,
    contentType,
    contentLength,
    magicBytes: photoDetails.magicBytes,
  };
}

async function sendTelegramPhotoWithNativeFetch(
  chatId: string,
  photo: TelegramPhotoInput,
  options: TelegramMessageOptions,
  caption: string | undefined,
): Promise<void> {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set(
    "photo",
    new Blob([new Uint8Array(photo.source)], {
      type: photo.contentType ?? "application/octet-stream",
    }),
    photo.filename ?? getDefaultPhotoFilename(photo.contentType),
  );

  if (caption) {
    form.set("caption", caption);
  }

  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      form.set(key, String(value));
    }
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
    {
      method: "POST",
      body: form,
    },
  );
  const responseBody = (await response.json().catch(() => undefined)) as
    TelegramApiErrorDetails | undefined;

  if (!response.ok || responseBody?.ok === false) {
    const error = new Error(
      `${response.status}: ${response.statusText}${responseBody?.description ? `: ${responseBody.description}` : ""}`,
    );
    Object.assign(error, {
      response: responseBody,
      on: {
        method: "sendPhoto",
        payload: {
          chat_id: chatId,
          photo: photo.filename,
          parse_mode: options.parse_mode,
          message_thread_id: options.message_thread_id,
          caption,
        },
      },
    });
    throw error;
  }
}

async function sendToTelegram(gotifyMessage: GotifyMessage): Promise<void> {
  const { text: gotifyMessageText, photo } = extractMarkdownImage(
    gotifyMessage.message,
  );
  let sendAttempt = 1; // dont even try to send without fallback
  let sent = false;

  const messageOptions: TelegramMessageOptions = {
    parse_mode: "MarkdownV2",
  };
  if (TELEGRAM_TOPIC_ID) {
    messageOptions.message_thread_id = parseInt(TELEGRAM_TOPIC_ID, 10);
  }
  const downloadedPhoto = photo
    ? await downloadTelegramPhoto(photo)
    : undefined;
  while (sent === false && sendAttempt <= sendAttempts.fallbackToStripAll) {
    const messageText = formatGotifyMessage(
      { ...gotifyMessage, message: gotifyMessageText },
      photo,
      sendAttempt,
    );
    try {
      const canSendPhoto =
        downloadedPhoto &&
        downloadedPhoto.source.length <= TELEGRAM_MAX_PHOTO_BYTES;
      if (canSendPhoto && sendAttempt !== sendAttempts.fallbackToStripAll) {
        logger.debug(
          {
            sendAttempt,
            transport: "native-fetch-multipart",
            photoUrl: downloadedPhoto.url,
            filename: downloadedPhoto.filename,
            contentType: downloadedPhoto.contentType,
            contentLength: downloadedPhoto.contentLength,
            actualSize: downloadedPhoto.source.length,
            magicBytes: downloadedPhoto.magicBytes,
            messageOptions,
            captionLength: messageText.length,
          },
          "Sending photo to Telegram",
        );
        await sendTelegramPhotoWithNativeFetch(
          TELEGRAM_CHAT_ID,
          downloadedPhoto,
          messageOptions,
          messageText || undefined,
        );
      } else {
        await bot.telegram.sendMessage(
          TELEGRAM_CHAT_ID,
          messageText,
          messageOptions,
        );
      }
      logger.info("Message sent to Telegram");
      sent = true;
    } catch (error) {
      logger.error(
        {
          error: getErrorDetails(error),
          sendAttempt,
          gotifyMessage,
          messageText,
          messageOptions,
          photoDetails: downloadedPhoto
            ? {
                transport: "native-fetch-multipart",
                photoUrl: downloadedPhoto.url,
                filename: downloadedPhoto.filename,
                contentType: downloadedPhoto.contentType,
                contentLength: downloadedPhoto.contentLength,
                actualSize: downloadedPhoto.source.length,
                magicBytes: downloadedPhoto.magicBytes,
              }
            : undefined,
        },
        "Failed to send message to Telegram",
      );
    }
    sendAttempt++;
  }
  if (!sent) {
    await bot.telegram
      .sendMessage(
        TELEGRAM_CHAT_ID,
        "🔴 Failed to send message to Telegram, check gotogram logs",
        { parse_mode: "MarkdownV2" },
      )
      .catch(() => {});
  }
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

export function formatGotifyMessage(
  data: GotifyMessage,
  photo: string | undefined,
  sendAttempt: number,
): string {
  logger.debug(data);
  const title = escapers.MarkdownV2(data.title || "No title");
  let message = data.message || "";
  const priority = data.priority ?? 0;
  const applicationName = gotifyApplicationNames.get(data.appid);
  if (sendAttempt === sendAttempts.fallbackToMdConvertor) {
    message = tgMdV2ConverV2Convert(message);
  } else if (sendAttempt === sendAttempts.fallbackToStripAll) {
    // we avoid inlining image on third attempt because it may cause fails
    message = `${escapers.MarkdownV2(message)}\n${escapers.MarkdownV2(photo ?? "")}`;
  }

  const formatted = [
    `*`,
    getPriorityEmoji(priority),
    formatAppName(applicationName, title),
    title,
    "*\n",
    sendAttempt > 1 ? `RetryMode: ${sendAttempt}\n` : "",
    message,
  ]
    .filter((el) => el)
    .join(" ");

  return formatted.trim();
}

let ws: WebSocket | null = null;
let reconnectAttempts = 0;

function connectWebSocket() {
  let pingReceivedDate = Date.now();
  let reconnectScheduled = false;
  function heartbeat() {
    logger.debug("saving heartbeat");
    pingReceivedDate = Date.now();
  }
  const wsUrl = `${GOTIFY_WS_URL}?token=${GOTIFY_TOKEN}`;
  logger.info("Connecting to Gotify WebSocket...");
  ws = new WebSocket(wsUrl);

  function checkHeartbeat() {
    const now = Date.now();
    const timeWithoutHeartbeat = now - pingReceivedDate;
    if (timeWithoutHeartbeat > MAX_TIME_WITHOUT_PINGS) {
      logger.warn(
        `No heartbeat received in ${timeWithoutHeartbeat / 1000} seconds. Reconnecting...`,
      );
      clearInterval(heartbitInterval);
      reconnectScheduled = true;
      ws?.close();
      scheduleReconnect();
    }
  }
  const heartbitInterval = setInterval(checkHeartbeat, 10_000);

  ws.on("open", () => {
    logger.info("Connected to Gotify WebSocket");
    reconnectAttempts = 0;
  });

  ws.on("ping", (data) => {
    logger.debug("received a ping");
    heartbeat();
    (ws as WebSocket).pong(data); // Explicitly respond with pong
  });

  ws.on("message", async (data: WebSocket.Data) => {
    heartbeat();
    logger.info("got message");
    try {
      const parsed = JSON.parse(data.toString()) as GotifyMessage;
      // Skip ping messages if needed
      if (parsed.type === "ping") {
        logger.info("that's a ping");
        return;
      }
      await sendToTelegram(parsed);
    } catch (err) {
      logger.error({ error: getErrorDetails(err) }, "Error processing message");
    }
  });

  ws.on("error", (err) => {
    logger.error({ error: getErrorDetails(err) }, "WebSocket error");
  });

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error("Max reconnection attempts reached. Exiting.");
      process.exit(1);
    }
    const delay = BASE_DELAY_MS * 2 ** reconnectAttempts;
    reconnectAttempts++;
    logger.warn(
      `Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
    );
    setTimeout(connectWebSocket, delay);
  }
  ws.on("close", (code, reason) => {
    logger.info(`WebSocket closed: ${code} - ${reason}`);
    if (!reconnectScheduled) {
      scheduleReconnect();
    }
  });
}

// ========================
// Graceful shutdown
// ========================
function registerGracefulShutdown(): void {
  process.once("SIGINT", () => {
    logger.info("Shutting down...");
    if (ws) {
      ws.close();
    }
    process.exit(0);
  });

  process.once("SIGTERM", () => {
    logger.info("Shutting down...");
    if (ws) {
      ws.close();
    }
    process.exit(0);
  });
}

export async function start(): Promise<void> {
  validateConfig();
  registerGracefulShutdown();

  try {
    await loadGotifyApplications();
  } catch (error) {
    logger.error(`Failed to load Gotify applications: ${error}`);
  }

  connectWebSocket();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void start();
}
