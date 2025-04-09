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
  
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
      } catch (e) {
        console.error("❌ JSON invalide (list_folder) :", text)
        return res.status(500).json({ error: "Réponse Dropbox invalide (list_folder)" })
      }
  
      if (data.error) {
        console.error("❌ Dropbox list_folder error:", data.error)
        return res.status(500).json({ error: data.error })
      }
  
      const audioFiles = []
  
      for (const file of data.entries) {
        if (file.name.endsWith('.mp3') || file.name.endsWith('.wav')) {
          const createRes = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ path: file.path_lower })
          })
  
          const createText = await createRes.text()
          let createData
          try {
            createData = JSON.parse(createText)
          } catch (e) {
            console.error(`❌ JSON invalide (create_shared_link) :`, createText)
            continue
          }
  
          // Gérer le cas où le lien existe déjà
          if (createData?.url) {
            const rawUrl = createData.url.replace("?dl=0", "?raw=1")
            audioFiles.push({
              name: file.name,
              url: rawUrl
            })
          } else if (createData?.error?.['.tag'] === 'shared_link_already_exists') {
            const existing = createData.error.shared_link_already_exists.metadata
            const rawUrl = existing.url.replace("?dl=0", "?raw=1")
            audioFiles.push({
              name: file.name,
              url: rawUrl
            })
          } else {
            console.warn(`⚠️ Aucun lien public disponible pour ${file.name}`, createData)
            continue
          }
        }
      }
  
      return res.status(200).json(audioFiles)
    } catch (err) {
      console.error("❌ Dropbox error:", err)
      return res.status(500).json({ error: "Erreur Dropbox" })
    }
  }