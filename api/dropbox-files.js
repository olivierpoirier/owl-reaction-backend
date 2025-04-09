export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") return res.status(200).end()

  // Fonction qui génère un access_token temporaire à partir du refresh_token
  const getAccessToken = async () => {
    const credentials = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString("base64")
    const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
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

  try {
    const token = await getAccessToken()
    const folderPath = "/owlbear"

    // 1. Liste les fichiers dans le dossier
    const listRes = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: folderPath }),
    })

    const listData = await listRes.json()
    if (listData.error) return res.status(500).json({ error: listData.error })

    const audioFiles = []

    // 2. Pour chaque fichier audio, créer ou récupérer le lien partagé
    for (const file of listData.entries) {
      if (file.name.endsWith(".mp3") || file.name.endsWith(".wav")) {
        const linkRes = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: file.path_lower }),
        })

        const linkData = await linkRes.json()

        let url = null

        if (linkData?.url) {
          url = linkData.url
        } else if (linkData?.error?.[".tag"] === "shared_link_already_exists") {
          url = linkData.error.shared_link_already_exists.metadata.url
        }

        if (url) {
          url = url.replace(/\?dl=0$/, "?raw=1")
          audioFiles.push({ name: file.name, url })
        } else {
          console.warn(`⚠️ Aucun lien public pour ${file.name}`, linkData)
        }
      }
    }

    return res.status(200).json(audioFiles)
  } catch (err) {
    console.error("❌ Erreur Dropbox :", err)
    return res.status(500).json({ error: "Erreur Dropbox" })
  }
}
