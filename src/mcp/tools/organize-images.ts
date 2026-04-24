/**
 * organize_images — Create staging folders and organize images by shade.
 *
 * Creates a reviewable folder structure where images are grouped by shade/product.
 * The user can review in Drive/Dropbox and drag misidentified images between
 * shade folders before product creation.
 *
 * Staging folders are always created in the user's own space:
 * - Drive: under "NailStuff Staging" in root
 * - Dropbox: under "/NailStuff Staging/"
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findOrCreateDriveFolder,
  copyDriveFile,
  moveDriveFile,
  listFolderImages,
  listSubfolders,
} from "../../google/drive.js";
import {
  createDropboxFolder,
  copyDropboxFile,
  moveDropboxFile,
  listOwnFolderImages,
  listOwnSubfolders,
} from "../../dropbox/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDropbox(source: string): boolean {
  return source.includes("dropbox.com/") || source.startsWith("/");
}

/** Sanitize a filename for staging: replace problematic chars, append swatcher. */
function stagingFilename(originalName: string, swatcherHandle?: string): string {
  const ext = originalName.split(".").pop() ?? "jpg";
  const base = originalName.replace(/\.[^.]+$/, "");

  // Replace commas, spaces, and other problematic chars
  const sanitized = base
    .replace(/[,]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  if (swatcherHandle) {
    return `${sanitized}_swatcher-${swatcherHandle}.${ext}`;
  }
  return `${sanitized}.${ext}`;
}

// ---------------------------------------------------------------------------
// MCP Tool Registration
// ---------------------------------------------------------------------------

export function registerOrganizeImagesTool(server: McpServer): void {
  server.tool(
    "organize_images",
    `Create staging folders and organize images by shade for human review.

Actions:
- create_staging: Create "{Collection} - Staging" folder with shade subfolders.
  Location: user's own Drive (under "NailStuff Staging") or Dropbox (under "/NailStuff Staging/").
- copy_to_shade: Copy a file from the source folder into a shade subfolder, renaming with swatcher info.
- move_between_shades: Move a file from one shade folder to another (for corrections after review).
- list_staging: List the current state of a staging folder (shade counts + filenames).

Workflow:
1. After analyze_images, call create_staging with the collection name and shade list
2. Call copy_to_shade for each image, grouping by best-guess shade
3. Tell the user to review the folders and drag any misidentified images
4. After review, call list_staging to get the corrected groupings
5. Use the corrected groupings for create_product`,
    {
      action: z.enum(["create_staging", "copy_to_shade", "move_between_shades", "list_staging"]),

      // create_staging
      source: z.string().optional().describe("Drive folder ID or Dropbox /home/ URL of the source collection"),
      collectionName: z.string().optional().describe("Collection name (e.g., 'Take It Easy')"),
      shadeNames: z.array(z.string()).optional().describe("Shade/product names to create subfolders for"),

      // copy_to_shade
      stagingFolder: z.string().optional().describe("Staging folder ID (Drive) or path (Dropbox) from create_staging"),
      shade: z.string().optional().describe("Target shade name"),
      fileId: z.string().optional().describe("Drive file ID or Dropbox path of the original file"),
      swatcherHandle: z.string().optional().describe("Swatcher handle to append to filename (e.g., 'yyulia_m')"),

      // move_between_shades
      fromShade: z.string().optional().describe("Source shade name"),
      toShade: z.string().optional().describe("Destination shade name"),
      filename: z.string().optional().describe("Filename to move (within the staging folder)"),
    },
    async ({ action, ...p }) => {
      try {
        switch (action) {

          // ---------------------------------------------------------------
          // CREATE STAGING
          // ---------------------------------------------------------------
          case "create_staging": {
            if (!p.source || !p.collectionName || !p.shadeNames?.length) {
              return fail("create_staging requires source, collectionName, and shadeNames");
            }

            const useDropbox = isDropbox(p.source);
            const stagingName = `${p.collectionName} - Staging`;

            if (useDropbox) {
              // Dropbox: create under /NailStuff Staging/
              const rootPath = "/NailStuff Staging";
              await createDropboxFolder(rootPath);
              const stagingPath = `${rootPath}/${stagingName}`;
              await createDropboxFolder(stagingPath);

              const shades: Array<{ name: string; path: string }> = [];
              for (const shade of p.shadeNames) {
                const shadePath = `${stagingPath}/${shade}`;
                await createDropboxFolder(shadePath);
                shades.push({ name: shade, path: shadePath });
              }

              return ok({
                source: "dropbox",
                stagingFolder: stagingPath,
                stagingUrl: `https://www.dropbox.com/home${encodeURI(stagingPath).replace(/%20/g, "%20")}`,
                shades,
              });
            } else {
              // Google Drive: create under "NailStuff Staging" in root
              const root = await findOrCreateDriveFolder("NailStuff Staging");
              const staging = await findOrCreateDriveFolder(stagingName, root.id);

              const shades: Array<{ name: string; id: string }> = [];
              for (const shade of p.shadeNames) {
                const shadeFolder = await findOrCreateDriveFolder(shade, staging.id);
                shades.push({ name: shade, id: shadeFolder.id });
              }

              return ok({
                source: "google_drive",
                stagingFolder: staging.id,
                stagingName: stagingName,
                shades,
              });
            }
          }

          // ---------------------------------------------------------------
          // COPY TO SHADE
          // ---------------------------------------------------------------
          case "copy_to_shade": {
            if (!p.stagingFolder || !p.shade || !p.fileId) {
              return fail("copy_to_shade requires stagingFolder, shade, and fileId");
            }

            const useDropbox = p.stagingFolder.startsWith("/") || p.stagingFolder.includes("NailStuff Staging");

            if (useDropbox && p.stagingFolder.startsWith("/")) {
              // Dropbox: copy file
              const originalName = p.fileId.split("/").pop() ?? "image.jpg";
              const newName = stagingFilename(originalName, p.swatcherHandle);
              const toPath = `${p.stagingFolder}/${p.shade}/${newName}`;

              const result = await copyDropboxFile(p.fileId, toPath);
              return ok({ copied: result.path, filename: result.name });
            } else {
              // Google Drive: find shade folder, copy file
              const subs = await listSubfolders(p.stagingFolder);
              const shadeFolder = subs.find((s) => s.name === p.shade);
              if (!shadeFolder) return fail(`Shade folder "${p.shade}" not found in staging`);

              // Get original filename
              const originalName = p.fileId; // For Drive, we need the file ID
              // We need to get the file's name first
              const { google } = await import("googleapis");
              const drive = google.drive({ version: "v3" });
              // Actually, copyDriveFile handles the name
              const newName = stagingFilename("image.jpg", p.swatcherHandle);
              const result = await copyDriveFile(p.fileId, newName, shadeFolder.id);
              return ok({ copied: result.id, filename: result.name });
            }
          }

          // ---------------------------------------------------------------
          // MOVE BETWEEN SHADES
          // ---------------------------------------------------------------
          case "move_between_shades": {
            if (!p.stagingFolder || !p.fromShade || !p.toShade || !p.filename) {
              return fail("move_between_shades requires stagingFolder, fromShade, toShade, and filename");
            }

            const useDropbox = p.stagingFolder.startsWith("/");

            if (useDropbox) {
              const fromPath = `${p.stagingFolder}/${p.fromShade}/${p.filename}`;
              const toPath = `${p.stagingFolder}/${p.toShade}/${p.filename}`;
              const result = await moveDropboxFile(fromPath, toPath);
              return ok({ moved: result.path, from: p.fromShade, to: p.toShade });
            } else {
              // Google Drive: find both shade folders, move file
              const subs = await listSubfolders(p.stagingFolder);
              const fromFolder = subs.find((s) => s.name === p.fromShade);
              const toFolder = subs.find((s) => s.name === p.toShade);
              if (!fromFolder) return fail(`Shade folder "${p.fromShade}" not found`);
              if (!toFolder) return fail(`Shade folder "${p.toShade}" not found`);

              // Find the file in fromFolder
              const files = await listFolderImages(fromFolder.id);
              const file = files.find((f) => f.name === p.filename);
              if (!file) return fail(`File "${p.filename}" not found in "${p.fromShade}"`);

              await moveDriveFile(file.id, fromFolder.id, toFolder.id);
              return ok({ moved: file.id, from: p.fromShade, to: p.toShade });
            }
          }

          // ---------------------------------------------------------------
          // LIST STAGING
          // ---------------------------------------------------------------
          case "list_staging": {
            if (!p.stagingFolder) {
              return fail("list_staging requires stagingFolder");
            }

            const useDropbox = p.stagingFolder.startsWith("/");

            if (useDropbox) {
              const subs = await listOwnSubfolders(p.stagingFolder);
              const shades: Array<{ name: string; imageCount: number; files: string[] }> = [];

              for (const sub of subs) {
                const imgs = await listOwnFolderImages(sub.path);
                shades.push({
                  name: sub.name,
                  imageCount: imgs.length,
                  files: imgs.map((i) => i.name),
                });
              }

              return ok({
                stagingFolder: p.stagingFolder,
                totalShades: shades.length,
                totalImages: shades.reduce((sum, s) => sum + s.imageCount, 0),
                shades,
              });
            } else {
              const subs = await listSubfolders(p.stagingFolder);
              const shades: Array<{ name: string; id: string; imageCount: number; files: string[] }> = [];

              for (const sub of subs) {
                const imgs = await listFolderImages(sub.id);
                shades.push({
                  name: sub.name,
                  id: sub.id,
                  imageCount: imgs.length,
                  files: imgs.map((i) => i.name),
                });
              }

              return ok({
                stagingFolder: p.stagingFolder,
                totalShades: shades.length,
                totalImages: shades.reduce((sum, s) => sum + s.imageCount, 0),
                shades,
              });
            }
          }

          default:
            return fail(`Unknown action: ${action}`);
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `organize_images error: ${err}` }],
          isError: true,
        };
      }
    },
  );
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}
