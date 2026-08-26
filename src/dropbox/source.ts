/**
 * One definition of "is this a Dropbox source", shared by every tool.
 *
 * There used to be four, and they disagreed: organize_images and assign_shades
 * accepted bare paths ("/NailStuff Staging/..."), analyze_images and
 * discover_folder accepted only "dropbox.com/" URLs. An agent that passed the
 * form the other tools take got routed to Google Drive instead, which is not a
 * failure any caller can see from the tool descriptions.
 */
export function isDropboxSource(input: string): boolean {
  if (!input) return false;
  const s = input.trim();
  return (
    s.includes("dropbox.com/") ||
    s.includes("dropboxusercontent.com/") ||
    s.toLowerCase().startsWith("dropbox:") ||
    s.startsWith("/") ||
    s.startsWith("ns:")
  );
}

/**
 * Reduce any accepted Dropbox source to a plain API path ("" for root).
 * Returns null when the input is a shared link, which must be handled by the
 * sharing endpoints rather than by path.
 */
export function toDropboxPath(input: string): string | null {
  const s = input.trim();

  if (s.toLowerCase().startsWith("dropbox:")) return s.slice("dropbox:".length);

  const home = s.match(/dropbox\.com\/home(\/[^?#]*)?/);
  if (home) return decodeURIComponent(home[1] ?? "").replace(/\/+$/, "");

  // Shared links (/scl/fo/..., /s/...) are not path-addressable.
  if (s.includes("dropbox.com/") || s.includes("dropboxusercontent.com/")) return null;

  if (s.startsWith("/") || s.startsWith("ns:")) return s.replace(/\/+$/, "");

  return null;
}
