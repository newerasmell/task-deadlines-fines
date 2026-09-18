import { env } from "./env";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  size?: string;
}

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function requireGoogleConfig(): void {
  if (!env.googleClientId || !env.googleClientSecret || !env.googleRefreshToken) {
    throw new Error(
      "Google OAuth не е конфигуриран (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN) — интеграцията с Google Meet изисква го."
    );
  }
}

/**
 * Exchanges the long-lived refresh token for a short-lived access token,
 * cached in-memory until shortly before it expires — every poll cycle and
 * every file download reuses this instead of hitting the token endpoint
 * per-call.
 */
async function getAccessToken(): Promise<string> {
  requireGoogleConfig();

  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }

  const res = await fetch(`${env.googleOauthBaseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: env.googleRefreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google OAuth token HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedAccessToken.token;
}

async function driveGet(path: string, params: Record<string, string>): Promise<Response> {
  const token = await getAccessToken();
  const url = new URL(`${env.googleDriveApiBaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Drive API HTTP ${res.status} (${path}): ${body.slice(0, 500)}`);
  }
  return res;
}

/**
 * Locates the Meet-recordings Drive folder by exact name (configurable via
 * GOOGLE_MEET_FOLDER_NAME). Returns null rather than throwing when it isn't
 * found — the caller decides how to surface that (e.g. a status endpoint).
 */
export async function findMeetFolderId(folderName: string = env.googleMeetFolderName): Promise<string | null> {
  const escaped = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await driveGet("/drive/v3/files", { q: query, fields: "files(id,name)", pageSize: "1" });
  const data = (await res.json()) as { files: { id: string; name: string }[] };
  return data.files[0]?.id ?? null;
}

/**
 * Lists files directly inside a folder, oldest first (so a polling job that
 * caps how many it processes per cycle naturally works through a backlog in
 * order rather than always re-seeing only the newest ones).
 */
export async function listFilesInFolder(folderId: string, pageSize = 20): Promise<DriveFile[]> {
  const query = `'${folderId}' in parents and trashed = false`;
  const res = await driveGet("/drive/v3/files", {
    q: query,
    fields: "files(id,name,mimeType,createdTime,size)",
    orderBy: "createdTime",
    pageSize: String(pageSize),
  });
  const data = (await res.json()) as { files: DriveFile[] };
  return data.files;
}

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export function isFolder(mimeType: string): boolean {
  return mimeType === FOLDER_MIME_TYPE;
}

/** Downloads a regular (non-Google-native) file's raw bytes. */
export async function downloadFileBuffer(fileId: string): Promise<Buffer> {
  const res = await driveGet(`/drive/v3/files/${fileId}`, { alt: "media" });
  return Buffer.from(await res.arrayBuffer());
}

