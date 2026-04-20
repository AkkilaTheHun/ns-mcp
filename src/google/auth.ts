import { GoogleAuth } from "googleapis-common";
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { readFileSync } from "fs";

let cachedAuth: GoogleAuth | undefined;
let cachedAnalyticsClient: BetaAnalyticsDataClient | undefined;

export function getServiceAccountKey(): Record<string, string> {
  // Support both inline JSON (Render) and file path (TrueNAS/home server)
  const filePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (filePath) {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, string>;
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    return JSON.parse(raw) as Record<string, string>;
  }
  throw new Error("Set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_FILE");
}

export function getGoogleAuth(): GoogleAuth {
  if (!cachedAuth) {
    const credentials = getServiceAccountKey();
    cachedAuth = new GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/analytics.readonly",
        "https://www.googleapis.com/auth/analytics.edit",
        "https://www.googleapis.com/auth/webmasters.readonly",
        "https://www.googleapis.com/auth/indexing",
        "https://www.googleapis.com/auth/tagmanager.edit.containers",
        "https://www.googleapis.com/auth/tagmanager.readonly",
        "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
        "https://www.googleapis.com/auth/tagmanager.publish",
      ],
    });
  }
  return cachedAuth;
}

export function getAnalyticsClient(): BetaAnalyticsDataClient {
  if (!cachedAnalyticsClient) {
    const credentials = getServiceAccountKey();
    cachedAnalyticsClient = new BetaAnalyticsDataClient({ credentials });
  }
  return cachedAnalyticsClient;
}
