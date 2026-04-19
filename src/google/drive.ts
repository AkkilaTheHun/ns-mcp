import { google, type drive_v3 } from "googleapis";
import { getServiceAccountKey } from "./auth.js";
import { GoogleAuth } from "googleapis-common";

let cachedDriveAuth: GoogleAuth | undefined;
let cachedDrive: drive_v3.Drive | undefined;

const SUBJECT = "admin@nailstuff.co";

function getDriveAuth(): GoogleAuth {
  if (!cachedDriveAuth) {
    cachedDriveAuth = new GoogleAuth({
      credentials: getServiceAccountKey(),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      clientOptions: { subject: SUBJECT },
    });
  }
  return cachedDriveAuth;
}

function getDrive(): drive_v3.Drive {
  if (!cachedDrive) {
    cachedDrive = google.drive({ version: "v3", auth: getDriveAuth() });
  }
  return cachedDrive;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  parentId: string;
}

/** List image files in a Drive folder. */
export async function listFolderImages(folderId: string): Promise<DriveFile[]> {
  const drive = getDrive();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      pageSize: 100,
      fields: "nextPageToken, files(id, name, mimeType, size, parents)",
      pageToken,
    });

    for (const f of res.data.files ?? []) {
      // Enforce §12a product↔folder binding: parent must match folderId
      const parentId = (f.parents ?? [])[0];
      if (parentId !== folderId) continue;

      files.push({
        id: f.id!,
        name: f.name!,
        mimeType: f.mimeType!,
        size: Number(f.size ?? 0),
        parentId,
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/** Download a file's content as a Buffer. */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/** Get metadata for a folder (name, parents). */
export async function getFolderMeta(folderId: string): Promise<{ name: string; parents: string[] }> {
  const drive = getDrive();
  const res = await drive.files.get({
    fileId: folderId,
    fields: "name, parents, mimeType",
  });
  if (res.data.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(`${folderId} is not a folder (got ${res.data.mimeType})`);
  }
  return {
    name: res.data.name!,
    parents: res.data.parents ?? [],
  };
}
