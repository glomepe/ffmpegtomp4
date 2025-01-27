import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

let ffmpeg = null;

async function loadFFmpeg() {
  try {
    console.log('Chargement de FFmpeg...');
    ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      console.log('FFmpeg log:', message);
    });

    ffmpeg.on('progress', ({ progress, time }) => {
      document.getElementById('status').textContent = `Progression : ${Math.round(progress * 100)}%`;
    });

    await ffmpeg.load();

    console.log('FFmpeg chargé avec succès');
    document.getElementById('status').textContent = 'FFmpeg est prêt !';
    document.getElementById('caca').disabled = false;
  } catch (error) {
    console.error('Erreur de chargement FFmpeg:', error);
    document.getElementById('status').textContent = 'Erreur de chargement FFmpeg: ' + error.message;
  }
}

async function convertHLSToMP4() {
  const videoUrl = document.getElementById('videoUrl').value;
  const statusDiv = document.getElementById('status');
  const convertButton = document.getElementById('caca');

  if (!videoUrl) {
    alert('Veuillez entrer une URL de flux HLS valide');
    return;
  }

  if (!ffmpeg) {
    statusDiv.textContent = 'FFmpeg n\'est pas encore chargé, veuillez recharger la page';
    return;
  }

  try {
    convertButton.disabled = true;
    statusDiv.textContent = 'Téléchargement du flux HLS...';
    
    // Télécharger et parser le fichier m3u8 principal
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`Erreur lors du téléchargement de la playlist: ${response.status}`);
    }
    
    const masterContent = await response.text();
    
    // Extraire l'URL de base pour les playlists
    const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf('/') + 1);
    
    // Parser le contenu du master m3u8
    const lines = masterContent.split('\n');
    let variantUrl = '';
    
    // Vérifier si c'est un master playlist ou une playlist de média
    const isMasterPlaylist = lines.some(line => line.includes('#EXT-X-STREAM-INF'));
    
    let mediaPlaylistContent;
    let mediaBaseUrl;
    
    if (isMasterPlaylist) {
      // Trouver la meilleure qualité (plus haut bitrate)
      let maxBitrate = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('#EXT-X-STREAM-INF')) {
          const bitrateMatch = line.match(/BANDWIDTH=(\d+)/);
          if (bitrateMatch) {
            const bitrate = parseInt(bitrateMatch[1]);
            if (bitrate > maxBitrate) {
              maxBitrate = bitrate;
              // La ligne suivante contient l'URL
              const nextLine = lines[i + 1];
              if (nextLine && !nextLine.startsWith('#')) {
                variantUrl = nextLine.trim();
              }
            }
          }
        }
      }
      
      if (!variantUrl) {
        throw new Error('Aucune variante de flux valide trouvée');
      }
      
      // Construire l'URL complète de la variante
      const fullVariantUrl = variantUrl.startsWith('http') ? variantUrl : baseUrl + variantUrl;
      mediaBaseUrl = fullVariantUrl.substring(0, fullVariantUrl.lastIndexOf('/') + 1);
      
      // Télécharger la playlist de la variante
      const variantResponse = await fetch(fullVariantUrl);
      if (!variantResponse.ok) {
        throw new Error(`Erreur lors du téléchargement de la variante: ${variantResponse.status}`);
      }
      mediaPlaylistContent = await variantResponse.text();
    } else {
      // C'est déjà une playlist de média
      mediaPlaylistContent = masterContent;
      mediaBaseUrl = baseUrl;
    }
    
    // Parser la playlist média pour trouver les segments
    const mediaLines = mediaPlaylistContent.split('\n');
    const segments = [];
    let duration = 0;
    let isSegment = false;
    
    for (let line of mediaLines) {
      line = line.trim();
      if (line.startsWith('#EXTINF:')) {
        duration = parseFloat(line.split(':')[1]);
        isSegment = true;
      } else if (line.length > 0 && !line.startsWith('#')) {
        if (isSegment) {
          segments.push({
            url: line.startsWith('http') ? line : mediaBaseUrl + line,
            duration
          });
          isSegment = false;
        }
      }
    }
    
    if (segments.length === 0) {
      throw new Error('Aucun segment trouvé dans la playlist');
    }
    
    // Créer une nouvelle playlist locale
    let localPlaylist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + 
      Math.ceil(Math.max(...segments.map(s => s.duration))) + '\n';
    
    // Télécharger tous les segments
    statusDiv.textContent = 'Téléchargement des segments...';
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const segmentResponse = await fetch(segment.url);
      if (!segmentResponse.ok) {
        throw new Error(`Erreur lors du téléchargement du segment ${i + 1}: ${segmentResponse.status}`);
      }
      const segmentData = await segmentResponse.arrayBuffer();
      const segmentFileName = `segment_${i}.ts`;
      
      // Ajouter le segment à la playlist locale
      localPlaylist += `#EXTINF:${segment.duration},\n${segmentFileName}\n`;
      
      // Écrire le segment dans le système de fichiers FFmpeg
      await ffmpeg.writeFile(segmentFileName, new Uint8Array(segmentData));
      
      statusDiv.textContent = `Téléchargement des segments... ${Math.round((i + 1) / segments.length * 100)}%`;
    }
    
    // Ajouter la marque de fin de playlist
    localPlaylist += '#EXT-X-ENDLIST\n';
    
    // Écrire la playlist locale
    await ffmpeg.writeFile('input.m3u8', localPlaylist);
    
    statusDiv.textContent = 'Conversion en cours...';
    
    // Convertir le flux HLS en MP4
    await ffmpeg.exec([
      '-i', 'input.m3u8',
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      'output.mp4'
    ]);

    // Lire le fichier converti
    const data = await ffmpeg.readFile('output.mp4');
    
    // Créer le lien de téléchargement
    const blob = new Blob([data], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'video_convertie.mp4';
    a.click();
    
    statusDiv.textContent = 'Conversion terminée ! Téléchargement en cours...';
    
    // Nettoyer
    URL.revokeObjectURL(url);
    await ffmpeg.deleteFile('input.m3u8');
    await ffmpeg.deleteFile('output.mp4');
    for (let i = 0; i < segments.length; i++) {
      await ffmpeg.deleteFile(`segment_${i}.ts`);
    }
  } catch (error) {
    console.error('Erreur:', error);
    statusDiv.textContent = 'Erreur pendant la conversion: ' + error.message;
  } finally {
    convertButton.disabled = false;
  }
}

// Initialisation
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM chargé, initialisation...');
  document.getElementById('caca').disabled = true;
  document.getElementById('caca').addEventListener('click', convertHLSToMP4);
  loadFFmpeg();
});
