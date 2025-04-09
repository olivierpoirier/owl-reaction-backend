export default async function handler(req, res) {
    const token = process.env.DROPBOX_TOKEN
    const folderPath = '/owlbear' // ou '/audios'
  
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
  
      try {
        const data = JSON.parse(text)
  
        if (data.error) {
          console.error("❌ Réponse Dropbox contient une erreur :", data.error)
          return res.status(500).json({ error: data.error })
        }
  
        const audioFiles = data.entries
          .filter(f => f.name.endsWith('.mp3') || f.name.endsWith('.wav'))
          .map(f => ({
            name: f.name,
            path: f.path_lower
          }))
  
        return res.status(200).json(audioFiles)
      } catch (err) {
        console.error("❌ Impossible de parser JSON :", text)
        return res.status(500).json({ error: 'Réponse Dropbox invalide' })
      }
    } catch (err) {
      console.error("❌ Erreur de requête Dropbox :", err)
      res.status(500).json({ error: 'Erreur Dropbox' })
    }
  }
  