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
    const folderPath = "/owlbear"

    const listRes = await fetch(DROPBOX_LIST_FOLDER, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: folderPath }),
    })

    const listData = await listRes.json()
    if (listData.error) return res.status(500).json({ error: listData.error })

    const isAudio = (file) => file.name.endsWith(".mp3") || file.name.endsWith(".wav")

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
          }
        } catch (e) {
          console.error(`❌ Erreur création lien pour ${file.name} :`, e)
          return null
        }
      })
    )

    res.status(200).json(audioFiles.filter(Boolean))
  } catch (err) {
    console.error("❌ Dropbox error:", err)
    res.status(500).json({ error: "Erreur Dropbox" })
  }
}
