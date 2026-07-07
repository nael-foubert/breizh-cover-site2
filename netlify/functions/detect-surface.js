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

    // PROMPT RESSERRÉ : même exigence de précision, moins de redondance (= moins de tokens de réflexion consommés)
    const prompt = [
      "Tu es un système de vision par ordinateur de haute précision spécialisé dans le détourage de meubles.",
      "",
      "AVANT de sortir la moindre boîte : balaie mentalement l'image de GAUCHE À DROITE, colonne par colonne, jusqu'au bord droit inclus, et compte les portes/tiroirs de chaque colonne. Une colonne étroite (bandeau, colonne de finition) collée à un mur ou à un électroménager compte quand même comme une colonne à part entière — ne l'ignore jamais. Fais ce balayage en silence, puis produis la liste finale sans en sauter aucune.",
      "",
      "DÉTOURAGE : une boîte distincte par porte/tiroir individuel, jamais un rectangle englobant. Aligne chaque bord au pixel près sur le joint réel — s'arrêter avant le joint ou déborder dessus sont deux erreurs équivalentes.",
      "",
      "PIÈGES : (1) une façade fine collée à un four/micro-ondes/frigo reste un meuble à détecter ; (2) le dernier quart droit de l'image est la zone la plus souvent oubliée — vérifie explicitement qu'un meuble visible jusqu'à x=1000 a bien sa boîte ; (3) couvre aussi les éléments partiellement coupés par le cadre, à gauche comme à droite.",
      "",
      "EXCLUSIONS STRICTES : plan de travail, crédence, évier, robinet, murs, sol, la grande niche ouverte centrale en bois, et TOUS les électroménagers (four, micro-ondes, plaque, hotte, frigo, lave-vaisselle...).",
      "",
      "SYSTÈME DE COORDONNÉES (Échelle 0 à 1000, entiers uniquement) :",
      "Image = 1000×1000 unités. x/y = coin haut-gauche (0=bord gauche/haut, 1000=bord droit/bas). w/h = largeur/hauteur du rectangle."
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
        thinkingConfig: {
          thinkingLevel: 'HIGH' // prompt allégé = plus de marge de temps/tokens pour repasser en HIGH sans taper le timeout Netlify
        },
        maxOutputTokens: 24576,
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
    const finishReason = data?.candidates?.[0]?.finishReason;
    if(finishReason === 'MAX_TOKENS'){
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "La réponse a été coupée avant la fin (budget de tokens dépassé). Augmente maxOutputTokens." }) };
    }
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