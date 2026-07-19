import { logger } from "./generic.js";

const GOTIFY_WS_URL = process.env.GOTIFY_WS_URL as string;
const GOTIFY_HTTP_URL = process.env.GOTIFY_HTTP_URL as string | undefined;
const GOTIFY_TOKEN = process.env.GOTIFY_TOKEN as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID as string;
const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID as string | undefined; // optional

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 2000;
const MAX_TIME_WITHOUT_PINGS = 60_000; // ping should happen every 45 seconds

const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export const config = {
  GOTIFY_WS_URL,
  GOTIFY_HTTP_URL,
  GOTIFY_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_TOPIC_ID,
  MAX_RECONNECT_ATTEMPTS,
  BASE_DELAY_MS,
  MAX_TIME_WITHOUT_PINGS,
  TELEGRAM_MAX_PHOTO_BYTES,
};
export function validateConfig(): void {
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

export default config;
