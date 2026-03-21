import { Telegraf } from "telegraf";
import type { Types } from "telegraf";
import Pino from "pino";

const logger = Pino({
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

import WebSocket from "ws";

type GotifyMessage = {
  id: number;
  type: string;
  title?: string;
  message: string;
  priority: number;
  appid: number;
  date: string;
  extras: Record<string, unknown>;
};

const GOTIFY_WS_URL = process.env.GOTIFY_WS_URL as string;
const GOTIFY_TOKEN = process.env.GOTIFY_TOKEN as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID as string;
const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID as string | undefined; // optional
const DEBUG = !!process.env.DEBUG;

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

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function sendToTelegram(text: string): Promise<void> {
  try {
    const messageOptions: Types.ExtraReplyMessage = {
      parse_mode: "Markdown",
    };
    if (TELEGRAM_TOPIC_ID) {
      messageOptions.message_thread_id = parseInt(TELEGRAM_TOPIC_ID, 10);
    }
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, text, messageOptions);
    logger.info("Message sent to Telegram");
  } catch (error) {
    logger.error(`Failed to send message to Telegram: ${error}`);
  }
}

function getPriorityEmoji(priority: number): string {
  if (priority >= 8) return "🔴";
  if (priority >= 5) return "🟠";
  if (priority >= 2) return "🟡";
  return "⚪";
}

function formatGotifyMessage(data: GotifyMessage): string {
  if (DEBUG) {
    logger.info(data);
  }
  const title = data.title || "No title";
  const message = data.message || "";
  const priority = data.priority ?? 0;

  const formatted = `*${getPriorityEmoji(priority)} ${title}*\n${message}`;
  return formatted.trim();
}

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 2000;

function connectWebSocket() {
  const wsUrl = `${GOTIFY_WS_URL}?token=${GOTIFY_TOKEN}`;
  logger.info("Connecting to Gotify WebSocket...");
  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    logger.info("Connected to Gotify WebSocket");
    reconnectAttempts = 0;
  });

  ws.on("message", async (data: WebSocket.Data) => {
    logger.info("got message");
    try {
      const parsed = JSON.parse(data.toString());
      // Skip ping messages if needed
      if (parsed.type === "ping") {
        logger.info("that's a ping");
        return;
      }
      const text = formatGotifyMessage(parsed);
      await sendToTelegram(text);
    } catch (err) {
      logger.error(`Error processing message: ${err}`);
    }
  });

  ws.on("error", (err) => {
    logger.error(`WebSocket error: ${err}`);
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
    scheduleReconnect();
  });
}

// ========================
// Graceful shutdown
// ========================
process.once("SIGINT", () => {
  logger.info("Shutting down...");
  if (ws) {
    ws.close();
  }
  try {
    bot.stop("SIGINT");
  } catch (err) {
    logger.warn(`Error stopping bot: ${err}`);
  }
  process.exit(0);
});

process.once("SIGTERM", () => {
  logger.info("Shutting down...");
  if (ws) {
    ws.close();
  }
  try {
    bot.stop("SIGTERM");
  } catch (err) {
    logger.warn(`Error stopping bot: ${err}`);
  }
  process.exit(0);
});

// Start
connectWebSocket();
bot.launch();
