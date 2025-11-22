import dotenv from "dotenv"
dotenv.config()

const DROPBOX_API = "https://api.dropboxapi.com"
const DROPBOX_TOKEN_URL = `${DROPBOX_API}/oauth2/token`
const DROPBOX_LIST_FOLDER = `${DROPBOX_API}/2/files/list_folder`
const DROPBOX_CREATE_LINK = `${DROPBOX_API}/2/sharing/create_shared_link_with_settings`

async function getAccessToken() {
  const credentials = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString("base64")
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
  })

  const data = await response.json()

  if (!data.access_token) {
    console.error("❌ Impossible d'obtenir un access_token :", data)
    throw new Error("Échec lors de l’obtention de l'access_token Dropbox")
  }

  return data.access_token
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") return res.status(200).end()

  try {
    const token = await getAccessToken()
    // Récupère le chemin depuis les paramètres de requête, sinon utilise la racine
    const currentPath = req.query.path && req.query.path !== "/" ? req.query.path : "/owlbear"

    const listRes = await fetch(DROPBOX_LIST_FOLDER, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: currentPath }), // Utilise le chemin dynamique
    })

    const listData = await listRes.json()
    if (listData.error) return res.status(500).json({ error: listData.error })

    const isAudio = (file) => file[".tag"] === "file" && (file.name.endsWith(".mp3") || file.name.endsWith(".wav"))
    const isFolder = (file) => file[".tag"] === "folder"

    // 1. Traitement des dossiers
    const folders = listData.entries.filter(isFolder).map(folder => ({
      name: folder.name,
      path: folder.path_lower,
      isFolder: true, // Nouveau flag
    }))

    // 2. Traitement des fichiers audio (avec création du lien public)
    const audioFiles = await Promise.all(
      listData.entries.filter(isAudio).map(async (file) => {
        try {
          const linkRes = await fetch(DROPBOX_CREATE_LINK, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ path: file.path_lower }),
          })

          const linkData = await linkRes.json()

          const url = linkData?.url
            || linkData?.error?.[".tag"] === "shared_link_already_exists"
              && linkData.error.shared_link_already_exists.metadata.url

          if (!url) {
            console.warn(`⚠️ Aucun lien public pour ${file.name}`, linkData)
            return null
          }

          return {
            name: file.name,
            url: url.replace(/\?dl=0$/, "?raw=1"),
            isFolder: false, // Nouveau flag
            path: file.path_lower,
          }
        } catch (e) {
          console.error(`❌ Erreur création lien pour ${file.name} :`, e)
          return null
        }
      })
    )

    // Retourne les dossiers en premier, puis les fichiers
    res.status(200).json([...folders, ...audioFiles.filter(Boolean)])
  } catch (err) {
    console.error("❌ Dropbox error:", err)
    res.status(500).json({ error: "Erreur Dropbox" })
  }
}