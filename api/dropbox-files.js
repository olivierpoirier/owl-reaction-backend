// dropbox-files.js
import dotenv from "dotenv";
dotenv.config();

const DROPBOX_API = "https://api.dropboxapi.com";
const DROPBOX_TOKEN_URL = `${DROPBOX_API}/oauth2/token`;
const DROPBOX_LIST_FOLDER = `${DROPBOX_API}/2/files/list_folder`;
const DROPBOX_LIST_FOLDER_CONTINUE = `${DROPBOX_API}/2/files/list_folder/continue`;
const DROPBOX_CREATE_LINK = `${DROPBOX_API}/2/sharing/create_shared_link_with_settings`;

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

function isAudioFile(name) {
  return /\.(mp3|wav|ogg|m4a|flac)$/i.test(name);
}

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
    return null;
  } catch (e) {
    console.error("createSharedLinkForPath error:", e);
    return null;
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

    const entries = await listFolderAll(token, path);

    // First map folders and files; folders will get count later
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

    // For files create shared links in parallel
    const files = basic.filter(e => e.type === "file");
    const filesWithLinks = await Promise.all(files.map(async (f) => {
      const link = await createSharedLinkForPath(token, f.path_lower);
      return {
        ...f,
        url: link ? link.replace(/\?dl=0$/, "?raw=1") : null,
      };
    }));

    // For folders: count audio files inside each folder.
    // Use Promise.allSettled so a single folder failure doesn't break everything.
    const folders = basic.filter(e => e.type === "folder");
    const folderCountsPromises = folders.map(async (folder) => {
      try {
        const subEntries = await listFolderAll(token, folder.path_lower);
        const audioCount = subEntries.filter(se => se[".tag"] === "file" && isAudioFile(se.name)).length;
        return { ...folder, count: audioCount };
      } catch (e) {
        console.warn("Erreur comptage dossier", folder.path_lower, e);
        return { ...folder, count: 0 };
      }
    });

    const folderCountsSettled = await Promise.allSettled(folderCountsPromises);
    const foldersWithCounts = folderCountsSettled.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      // fallback
      return { ...folders[i], count: 0 };
    });

    // Combine: folders first (with counts) then files with urls
    const combined = [
      ...foldersWithCounts.sort((a,b) => a.name.localeCompare(b.name, undefined, {sensitivity:'base'})),
      ...filesWithLinks.sort((a,b) => a.name.localeCompare(b.name, undefined, {sensitivity:'base'})),
    ];

    // Ensure files include url (filter out files without url)
    const final = combined.filter(item => item.type !== "file" || !!item.url);

    res.status(200).json({ path: path || "/", entries: final });
  } catch (err) {
    console.error("❌ Dropbox API error:", err);
    res.status(500).json({ error: "Erreur Dropbox", details: String(err) });
  }
}
