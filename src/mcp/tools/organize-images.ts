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
import sharp from "sharp";
import {
  findOrCreateDriveFolder,
  copyDriveFile,
  moveDriveFile,
  listFolderImages,
  listSubfolders,
  downloadFile,
} from "../../google/drive.js";
import {
  createDropboxFolder,
  copyDropboxFile,
  moveDropboxFile,
  listOwnFolderImages,
  listOwnSubfolders,
  downloadOwnFile,
} from "../../dropbox/client.js";
import { shopifyGraphQL, throwIfUserErrors } from "../../shopify/client.js";
import { getCurrentSessionId } from "../../context.js";
import { getSessionShop } from "../../session.js";
import { config } from "../../config.js";

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
- copy_to_shade: Copy one or more files into shade subfolders, renaming with swatcher info. Pass a single file (shade + fileId + swatcherHandle) or a batch (files array with shade, fileId, swatcherHandle per item).
- stage_all: Create staging folders AND copy all files in one call. Pass shadeAssignments — a compact map of shade name to array of {fileId, swatcherHandle}. Creates folders + copies everything. Saves tokens vs separate create_staging + copy_to_shade calls.
- move_between_shades: Move a file from one shade folder to another (for corrections after review).
- list_staging: List the current state of a staging folder (shade counts + filenames).
- push_to_product: Push all images from a shade folder to a Shopify product. Downloads, compresses, uploads via staged uploads. Generates alt text from shade name + brand + swatcher handle in filename. One call per product.

Workflow:
1. After analyze_images, call stage_all with source, collectionName, and shadeAssignments
2. Tell the user to review the folders and drag any misidentified images
3. After review, call push_to_product for each shade/product pair
4. Done. No need to build media arrays or pass individual file paths.`,
    {
      action: z.enum(["create_staging", "copy_to_shade", "stage_all", "move_between_shades", "list_staging", "push_to_product"]),

      // create_staging
      source: z.string().optional().describe("Drive folder ID or Dropbox /home/ URL of the source collection"),
      collectionName: z.string().optional().describe("Collection name (e.g., 'Take It Easy')"),
      shadeNames: z.array(z.string()).optional().describe("Shade/product names to create subfolders for"),

      // copy_to_shade (single or batch)
      stagingFolder: z.string().optional().describe("Staging folder ID (Drive) or path (Dropbox) from create_staging"),
      shade: z.string().optional().describe("Target shade name (for single file copy)"),
      fileId: z.string().optional().describe("Drive file ID or Dropbox path of the original file (for single file copy)"),
      swatcherHandle: z.string().optional().describe("Swatcher handle to append to filename (for single file copy)"),
      files: z.array(z.object({
        shade: z.string().describe("Target shade name"),
        fileId: z.string().describe("Drive file ID or Dropbox path"),
        swatcherHandle: z.string().optional().describe("Swatcher handle"),
      })).optional().describe("Batch copy: array of files with shade, fileId, swatcherHandle per item"),

      // stage_all (compact: create + copy in one call)
      shadeAssignments: z.record(
        z.string(),
        z.array(z.object({
          fileId: z.string(),
          swatcherHandle: z.string().optional(),
        })),
      ).optional().describe("Map of shade name to array of {fileId, swatcherHandle}. E.g., {\"Sweet Nothing\": [{fileId: \"/path/img.jpg\", swatcherHandle: \"yyulia_m\"}]}"),

      // push_to_product
      productId: z.string().optional().describe("Shopify product GID to push images to"),
      brand: z.string().optional().describe("Brand name for alt text generation"),

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
            if (!p.stagingFolder) {
              return fail("copy_to_shade requires stagingFolder");
            }

            // Build file list: either from batch array or single params
            const filesToCopy: Array<{ shade: string; fileId: string; swatcherHandle?: string }> = [];
            if (p.files?.length) {
              filesToCopy.push(...p.files);
            } else if (p.shade && p.fileId) {
              filesToCopy.push({ shade: p.shade, fileId: p.fileId, swatcherHandle: p.swatcherHandle });
            } else {
              return fail("copy_to_shade requires either 'files' array or 'shade' + 'fileId'");
            }

            const useDropbox = p.stagingFolder.startsWith("/");
            const results: Array<{ shade: string; filename: string; ok: boolean; error?: string }> = [];

            // Pre-fetch Drive shade folders if needed
            let driveShadeFolders: Map<string, string> | undefined;
            if (!useDropbox) {
              const subs = await listSubfolders(p.stagingFolder);
              driveShadeFolders = new Map(subs.map((s) => [s.name, s.id]));
            }

            for (const file of filesToCopy) {
              try {
                if (useDropbox) {
                  const originalName = file.fileId.split("/").pop() ?? "image.jpg";
                  const newName = stagingFilename(originalName, file.swatcherHandle);
                  const toPath = `${p.stagingFolder}/${file.shade}/${newName}`;
                  await copyDropboxFile(file.fileId, toPath);
                  results.push({ shade: file.shade, filename: newName, ok: true });
                } else {
                  const shadeFolderId = driveShadeFolders?.get(file.shade);
                  if (!shadeFolderId) {
                    results.push({ shade: file.shade, filename: file.fileId, ok: false, error: `Shade folder "${file.shade}" not found` });
                    continue;
                  }
                  const newName = stagingFilename("image.jpg", file.swatcherHandle);
                  await copyDriveFile(file.fileId, newName, shadeFolderId);
                  results.push({ shade: file.shade, filename: newName, ok: true });
                }
              } catch (err) {
                results.push({ shade: file.shade, filename: file.fileId, ok: false, error: String(err) });
              }
            }

            const succeeded = results.filter((r) => r.ok).length;
            const failed = results.filter((r) => !r.ok).length;
            // Only include failed items in results to save tokens
            const failedItems = results.filter((r) => !r.ok);
            return ok({
              total: results.length,
              succeeded,
              failed,
              ...(failedItems.length > 0 ? { failedItems } : {}),
            });
          }

          // ---------------------------------------------------------------
          // STAGE ALL (create folders + copy everything in one call)
          // ---------------------------------------------------------------
          case "stage_all": {
            if (!p.source || !p.collectionName || !p.shadeAssignments) {
              return fail("stage_all requires source, collectionName, and shadeAssignments");
            }

            const shadeNames = Object.keys(p.shadeAssignments);
            const useDropbox = isDropbox(p.source);
            const stagingName = `${p.collectionName} - Staging`;

            // Step 1: Create folders
            let stagingPath: string;
            if (useDropbox) {
              const rootPath = "/NailStuff Staging";
              await createDropboxFolder(rootPath);
              stagingPath = `${rootPath}/${stagingName}`;
              await createDropboxFolder(stagingPath);
              for (const shade of shadeNames) {
                await createDropboxFolder(`${stagingPath}/${shade}`);
              }
            } else {
              const root = await findOrCreateDriveFolder("NailStuff Staging");
              const staging = await findOrCreateDriveFolder(stagingName, root.id);
              stagingPath = staging.id;
              for (const shade of shadeNames) {
                await findOrCreateDriveFolder(shade, staging.id);
              }
            }

            // Step 2: Copy all files
            let succeeded = 0;
            let failed = 0;
            const failedItems: Array<{ shade: string; fileId: string; error: string }> = [];

            // Pre-fetch Drive shade folders if needed
            let driveShadeFolders: Map<string, string> | undefined;
            if (!useDropbox) {
              const subs = await listSubfolders(stagingPath);
              driveShadeFolders = new Map(subs.map((s) => [s.name, s.id]));
            }

            for (const [shade, files] of Object.entries(p.shadeAssignments)) {
              for (const file of files) {
                try {
                  if (useDropbox) {
                    const originalName = file.fileId.split("/").pop() ?? "image.jpg";
                    const newName = stagingFilename(originalName, file.swatcherHandle);
                    await copyDropboxFile(file.fileId, `${stagingPath}/${shade}/${newName}`);
                  } else {
                    const shadeFolderId = driveShadeFolders?.get(shade);
                    if (!shadeFolderId) throw new Error(`Shade folder "${shade}" not found`);
                    const newName = stagingFilename("image.jpg", file.swatcherHandle);
                    await copyDriveFile(file.fileId, newName, shadeFolderId);
                  }
                  succeeded++;
                } catch (err) {
                  failed++;
                  failedItems.push({ shade, fileId: file.fileId, error: String(err) });
                }
              }
            }

            const stagingUrl = useDropbox
              ? `https://www.dropbox.com/home${encodeURI(stagingPath).replace(/%20/g, "%20")}`
              : undefined;

            return ok({
              stagingFolder: stagingPath,
              ...(stagingUrl ? { stagingUrl } : {}),
              shades: shadeNames,
              total: succeeded + failed,
              succeeded,
              failed,
              ...(failedItems.length > 0 ? { failedItems } : {}),
            });
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

          // ---------------------------------------------------------------
          // PUSH TO PRODUCT (staging folder → Shopify product images)
          // ---------------------------------------------------------------
          case "push_to_product": {
            if (!p.stagingFolder || !p.shade || !p.productId) {
              return fail("push_to_product requires stagingFolder, shade, and productId");
            }

            // Resolve shop
            let shop: string | undefined;
            const sid = getCurrentSessionId();
            if (sid) shop = getSessionShop(sid);
            if (!shop) {
              const domains = [...config.shops.keys()];
              if (domains.length === 1) shop = domains[0];
              else {
                const prod = domains.filter((d) => !d.includes("-dev"));
                if (prod.length === 1) shop = prod[0];
              }
            }
            if (!shop) return fail("No shop selected. Use shopify_shop(action: 'select') first.");

            const useDropbox = p.stagingFolder.startsWith("/");
            const shadePath = useDropbox
              ? `${p.stagingFolder}/${p.shade}`
              : undefined;

            // List images in shade folder
            interface StagedImage { name: string; path?: string; id?: string }
            const images: StagedImage[] = [];

            if (useDropbox) {
              const imgs = await listOwnFolderImages(shadePath!);
              for (const img of imgs) images.push({ name: img.name, path: img.path });
            } else {
              const subs = await listSubfolders(p.stagingFolder);
              const shadeFolder = subs.find((s) => s.name === p.shade);
              if (!shadeFolder) return fail(`Shade folder "${p.shade}" not found`);
              const imgs = await listFolderImages(shadeFolder.id);
              for (const img of imgs) images.push({ name: img.name, id: img.id });
            }

            if (images.length === 0) {
              return fail(`No images found in staging folder for "${p.shade}"`);
            }

            // Upload each image to Shopify
            const brandName = p.brand ?? "polish";
            let uploaded = 0;
            const errors: string[] = [];

            for (let i = 0; i < images.length; i++) {
              const img = images[i];
              try {
                // Download
                const raw = useDropbox
                  ? await downloadOwnFile(img.path!)
                  : await downloadFile(img.id!);

                // Compress
                const compressed = await sharp(raw, { failOn: "none" })
                  .rotate()
                  .jpeg({ quality: 85, mozjpeg: true })
                  .toBuffer();

                // Extract swatcher from filename (pattern: xxx_swatcher-handle.ext)
                const swatcherMatch = img.name.match(/_swatcher-([^.]+)\./);
                const swatcher = swatcherMatch ? `@${swatcherMatch[1]}` : "";

                // Generate alt text
                const alt = `${brandName} nail polish in ${p.shade}${swatcher ? `, swatched by ${swatcher}` : ""}`;

                // SEO filename
                const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                const seoFilename = `${kebab(brandName)}-${kebab(p.shade)}-${i + 1}.jpg`;

                // Staged upload
                const stageRes = await shopifyGraphQL<{
                  stagedUploadsCreate: {
                    stagedTargets: Array<{ url: string; resourceUrl: string }>;
                    userErrors: Array<{ field: string[]; message: string }>;
                  };
                }>(
                  `mutation($input: [StagedUploadInput!]!) {
                    stagedUploadsCreate(input: $input) {
                      stagedTargets { url resourceUrl }
                      userErrors { field message }
                    }
                  }`,
                  {
                    input: [{
                      filename: seoFilename,
                      mimeType: "image/jpeg",
                      httpMethod: "PUT",
                      resource: "IMAGE",
                      fileSize: String(compressed.length),
                    }],
                  },
                  shop,
                );

                throwIfUserErrors(stageRes.data?.stagedUploadsCreate?.userErrors, "stagedUploadsCreate");
                const target = stageRes.data?.stagedUploadsCreate?.stagedTargets?.[0];
                if (!target) { errors.push(`${img.name}: no staged target`); continue; }

                // Upload to staged URL
                const uploadRes = await fetch(target.url, {
                  method: "PUT",
                  headers: { "Content-Type": "image/jpeg", "Content-Length": String(compressed.length) },
                  body: new Blob([new Uint8Array(compressed)], { type: "image/jpeg" }),
                });
                if (!uploadRes.ok) { errors.push(`${img.name}: upload HTTP ${uploadRes.status}`); continue; }

                // Attach to product
                const attachRes = await shopifyGraphQL<{
                  productCreateMedia: {
                    media: Array<{ id: string }>;
                    mediaUserErrors: Array<{ field: string[]; message: string }>;
                  };
                }>(
                  `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
                    productCreateMedia(productId: $productId, media: $media) {
                      media { id }
                      mediaUserErrors { field message }
                    }
                  }`,
                  {
                    productId: p.productId,
                    media: [{ originalSource: target.resourceUrl, alt, mediaContentType: "IMAGE" }],
                  },
                  shop,
                );

                const mediaErrors = attachRes.data?.productCreateMedia?.mediaUserErrors;
                if (mediaErrors?.length) { errors.push(`${img.name}: ${mediaErrors.map((e) => e.message).join(", ")}`); continue; }

                uploaded++;
                console.log(`[organize] Pushed ${img.name} to product (${uploaded}/${images.length})`);
              } catch (err) {
                errors.push(`${img.name}: ${err}`);
              }
            }

            return ok({
              productId: p.productId,
              shade: p.shade,
              total: images.length,
              uploaded,
              failed: errors.length,
              ...(errors.length > 0 ? { errors } : {}),
            });
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
