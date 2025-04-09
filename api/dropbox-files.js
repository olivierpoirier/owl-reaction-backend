export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  
    if (req.method === "OPTIONS") {
      return res.status(200).end()
    }
  
    const token = process.env.DROPBOX_TOKEN
    const folderPath = '/owlbear'
  
    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: folderPath })
      })
  
      const data = await response.json()
  
      if (data.error) {
        console.error("❌ Dropbox list_folder error:", data.error)
        return res.status(500).json({ error: data.error })
      }
  
      const audioFiles = []
  
      for (const file of data.entries) {
        if (file.name.endsWith('.mp3') || file.name.endsWith('.wav')) {
          const shareRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              path: file.path_lower,
              settings: {
                requested_visibility: 'public'
              }
            })
          })
  
          const shareData = await shareRes.json()
  
          let rawUrl = null
          if (shareData && shareData.url) {
            rawUrl = shareData.url.replace("?dl=0", "?raw=1")
          } else {
            console.warn(`⚠️ Impossible de générer un lien public pour ${file.name}`)
            continue
          }
  
          audioFiles.push({
            name: file.name,
            url: rawUrl
          })
        }
      }
  
      return res.status(200).json(audioFiles)
    } catch (err) {
      console.error("❌ Dropbox error:", err)
      return res.status(500).json({ error: "Erreur Dropbox" })
    }
  }
  