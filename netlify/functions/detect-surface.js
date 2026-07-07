// netlify/functions/detect-surface.js
const GEMINI_MODEL = 'gemini-3.1-flash-lite'; 
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function parseDataUrl(dataUrl){
  const match = /^data:(.+);base64,(.+)$/.exec(dataUrl || '');
  if(!match) throw new Error('Format de data URL invalide.');
  return { mimeType: match[1], base64: match[2] };
}

function extractBoxesFromText(text){
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  let parsed;
  try{ parsed = JSON.parse(cleaned); } catch(e){ throw new Error('Réponse du modèle non-JSON : ' + cleaned.slice(0,200)); }
  const rawBoxes = Array.isArray(parsed) ? parsed : parsed.boxes;
  if(!Array.isArray(rawBoxes)) throw new Error('Le JSON ne contient pas de tableau "boxes".');
  
  return rawBoxes
    .map(b => {
      let x = Number(b.x);
      let y = Number(b.y);
      let w = Number(b.w);
      let h = Number(b.h);

      // SÉCURITÉ : Si Gemini renvoie des entiers entre 0 et 1000 (sa spécialité absolue),
      // on les divise par 1000 pour redonner des pourcentages propres au frontend (0 à 1)
      if (x > 1 || y > 1 || w > 1 || h > 1) {
        x = x / 1000;
        y = y / 1000;
        w = w / 1000;
        h = h / 1000;
      }
      return { x, y, w, h };
    })
    .filter(b =>
      [b.x, b.y, b.w, b.h].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      b.w > 0.01 && b.h > 0.01
    );
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if(event.httpMethod === 'OPTIONS'){
    return { statusCode: 204, headers: cors, body: '' };
  }
  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Méthode non autorisée.' }) };
  }

  try{
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if(!GEMINI_API_KEY){
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'GEMINI_API_KEY non configurée.' }) };
    }

    const { photo } = JSON.parse(event.body || '{}');
    if(!photo){
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Champ "photo" requis.' }) };
    }
    const clientPhoto = parseDataUrl(photo);

    // PROMPT BOOSTÉ EN PRÉCISION ET SANS FLOATS
    const prompt = [
      "Tu es un système de vision par ordinateur de haute précision spécialisé dans le détourage de meubles.",
      "",
      "TÂCHE : Identifie CHAQUE façade de meuble individuelle visible (chaque porte de placard individuelle, chaque tiroir séparé).",
      "ATTENTION : Chaque porte ou tiroir doit avoir sa propre boîte (box) bien distincte. Ne fais JAMAIS un seul grand rectangle englobant pour toute la cuisine. Sois extrêmement minutieux : aligne les bords de CHAQUE rectangle exactement, au pixel près, sur les joints réels et les lignes de séparation visibles entre les portes. Un rectangle qui s'arrête avant le joint réel (laissant un espace vide) est une ERREUR autant qu'un rectangle qui déborde sur le joint suivant.",
      "",
      "PIÈGE FRÉQUENT À ÉVITER : les colonnes ou façades étroites (bandeaux, colonnes de finition, meubles filler) situées juste à côté d'un appareil électroménager (four, micro-ondes, réfrigérateur) sont RÉELLEMENT des façades de meuble et DOIVENT être détectées avec leur propre boîte, même si elles sont fines et collées à un appareil exclu. N'exclus JAMAIS un meuble uniquement parce qu'il touche un électroménager.",
      "",
      "IMPORTANT : couvre l'INTÉGRALITÉ du meuble visible, y compris les colonnes, portes et tiroirs situés tout à gauche et tout à droite de l'image, même partiellement coupés par le cadre de la photo. N'ignore jamais un élément sous prétexte qu'il touche le bord de l'image.",
      "",
      "EXCLUSIONS STRICTES ET IMPÉRATIVES :",
      "- EXCLUS le plan de travail, la crédence, l'évier, le robinet, les murs, le sol.",
      "- EXCLUS la grande niche ouverte centrale en bois.",
      "- EXCLUS intégralement tous les appareils électroménagers visibles sur l'image, quelle que soit leur position (four, micro-ondes, plaque de cuisson, hotte, réfrigérateur, lave-vaisselle, etc.) : ils ne doivent JAMAIS être détectés.",
      "",
      "SYSTÈME DE COORDONNÉES (Échelle 0 à 1000) :",
      "Imagine que l'image fait exactement 1000 unités de large et 1000 unités de haut.",
      "- x : position horizontale du coin haut-gauche (0 = bord gauche, 1000 = bord droit)",
      "- y : position verticale du coin haut-gauche (0 = bord haut, 1000 = bord bas)",
      "- w : largeur du rectangle (entre 0 et 1000)",
      "- h : hauteur du rectangle (entre 0 et 1000)",
      "Toutes les valeurs x, y, w, h doivent obligatoirement être des NOMBRES ENTIERS compris entre 0 et 1000."

    ].join('\n');

    const body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: clientPhoto.mimeType, data: clientPhoto.base64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: "OBJECT",
          properties: {
            boxes: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  x: { type: "INTEGER" },
                  y: { type: "INTEGER" },
                  w: { type: "INTEGER" },
                  h: { type: "INTEGER" }
                },
                required: ["x", "y", "w", "h"]
              }
            }
          },
          required: ["boxes"]
        }
      }
    };

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body)
    });

    if(!geminiRes.ok){
      const errText = await geminiRes.text().catch(()=> '');
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "L'API Gemini a renvoyé une erreur.", details: errText }) };
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n');
    if(!text){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Pas de résultat exploitable." }) };
    }

    let boxes;
    try{
      boxes = extractBoxesFromText(text);
    } catch(parseErr){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Réponse illisible.', details: parseErr.message }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ boxes }) };

  } catch(err){
    console.error('Erreur detect-surface:', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Erreur interne du serveur.' }) };
  }
};