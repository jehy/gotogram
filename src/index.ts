import { Telegraf } from "telegraf";
import WebSocket from "ws";
import { getErrorDetails, logger } from "./generic.ts";
import { config, validateConfig } from "./config.ts";
import { type GotifyMessage, loadGotifyApplications } from "./gotify.ts";
import { sendToTelegram } from "./telegram.ts";

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, {
  telegram: {
    webhookReply: false, // Disabling webhook reply can often stabilize file transfers
  },
  handlerTimeout: 10000, // Increase timeout limits to 10 seconds
});

let ws: WebSocket | null = null;
let reconnectAttempts = 0;

function connectWebSocket() {
  let pingReceivedDate = Date.now();
  let reconnectScheduled = false;
  function heartbeat() {
    logger.debug("saving heartbeat");
    pingReceivedDate = Date.now();
  }
  const wsUrl = `${config.GOTIFY_WS_URL}?token=${config.GOTIFY_TOKEN}`;
  logger.info("Connecting to Gotify WebSocket...");
  ws = new WebSocket(wsUrl);

  function checkHeartbeat() {
    const now = Date.now();
    const timeWithoutHeartbeat = now - pingReceivedDate;
    if (timeWithoutHeartbeat > config.MAX_TIME_WITHOUT_PINGS) {
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
      await sendToTelegram(bot, parsed);
    } catch (err) {
      logger.error({ error: getErrorDetails(err) }, "Error processing message");
    }
  });

  ws.on("error", (err) => {
    logger.error({ error: getErrorDetails(err) }, "WebSocket error");
  });

  function scheduleReconnect() {
    if (reconnectAttempts >= config.MAX_RECONNECT_ATTEMPTS) {
      logger.error("Max reconnection attempts reached. Exiting.");
      process.exit(1);
    }
    const delay = config.BASE_DELAY_MS * 2 ** reconnectAttempts;
    reconnectAttempts++;
    logger.warn(
      `Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${config.MAX_RECONNECT_ATTEMPTS})...`,
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
