import { GoogleAuth } from "googleapis-common";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

let cachedAuth: GoogleAuth | undefined;
let cachedAnalyticsClient: BetaAnalyticsDataClient | undefined;

function getServiceAccountKey(): Record<string, string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var not set");
  return JSON.parse(raw) as Record<string, string>;
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
