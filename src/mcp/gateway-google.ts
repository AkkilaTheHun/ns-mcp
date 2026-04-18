import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAnalyticsClient, getGoogleAuth } from "../google/auth.js";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { google } from "googleapis";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function fail(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ============================================================
// GOOGLE ANALYTICS (GA4 Data API)
// ============================================================

export function registerAnalyticsGateway(server: McpServer): void {
  server.tool(
    "google_analytics",
    `Google Analytics (GA4). Actions:
REPORTS:
- list_properties: List accessible GA4 properties
- run_report: Run a report (params: propertyId, startDate, endDate, metrics[], dimensions?[], limit?)
- get_realtime: Get realtime data (params: propertyId, metrics[], dimensions?[])
ADMIN:
- list_key_events: List conversion/key events (params: propertyId)
- create_key_event: Mark an event as a key event (params: propertyId, eventName, countingMethod?)
- delete_key_event: Remove key event (params: propertyId, keyEventId)
- list_custom_dimensions: List custom dimensions (params: propertyId)
- create_custom_dimension: Create custom dimension (params: propertyId, parameterName, displayName, scope)
- list_custom_metrics: List custom metrics (params: propertyId)
- create_custom_metric: Create custom metric (params: propertyId, parameterName, displayName, measurementUnit)
- list_audiences: List audiences (params: propertyId)
- list_data_streams: List data streams (params: propertyId)

Common metrics: sessions, totalUsers, newUsers, activeUsers, screenPageViews, conversions, eventCount, averageSessionDuration, bounceRate, engagementRate
Common dimensions: date, country, city, deviceCategory, sessionSource, sessionMedium, pagePath, pageTitle, landingPage, browser`,
    {
      action: z.enum(["list_properties", "run_report", "get_realtime", "list_key_events", "create_key_event", "delete_key_event", "list_custom_dimensions", "create_custom_dimension", "list_custom_metrics", "create_custom_metric", "list_audiences", "list_data_streams"]),
      propertyId: z.string().optional().describe("GA4 property ID (e.g. '123456789')"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD, or 'today', '7daysAgo', '30daysAgo')"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD, or 'today', 'yesterday')"),
      metrics: z.array(z.string()).optional().describe("Metrics to fetch"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to group by"),
      limit: z.number().optional().describe("Max rows (default 100)"),
      orderBy: z.string().optional().describe("Metric or dimension name to sort by"),
      descending: z.boolean().optional().describe("Sort descending (default true)"),
      eventName: z.string().optional().describe("Event name for key events"),
      countingMethod: z.string().optional().describe("ONCE_PER_EVENT or ONCE_PER_SESSION"),
      keyEventId: z.string().optional().describe("Key event ID to delete"),
      parameterName: z.string().optional().describe("Parameter name for custom dimension/metric"),
      displayName: z.string().optional().describe("Display name for custom dimension/metric"),
      scope: z.string().optional().describe("Scope: EVENT, USER, or ITEM"),
      measurementUnit: z.string().optional().describe("Unit: STANDARD, CURRENCY, SECONDS, etc."),
    },
    async ({ action, propertyId, startDate, endDate, metrics, dimensions, limit, orderBy, descending, eventName, countingMethod, keyEventId, parameterName, displayName, scope, measurementUnit }) => {
      try {
        if (action === "list_properties") {
          const auth = getGoogleAuth();
          const analyticsAdmin = google.analyticsadmin({ version: "v1beta", auth });

          // List accounts first, then properties for each account
          const accountsRes = await analyticsAdmin.accounts.list({ pageSize: 100 });
          const accounts = accountsRes.data.accounts ?? [];
          if (!accounts.length) return fail("No GA accounts accessible by this service account. Add ns-datafeed@ns-datafeed.iam.gserviceaccount.com as a Viewer in GA4 Admin → Account Access Management.");

          const allProperties: Record<string, unknown>[] = [];
          for (const account of accounts) {
            const res = await analyticsAdmin.properties.list({
              filter: `parent:${account.name}`,
              pageSize: 50,
            });
            for (const p of res.data.properties ?? []) {
              allProperties.push({
                propertyId: p.name?.replace("properties/", ""),
                displayName: p.displayName,
                account: account.displayName,
                timeZone: p.timeZone,
                currencyCode: p.currencyCode,
                industryCategory: p.industryCategory,
              });
            }
          }
          return allProperties.length ? text(allProperties) : fail("Accounts found but no GA4 properties accessible.");
        }

        if (action === "run_report") {
          if (!propertyId) return fail("propertyId required");
          if (!startDate || !endDate) return fail("startDate and endDate required");
          if (!metrics?.length) return fail("At least one metric required");

          const client = getAnalyticsClient();
          const [response] = await client.runReport({
            property: `properties/${propertyId}`,
            dateRanges: [{ startDate, endDate }],
            metrics: metrics.map(name => ({ name })),
            dimensions: dimensions?.map(name => ({ name })),
            limit: limit ?? 100,
            orderBys: orderBy ? [{
              metric: metrics.includes(orderBy) ? { metricName: orderBy } : undefined,
              dimension: !metrics.includes(orderBy) ? { dimensionName: orderBy } : undefined,
              desc: descending ?? true,
            }] : undefined,
          });

          const dimHeaders = response.dimensionHeaders?.map(h => h.name) ?? [];
          const metHeaders = response.metricHeaders?.map(h => h.name) ?? [];
          const rows = (response.rows ?? []).map(row => {
            const obj: Record<string, string> = {};
            row.dimensionValues?.forEach((v, i) => { obj[dimHeaders[i]!] = v.value ?? ""; });
            row.metricValues?.forEach((v, i) => { obj[metHeaders[i]!] = v.value ?? ""; });
            return obj;
          });

          return text({
            rowCount: response.rowCount,
            rows,
            totals: response.totals?.map(row => {
              const obj: Record<string, string> = {};
              row.metricValues?.forEach((v, i) => { obj[metHeaders[i]!] = v.value ?? ""; });
              return obj;
            }),
          });
        }

        if (action === "get_realtime") {
          if (!propertyId) return fail("propertyId required");
          if (!metrics?.length) return fail("At least one metric required");

          const client = getAnalyticsClient();
          const [response] = await client.runRealtimeReport({
            property: `properties/${propertyId}`,
            metrics: metrics.map(name => ({ name })),
            dimensions: dimensions?.map(name => ({ name })),
            limit: limit ?? 100,
          });

          const dimHeaders = response.dimensionHeaders?.map(h => h.name) ?? [];
          const metHeaders = response.metricHeaders?.map(h => h.name) ?? [];
          const rows = (response.rows ?? []).map(row => {
            const obj: Record<string, string> = {};
            row.dimensionValues?.forEach((v, i) => { obj[dimHeaders[i]!] = v.value ?? ""; });
            row.metricValues?.forEach((v, i) => { obj[metHeaders[i]!] = v.value ?? ""; });
            return obj;
          });

          return text({ rowCount: response.rowCount, rows });
        }

        // --- Admin actions ---
        const adminAuth = getGoogleAuth();
        const admin = google.analyticsadmin({ version: "v1beta", auth: adminAuth });
        const prop = `properties/${propertyId}`;

        if (action === "list_key_events") {
          if (!propertyId) return fail("propertyId required");
          const res = await admin.properties.keyEvents.list({ parent: prop });
          return text((res.data.keyEvents ?? []).map(e => ({
            id: e.name?.split("/").pop(),
            eventName: e.eventName,
            countingMethod: e.countingMethod,
            createTime: e.createTime,
            custom: e.custom,
          })));
        }

        if (action === "create_key_event") {
          if (!propertyId || !eventName) return fail("propertyId and eventName required");
          const res = await admin.properties.keyEvents.create({
            parent: prop,
            requestBody: {
              eventName,
              countingMethod: countingMethod ?? "ONCE_PER_EVENT",
            },
          });
          return text(res.data);
        }

        if (action === "delete_key_event") {
          if (!propertyId || !keyEventId) return fail("propertyId and keyEventId required");
          await admin.properties.keyEvents.delete({ name: `${prop}/keyEvents/${keyEventId}` });
          return text(`Key event ${keyEventId} deleted.`);
        }

        if (action === "list_custom_dimensions") {
          if (!propertyId) return fail("propertyId required");
          const res = await admin.properties.customDimensions.list({ parent: prop });
          return text((res.data.customDimensions ?? []).map(d => ({
            parameterName: d.parameterName,
            displayName: d.displayName,
            scope: d.scope,
            description: d.description,
          })));
        }

        if (action === "create_custom_dimension") {
          if (!propertyId || !parameterName || !displayName) return fail("propertyId, parameterName, and displayName required");
          const res = await admin.properties.customDimensions.create({
            parent: prop,
            requestBody: {
              parameterName,
              displayName,
              scope: scope ?? "EVENT",
            },
          });
          return text(res.data);
        }

        if (action === "list_custom_metrics") {
          if (!propertyId) return fail("propertyId required");
          const res = await admin.properties.customMetrics.list({ parent: prop });
          return text((res.data.customMetrics ?? []).map(m => ({
            parameterName: m.parameterName,
            displayName: m.displayName,
            measurementUnit: m.measurementUnit,
            scope: m.scope,
          })));
        }

        if (action === "create_custom_metric") {
          if (!propertyId || !parameterName || !displayName) return fail("propertyId, parameterName, and displayName required");
          const res = await admin.properties.customMetrics.create({
            parent: prop,
            requestBody: {
              parameterName,
              displayName,
              measurementUnit: measurementUnit ?? "STANDARD",
              scope: "EVENT",
            },
          });
          return text(res.data);
        }

        if (action === "list_audiences") {
          if (!propertyId) return fail("propertyId required");
          // Audiences are in v1alpha, not v1beta
          const adminAlpha = google.analyticsadmin({ version: "v1alpha", auth: adminAuth });
          const res = await (adminAlpha.properties as any).audiences.list({ parent: prop });
          return text((res.data.audiences ?? []).map((a: any) => ({
            name: a.name,
            displayName: a.displayName,
            description: a.description,
            membershipDurationDays: a.membershipDurationDays,
          })));
        }

        if (action === "list_data_streams") {
          if (!propertyId) return fail("propertyId required");
          const res = await admin.properties.dataStreams.list({ parent: prop });
          return text((res.data.dataStreams ?? []).map(s => ({
            id: s.name?.split("/").pop(),
            displayName: s.displayName,
            type: s.type,
            webStreamData: s.webStreamData,
          })));
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Google Analytics error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ============================================================
// GOOGLE SEARCH CONSOLE
// ============================================================

export function registerSearchConsoleGateway(server: McpServer): void {
  server.tool(
    "google_search_console",
    `Google Search Console. Actions:
- list_sites: List verified sites/properties
- query: Search performance data (params: siteUrl, startDate, endDate, dimensions?[], type?, rowLimit?)
- inspect_url: Inspect a URL's index status (params: siteUrl, inspectionUrl)
- list_sitemaps: List sitemaps (params: siteUrl)

dimensions: query, page, country, device, date, searchAppearance
type: web, image, video, news, discover, googleNews`,
    {
      action: z.enum(["list_sites", "query", "inspect_url", "list_sitemaps"]),
      siteUrl: z.string().optional().describe("Site URL (e.g. 'https://nailstuff.ca' or 'sc-domain:nailstuff.ca')"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to group by"),
      type: z.string().optional().describe("Search type filter"),
      rowLimit: z.number().optional().describe("Max rows (default 100, max 25000)"),
      inspectionUrl: z.string().optional().describe("Full URL to inspect"),
      dimensionFilterGroups: z.array(z.object({
        dimension: z.string(),
        operator: z.string().optional(),
        expression: z.string(),
      })).optional().describe("Filters (e.g. [{dimension:'page',operator:'contains',expression:'/products/'}])"),
    },
    async ({ action, siteUrl, startDate, endDate, dimensions, type, rowLimit, inspectionUrl, dimensionFilterGroups }) => {
      try {
        const auth = getGoogleAuth();
        const searchconsole = google.searchconsole({ version: "v1", auth });

        if (action === "list_sites") {
          const res = await searchconsole.sites.list();
          const sites = (res.data.siteEntry ?? []).map(s => ({
            siteUrl: s.siteUrl,
            permissionLevel: s.permissionLevel,
          }));
          return sites.length ? text(sites) : fail("No sites accessible by this service account. Add ns-datafeed@ns-datafeed.iam.gserviceaccount.com as a user in Search Console.");
        }

        if (action === "query") {
          if (!siteUrl) return fail("siteUrl required");
          if (!startDate || !endDate) return fail("startDate and endDate required");

          const res = await searchconsole.searchanalytics.query({
            siteUrl,
            requestBody: {
              startDate,
              endDate,
              dimensions: dimensions ?? ["query"],
              type: type ?? "web",
              rowLimit: rowLimit ?? 100,
              dimensionFilterGroups: dimensionFilterGroups?.length ? [{
                filters: dimensionFilterGroups.map(f => ({
                  dimension: f.dimension,
                  operator: f.operator ?? "contains",
                  expression: f.expression,
                })),
              }] : undefined,
            },
          });

          const rows = (res.data.rows ?? []).map(row => ({
            keys: row.keys,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr ? (row.ctr * 100).toFixed(2) + "%" : undefined,
            position: row.position?.toFixed(1),
          }));

          return text({
            rowCount: rows.length,
            rows,
            responseAggregationType: res.data.responseAggregationType,
          });
        }

        if (action === "inspect_url") {
          if (!siteUrl || !inspectionUrl) return fail("siteUrl and inspectionUrl required");

          const res = await searchconsole.urlInspection.index.inspect({
            requestBody: {
              inspectionUrl,
              siteUrl,
            },
          });

          const result = res.data.inspectionResult;
          return text({
            indexStatus: result?.indexStatusResult,
            mobileUsability: result?.mobileUsabilityResult,
            richResults: result?.richResultsResult,
          });
        }

        if (action === "list_sitemaps") {
          if (!siteUrl) return fail("siteUrl required");
          const res = await searchconsole.sitemaps.list({ siteUrl });
          const sitemaps = (res.data.sitemap ?? []).map(s => ({
            path: s.path,
            lastSubmitted: s.lastSubmitted,
            lastDownloaded: s.lastDownloaded,
            isPending: s.isPending,
            warnings: s.warnings,
            errors: s.errors,
            contents: s.contents,
          }));
          return text(sitemaps);
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Search Console error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ============================================================
// GOOGLE INDEXING API
// ============================================================

export function registerIndexingGateway(server: McpServer): void {
  server.tool(
    "google_indexing",
    `Google Indexing API — request Google to crawl/index URLs immediately. Actions:
- notify_updated: Tell Google a URL was updated or created (params: url)
- notify_removed: Tell Google a URL was removed (params: url)
- get_status: Check notification status for a URL (params: url)
- batch_update: Notify multiple URLs as updated (params: urls[])`,
    {
      action: z.enum(["notify_updated", "notify_removed", "get_status", "batch_update"]),
      url: z.string().optional().describe("Full URL to notify about"),
      urls: z.array(z.string()).optional().describe("Array of URLs for batch operations"),
    },
    async ({ action, url, urls }) => {
      try {
        const auth = getGoogleAuth();
        const indexing = google.indexing({ version: "v3", auth });

        if (action === "notify_updated") {
          if (!url) return fail("url required");
          const res = await indexing.urlNotifications.publish({
            requestBody: { url, type: "URL_UPDATED" },
          });
          return text(res.data);
        }

        if (action === "notify_removed") {
          if (!url) return fail("url required");
          const res = await indexing.urlNotifications.publish({
            requestBody: { url, type: "URL_DELETED" },
          });
          return text(res.data);
        }

        if (action === "get_status") {
          if (!url) return fail("url required");
          const res = await indexing.urlNotifications.getMetadata({ url });
          return text(res.data);
        }

        if (action === "batch_update") {
          if (!urls?.length) return fail("urls[] required");
          const results = await Promise.allSettled(
            urls.map(u => indexing.urlNotifications.publish({
              requestBody: { url: u, type: "URL_UPDATED" },
            })),
          );
          return text(results.map((r, i) => ({
            url: urls[i],
            status: r.status,
            data: r.status === "fulfilled" ? r.value.data : undefined,
            error: r.status === "rejected" ? String(r.reason) : undefined,
          })));
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Indexing API error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ============================================================
// GOOGLE TAG MANAGER
// ============================================================

export function registerTagManagerGateway(server: McpServer): void {
  server.tool(
    "google_tag_manager",
    `Google Tag Manager. Actions:
DISCOVERY:
- list_accounts: List GTM accounts
- list_containers: List containers (params: accountId)
- list_workspaces: List workspaces (params: accountId, containerId)
TAGS:
- list_tags: List tags in a workspace (params: accountId, containerId, workspaceId)
- get_tag: Get tag details (params: accountId, containerId, workspaceId, tagId)
- create_tag: Create a tag (params: accountId, containerId, workspaceId, name, type, parameter?[])
- update_tag: Update a tag (params: accountId, containerId, workspaceId, tagId, name?, parameter?[])
- delete_tag: Delete a tag (params: accountId, containerId, workspaceId, tagId)
TRIGGERS:
- list_triggers: List triggers (params: accountId, containerId, workspaceId)
- create_trigger: Create trigger (params: accountId, containerId, workspaceId, name, type, customEventFilter?[])
- delete_trigger: Delete trigger (params: accountId, containerId, workspaceId, triggerId)
VARIABLES:
- list_variables: List variables (params: accountId, containerId, workspaceId)
- create_variable: Create variable (params: accountId, containerId, workspaceId, name, type, parameter?[])
- delete_variable: Delete variable (params: accountId, containerId, workspaceId, variableId)
PUBLISH:
- create_version: Create a version from workspace (params: accountId, containerId, workspaceId, versionName?)
- publish_version: Publish a version (params: accountId, containerId, versionId)`,
    {
      action: z.enum(["list_accounts", "list_containers", "list_workspaces", "list_tags", "get_tag", "create_tag", "update_tag", "delete_tag", "list_triggers", "create_trigger", "delete_trigger", "list_variables", "create_variable", "delete_variable", "create_version", "publish_version"]),
      accountId: z.string().optional().describe("GTM account ID"),
      containerId: z.string().optional().describe("GTM container ID"),
      workspaceId: z.string().optional().describe("GTM workspace ID"),
      tagId: z.string().optional().describe("Tag ID"),
      triggerId: z.string().optional().describe("Trigger ID"),
      variableId: z.string().optional().describe("Variable ID"),
      versionId: z.string().optional().describe("Version ID"),
      name: z.string().optional().describe("Name for tag/trigger/variable"),
      type: z.string().optional().describe("Type (e.g. 'gaawc' for GA4 config, 'gaawe' for GA4 event, 'html' for custom HTML)"),
      parameter: z.array(z.object({
        type: z.string().describe("Parameter type: template, boolean, integer, list, map"),
        key: z.string(),
        value: z.string().optional(),
        list: z.array(z.unknown()).optional(),
        map: z.array(z.unknown()).optional(),
      })).optional().describe("Tag/variable parameters"),
      firingTriggerId: z.array(z.string()).optional().describe("Trigger IDs that fire this tag"),
      customEventFilter: z.array(z.object({
        type: z.string(),
        parameter: z.array(z.object({ type: z.string(), key: z.string(), value: z.string() })),
      })).optional().describe("Custom event filter for triggers"),
      versionName: z.string().optional().describe("Name for the version"),
    },
    async ({ action, accountId, containerId, workspaceId, tagId, triggerId, variableId, versionId, name, type, parameter, firingTriggerId, customEventFilter, versionName }) => {
      try {
        const auth = getGoogleAuth();
        const gtm = google.tagmanager({ version: "v2", auth });

        if (action === "list_accounts") {
          const res = await gtm.accounts.list();
          return text((res.data.account ?? []).map(a => ({
            accountId: a.accountId,
            name: a.name,
            shareData: a.shareData,
          })));
        }

        if (action === "list_containers") {
          if (!accountId) return fail("accountId required");
          const res = await gtm.accounts.containers.list({ parent: `accounts/${accountId}` });
          return text((res.data.container ?? []).map(c => ({
            containerId: c.containerId,
            name: c.name,
            publicId: c.publicId,
            domainName: c.domainName,
            usageContext: c.usageContext,
          })));
        }

        if (action === "list_workspaces") {
          if (!accountId || !containerId) return fail("accountId and containerId required");
          const parent = `accounts/${accountId}/containers/${containerId}`;
          const res = await gtm.accounts.containers.workspaces.list({ parent });
          return text((res.data.workspace ?? []).map(w => ({
            workspaceId: w.workspaceId,
            name: w.name,
            description: w.description,
          })));
        }

        // All remaining actions need the workspace path
        const wsPath = accountId && containerId && workspaceId
          ? `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`
          : undefined;

        // --- Tags ---
        if (action === "list_tags") {
          if (!wsPath) return fail("accountId, containerId, and workspaceId required");
          const res = await gtm.accounts.containers.workspaces.tags.list({ parent: wsPath });
          return text((res.data.tag ?? []).map(t => ({
            tagId: t.tagId,
            name: t.name,
            type: t.type,
            firingTriggerId: t.firingTriggerId,
            paused: t.paused,
          })));
        }

        if (action === "get_tag") {
          if (!wsPath || !tagId) return fail("accountId, containerId, workspaceId, and tagId required");
          const res = await gtm.accounts.containers.workspaces.tags.get({ path: `${wsPath}/tags/${tagId}` });
          return text(res.data);
        }

        if (action === "create_tag") {
          if (!wsPath || !name || !type) return fail("accountId, containerId, workspaceId, name, and type required");
          const res = await gtm.accounts.containers.workspaces.tags.create({
            parent: wsPath,
            requestBody: {
              name,
              type,
              parameter: parameter as any,
              firingTriggerId,
            },
          });
          return text(res.data);
        }

        if (action === "update_tag") {
          if (!wsPath || !tagId) return fail("accountId, containerId, workspaceId, and tagId required");
          const res = await gtm.accounts.containers.workspaces.tags.update({
            path: `${wsPath}/tags/${tagId}`,
            requestBody: {
              ...(name && { name }),
              ...(parameter && { parameter: parameter as any }),
              ...(firingTriggerId && { firingTriggerId }),
            },
          });
          return text(res.data);
        }

        if (action === "delete_tag") {
          if (!wsPath || !tagId) return fail("accountId, containerId, workspaceId, and tagId required");
          await gtm.accounts.containers.workspaces.tags.delete({ path: `${wsPath}/tags/${tagId}` });
          return text(`Tag ${tagId} deleted.`);
        }

        // --- Triggers ---
        if (action === "list_triggers") {
          if (!wsPath) return fail("accountId, containerId, and workspaceId required");
          const res = await gtm.accounts.containers.workspaces.triggers.list({ parent: wsPath });
          return text((res.data.trigger ?? []).map(t => ({
            triggerId: t.triggerId,
            name: t.name,
            type: t.type,
          })));
        }

        if (action === "create_trigger") {
          if (!wsPath || !name || !type) return fail("accountId, containerId, workspaceId, name, and type required");
          const res = await gtm.accounts.containers.workspaces.triggers.create({
            parent: wsPath,
            requestBody: {
              name,
              type,
              customEventFilter: customEventFilter as any,
            },
          });
          return text(res.data);
        }

        if (action === "delete_trigger") {
          if (!wsPath || !triggerId) return fail("accountId, containerId, workspaceId, and triggerId required");
          await gtm.accounts.containers.workspaces.triggers.delete({ path: `${wsPath}/triggers/${triggerId}` });
          return text(`Trigger ${triggerId} deleted.`);
        }

        // --- Variables ---
        if (action === "list_variables") {
          if (!wsPath) return fail("accountId, containerId, and workspaceId required");
          const res = await gtm.accounts.containers.workspaces.variables.list({ parent: wsPath });
          return text((res.data.variable ?? []).map(v => ({
            variableId: v.variableId,
            name: v.name,
            type: v.type,
          })));
        }

        if (action === "create_variable") {
          if (!wsPath || !name || !type) return fail("accountId, containerId, workspaceId, name, and type required");
          const res = await gtm.accounts.containers.workspaces.variables.create({
            parent: wsPath,
            requestBody: {
              name,
              type,
              parameter: parameter as any,
            },
          });
          return text(res.data);
        }

        if (action === "delete_variable") {
          if (!wsPath || !variableId) return fail("accountId, containerId, workspaceId, and variableId required");
          await gtm.accounts.containers.workspaces.variables.delete({ path: `${wsPath}/variables/${variableId}` });
          return text(`Variable ${variableId} deleted.`);
        }

        // --- Versioning & Publishing ---
        if (action === "create_version") {
          if (!wsPath) return fail("accountId, containerId, and workspaceId required");
          const res = await (gtm.accounts.containers.workspaces as any).create_version({
            path: wsPath,
            requestBody: {
              name: versionName ?? "Version created via MCP",
            },
          });
          return text({
            versionId: res.data.containerVersion?.containerVersionId,
            name: res.data.containerVersion?.name,
            compilerError: res.data.compilerError,
          });
        }

        if (action === "publish_version") {
          if (!accountId || !containerId || !versionId) return fail("accountId, containerId, and versionId required");
          const res = await gtm.accounts.containers.versions.publish({
            path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
          });
          return text({
            versionId: res.data.containerVersion?.containerVersionId,
            name: res.data.containerVersion?.name,
          });
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Tag Manager error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
