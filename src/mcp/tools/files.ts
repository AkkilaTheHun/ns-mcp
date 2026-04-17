import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const FILE_SUMMARY_FIELDS = `
  alt
  createdAt
  updatedAt
  fileStatus
  ... on MediaImage {
    id
    image { url width height }
  }
  ... on GenericFile {
    id
    url
  }
  ... on Video {
    id
    duration
  }
`;

export function registerFileTools(server: McpServer): void {
  // --- List Files ---
  server.tool(
    "list_files",
    "List files with optional filtering, sorting, and pagination. Filter by media_type:IMAGE, media_type:VIDEO, media_type:GENERIC_FILE, or filename:pattern*.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of files to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'media_type:IMAGE', 'filename:product*')"),
      sortKey: z.enum(["CREATED_AT", "FILENAME", "ID", "ORIGINAL_UPLOAD_SIZE", "RELEVANCE", "UPDATED_AT"]).default("CREATED_AT"),
      reverse: z.boolean().default(true),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ files: unknown }>(`
        query Files($first: Int!, $after: String, $query: String, $sortKey: FileSortKeys!, $reverse: Boolean!) {
          files(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${FILE_SUMMARY_FIELDS} }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              endCursor
              startCursor
            }
          }
        }
      `, { first, after, query, sortKey, reverse });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get File ---
  server.tool(
    "get_file",
    "Get full details of a single file by ID (supports MediaImage, GenericFile, and Video).",
    {
      id: z.string().describe("File GID (e.g. gid://shopify/MediaImage/123 or gid://shopify/GenericFile/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetFile($id: ID!) {
          node(id: $id) {
            id
            ... on MediaImage {
              alt
              fileStatus
              createdAt
              updatedAt
              image { url width height }
            }
            ... on GenericFile {
              alt
              fileStatus
              createdAt
              updatedAt
              url
            }
            ... on Video {
              alt
              fileStatus
              createdAt
              updatedAt
              duration
              sources { url width height format mimeType }
            }
          }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Create File ---
  server.tool(
    "create_file",
    "Create file assets from external URLs. Supports images, PDFs, and other file types. Files are processed asynchronously.",
    {
      files: z.array(z.object({
        alt: z.string().optional().describe("Alt text for the file"),
        contentType: z.enum(["IMAGE", "FILE"]).describe("Content type: IMAGE for images, FILE for PDFs/docs/other"),
        originalSource: z.string().describe("URL of the file to upload"),
        filename: z.string().optional().describe("Desired filename"),
      })).min(1).max(250).describe("List of files to create"),
    },
    async ({ files }) => {
      const res = await shopifyGraphQL<{
        fileCreate: { files: unknown[]; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation FileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              id
              alt
              fileStatus
              createdAt
              ... on MediaImage {
                image { url width height }
              }
              ... on GenericFile {
                url
              }
            }
            userErrors { field message }
          }
        }
      `, { files });

      throwIfUserErrors(res.data?.fileCreate?.userErrors, "fileCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.fileCreate?.files) }] };
    },
  );

  // --- Update File ---
  server.tool(
    "update_file",
    "Update file properties such as alt text. Can update multiple files in a single request.",
    {
      files: z.array(z.object({
        id: z.string().describe("File GID to update"),
        alt: z.string().optional().describe("New alt text"),
        originalSource: z.string().optional().describe("New file URL to replace the content"),
        filename: z.string().optional().describe("New filename (extension must match original)"),
      })).min(1).max(250).describe("List of file updates"),
    },
    async ({ files }) => {
      const res = await shopifyGraphQL<{
        fileUpdate: { files: unknown[]; userErrors: Array<{ field: string[]; message: string; code: string }> };
      }>(`
        mutation FileUpdate($files: [FileUpdateInput!]!) {
          fileUpdate(files: $files) {
            files {
              id
              alt
              fileStatus
              createdAt
            }
            userErrors { field message code }
          }
        }
      `, { files });

      throwIfUserErrors(res.data?.fileUpdate?.userErrors, "fileUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.fileUpdate?.files) }] };
    },
  );

  // --- Delete Files ---
  server.tool(
    "delete_files",
    "Delete one or more files. Permanently removes file assets and their associations. Cannot be undone.",
    {
      fileIds: z.array(z.string()).min(1).describe("List of file GIDs to delete"),
    },
    async ({ fileIds }) => {
      const res = await shopifyGraphQL<{
        fileDelete: { deletedFileIds: string[]; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation FileDelete($fileIds: [ID!]!) {
          fileDelete(fileIds: $fileIds) {
            deletedFileIds
            userErrors { field message }
          }
        }
      `, { fileIds });

      throwIfUserErrors(res.data?.fileDelete?.userErrors, "fileDelete");
      const deleted = res.data?.fileDelete?.deletedFileIds ?? [];
      return { content: [{ type: "text" as const, text: `Deleted ${deleted.length} file(s): ${deleted.join(", ")}` }] };
    },
  );
}
