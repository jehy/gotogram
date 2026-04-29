import { Telegraf } from "telegraf";
import type { Types } from "telegraf";
import Pino from "pino";
import WebSocket from "ws";

const GOTIFY_WS_URL = process.env.GOTIFY_WS_URL as string;
const GOTIFY_TOKEN = process.env.GOTIFY_TOKEN as string;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID as string;
const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID as string | undefined; // optional

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 2000;
const MAX_TIME_WITHOUT_PINGS = 60_000; // ping should happen every 45 seconds

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
if (!GOTIFY_WS_URL.startsWith("ws://") && !GOTIFY_WS_URL.startsWith("wss://")) {
  logger.warn(
    'Gotify WebSocket URL should start with "ws://" or "wss://", did you make a mistake?',
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
  if (priority >= 6) return "🟠";
  if (priority >= 4) return "🟡";
  return "⚪";
}

function formatGotifyMessage(data: GotifyMessage): string {
  logger.debug(data);
  const title = data.title || "No title";
  const message = data.message || "";
  const priority = data.priority ?? 0;

  const formatted = `*${getPriorityEmoji(priority)} ${title}*\n${message}`;
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
    if (!reconnectScheduled) {
      scheduleReconnect();
    }
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
  process.exit(0);
});

process.once("SIGTERM", () => {
  logger.info("Shutting down...");
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

// Start
connectWebSocket();
