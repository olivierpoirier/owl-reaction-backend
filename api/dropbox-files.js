// dropbox-files.js
import dotenv from "dotenv";
dotenv.config();

const DROPBOX_API = "https://api.dropboxapi.com";
const DROPBOX_TOKEN_URL = `${DROPBOX_API}/oauth2/token`;
const DROPBOX_LIST_FOLDER = `${DROPBOX_API}/2/files/list_folder`;
const DROPBOX_GET_TEMP_LINK = `${DROPBOX_API}/2/files/get_temporary_link`;
const DROPBOX_LIST_FOLDER_CONTINUE = `${DROPBOX_API}/2/files/list_folder/continue`;

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
    throw new Error("Échec lors de l’obtention de l'access_token Dropbox");
  }

  return data.access_token;
}

async function listFolderAll(token, path) {
  const entries = [];
  let has_more = true;
  let cursor = null;

  let body = { path, recursive: false, include_media_info: false, include_deleted: false, include_has_explicit_shared_members: false };
  let url = DROPBOX_LIST_FOLDER;

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

async function getTemporaryLink(token, path_lower) {
  try {
    const res = await fetch(DROPBOX_GET_TEMP_LINK, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: path_lower }),
    });
    const data = await res.json();
    // data.link is the temporary direct link to file contents
    if (data && data.link) return data.link;
    if (data && data.error) {
      console.warn("get_temporary_link returned error:", data.error);
    }
    return null;
  } catch (e) {
    console.error("getTemporaryLink error:", e);
    return null;
  }
}

function isAudioFile(name) {
  return /\.(mp3|wav|ogg|m4a|flac)$/i.test(name);
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

    const mapped = await Promise.all(
      entries.map(async (entry) => {
        if (entry[".tag"] === "folder") {
          return {
            type: "folder",
            name: entry.name,
            path_lower: entry.path_lower,
          };
        }
        if (entry[".tag"] === "file") {
          if (!isAudioFile(entry.name)) return null;
          // use get_temporary_link for files (more reliable than shared links for direct access)
          const tempLink = await getTemporaryLink(token, entry.path_lower);
          return {
            type: "file",
            name: entry.name,
            path_lower: entry.path_lower,
            url: tempLink, // may be null on error
          };
        }
        return null;
      })
    );

    const filtered = mapped.filter(Boolean);
    filtered.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    res.status(200).json({ path: path || "/", entries: filtered });
  } catch (err) {
    console.error("❌ Dropbox API error:", err);
    res.status(500).json({ error: "Erreur Dropbox", details: String(err) });
  }
}
