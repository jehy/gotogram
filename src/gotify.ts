import config from "./config.ts";
import { logger, retryFetch } from "./generic.ts";

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

export const gotifyApplicationNames = new Map<number, string>();

function getGotifyApplicationsUrl(): string | undefined {
  if (!config.GOTIFY_HTTP_URL) {
    return undefined;
  }

  const url = new URL(
    "application",
    config.GOTIFY_HTTP_URL.endsWith("/")
      ? config.GOTIFY_HTTP_URL
      : `${config.GOTIFY_HTTP_URL}/`,
  );
  url.searchParams.set("token", config.GOTIFY_TOKEN);
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

export async function loadGotifyApplications(): Promise<void> {
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
