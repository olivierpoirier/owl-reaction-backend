// dropbox-files.js (optimisé : concurrency limit + cache TTL)
import dotenv from "dotenv";
dotenv.config();

const DROPBOX_API = "https://api.dropboxapi.com";
const DROPBOX_TOKEN_URL = `${DROPBOX_API}/oauth2/token`;
const DROPBOX_LIST_FOLDER = `${DROPBOX_API}/2/files/list_folder`;
const DROPBOX_LIST_FOLDER_CONTINUE = `${DROPBOX_API}/2/files/list_folder/continue`;
const DROPBOX_CREATE_LINK = `${DROPBOX_API}/2/sharing/create_shared_link_with_settings`;

/**
 * Config via env
 * DROPBOX_CONCURRENCY: number of parallel workers for expensive ops (default 6)
 * COUNT_CACHE_TTL_SECONDS: TTL for folder count cache in seconds (default 300)
 */
const CONCURRENCY = parseInt(process.env.DROPBOX_CONCURRENCY || "6", 10);
const COUNT_CACHE_TTL_SECONDS = parseInt(process.env.COUNT_CACHE_TTL_SECONDS || "300", 10);

// Simple in-memory cache for folder counts: { key -> { value, expiresAt } }
// Note: in serverless this persists only while instance is warm — still very useful.
const countCache = new Map();

async function getAccessToken() {
  const credentials = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString("base64");
  const response = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
    }),
  });

  const data = await response.json();
  if (!data.access_token) {
    console.error("❌ Impossible d'obtenir un access_token :", data);
    throw new Error("Échec obtention access_token Dropbox");
  }
  return data.access_token;
}

function isAudioFile(name) {
  return /\.(mp3|wav|ogg|m4a|flac)$/i.test(name);
}

/**
 * List a folder fully (handles has_more / continue)
 */
async function listFolderAll(token, path) {
  const entries = [];
  let has_more = true;
  let cursor = null;
  let url = DROPBOX_LIST_FOLDER;
  let body = { path, recursive: false, include_media_info: false, include_deleted: false };

  while (has_more) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw data.error;
    entries.push(...(data.entries || []));
    has_more = data.has_more;
    cursor = data.cursor;
    if (has_more) {
      url = DROPBOX_LIST_FOLDER_CONTINUE;
      body = { cursor };
    }
  }
  return entries;
}

/**
 * Create or retrieve a shared link for a path.
 */
async function createSharedLinkForPath(token, path_lower) {
  try {
    const res = await fetch(DROPBOX_CREATE_LINK, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: path_lower }),
    });
    const data = await res.json();
    if (data.url) return data.url;
    if (data.error && data.error[".tag"] === "shared_link_already_exists" && data.error.shared_link_already_exists?.metadata?.url) {
      return data.error.shared_link_already_exists.metadata.url;
    }
    console.warn("No shared link data for", path_lower, data);
    return null;
  } catch (e) {
    console.error("createSharedLinkForPath error:", e);
    return null;
  }
}

/**
 * Concurrency-limited mapper
 * items: array
 * limit: number of workers
 * fn: async function(item) => result
 */
async function limitedMap(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;

  async function worker() {
    while (true) {
      const index = i++;
      if (index >= items.length) return;
      try {
        const r = await fn(items[index], index);
        results[index] = r;
      } catch (e) {
        // propagate as rejection to caller by storing the error object; caller can use Promise.allSettled equivalently
        results[index] = { __error: e && String(e) };
      }
    }
  }

  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Get cached count for folder if fresh; otherwise compute and cache.
 */
async function getFolderAudioCountCached(token, folderPath) {
  const key = `count:${folderPath}`;
  const now = Date.now();
  const cached = countCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  // compute count
  try {
    const subEntries = await listFolderAll(token, folderPath);
    const audioCount = subEntries.filter(se => se[".tag"] === "file" && isAudioFile(se.name)).length;
    countCache.set(key, { value: audioCount, expiresAt: now + COUNT_CACHE_TTL_SECONDS * 1000 });
    return audioCount;
  } catch (e) {
    console.warn("Erreur comptage dossier (cached) for", folderPath, e);
    // don't cache failures aggressively; return 0 as fallback
    return 0;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const token = await getAccessToken();
    const pathQuery = req.query.path || (req.body && req.body.path) || "/owlbear";
    const path = pathQuery === "/" ? "" : pathQuery;

    // list current folder
    const entries = await listFolderAll(token, path);

    // map basic structure
    const basic = entries.map((entry) => {
      if (entry[".tag"] === "folder") {
        return {
          type: "folder",
          name: entry.name,
          path_lower: entry.path_lower,
        };
      }
      if (entry[".tag"] === "file") {
        if (!isAudioFile(entry.name)) return null;
        return {
          type: "file",
          name: entry.name,
          path_lower: entry.path_lower,
        };
      }
      return null;
    }).filter(Boolean);

    // split
    const folders = basic.filter(e => e.type === "folder");
    const files = basic.filter(e => e.type === "file");

    // 1) create shared links for files with concurrency limit
    const fileLinkResults = await limitedMap(files, CONCURRENCY, async (f) => {
      const link = await createSharedLinkForPath(token, f.path_lower);
      return {
        ...f,
        url: link ? link.replace(/\?dl=0$/, "?raw=1") : null,
      };
    });

    // filter files that got url
    const filesWithLinks = fileLinkResults
      .map((r, idx) => {
        // if r is {__error:...} treat as url=null
        if (r && r.__error) {
          console.warn("Erreur création lien fichier:", files[idx].path_lower, r.__error);
          return { ...files[idx], url: null };
        }
        return r;
      })
      .filter(f => !!f.url);

    // 2) compute folder counts with concurrency limit and caching
    const folderCountResults = await limitedMap(folders, CONCURRENCY, async (folder) => {
      // try cached value first
      const count = await getFolderAudioCountCached(token, folder.path_lower);
      return { ...folder, count };
    });

    const foldersWithCounts = folderCountResults.map((r, idx) => {
      if (r && r.__error) {
        console.warn("Erreur comptage dossier:", folders[idx].path_lower, r.__error);
        return { ...folders[idx], count: 0 };
      }
      return r;
    });

    // combine: folders first then files
    const combined = [
      ...foldersWithCounts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      ...filesWithLinks.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    ];

    res.status(200).json({ path: path || "/", entries: combined });
  } catch (err) {
    console.error("❌ Dropbox API error:", err);
    res.status(500).json({ error: "Erreur Dropbox", details: String(err) });
  }
}
