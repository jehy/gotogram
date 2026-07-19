import type { Telegraf, Types } from "telegraf";
import { gotifyApplicationNames, GotifyMessage } from "./gotify.js";
import {
  extractMarkdownImage,
  formatAppName,
  getDefaultPhotoFilename,
  getErrorDetails,
  getFilenameFromUrl,
  getPriorityEmoji,
  logger,
  retryFetch,
} from "./generic.js";
import { escapers } from "@telegraf/entity";
import { convert as tgMdV2ConverV2Convert } from "telegram-markdown-v2";
import config from "./config.js";

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

const sendAttempts = {
  first: 0,
  fallbackToMdConvertor: 1,
  fallbackToStripAll: 2,
};

async function downloadPhoto(photoUrl: string): Promise<TelegramPhotoInput> {
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

  if (source.length > config.TELEGRAM_MAX_PHOTO_BYTES) {
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
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendPhoto`,
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

export async function sendToTelegram(
  bot: Telegraf,
  gotifyMessage: GotifyMessage,
): Promise<void> {
  const { text: gotifyMessageText, photo } = extractMarkdownImage(
    gotifyMessage.message,
  );
  let sendAttempt = 1; // dont even try to send without fallback
  let sent = false;

  const messageOptions: TelegramMessageOptions = {
    parse_mode: "MarkdownV2",
  };
  if (config.TELEGRAM_TOPIC_ID) {
    messageOptions.message_thread_id = parseInt(config.TELEGRAM_TOPIC_ID, 10);
  }
  const downloadedPhoto = photo ? await downloadPhoto(photo) : undefined;
  while (sent === false && sendAttempt <= sendAttempts.fallbackToStripAll) {
    const messageText = formatGotifyMessage(
      { ...gotifyMessage, message: gotifyMessageText },
      photo,
      sendAttempt,
    );
    try {
      const canSendPhoto =
        downloadedPhoto &&
        downloadedPhoto.source.length <= config.TELEGRAM_MAX_PHOTO_BYTES;
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
          config.TELEGRAM_CHAT_ID,
          downloadedPhoto,
          messageOptions,
          messageText || undefined,
        ); // native telegraf sendPhoto does not work for me, I get `socket hang up`
      } else {
        await bot.telegram.sendMessage(
          config.TELEGRAM_CHAT_ID,
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
        config.TELEGRAM_CHAT_ID,
        "🔴 Failed to send message to Telegram, check gotogram logs",
        { parse_mode: "MarkdownV2" },
      )
      .catch(() => {});
  }
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
