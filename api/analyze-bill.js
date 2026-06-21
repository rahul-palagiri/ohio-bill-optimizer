// /api/analyze-bill.js
//
// This is a Vercel Serverless Function. It runs on Vercel's server, NOT in
// the customer's browser — so the API key inside it is never visible to anyone.
//
// The frontend (index.html) sends the bill image here.
// This function adds the secret key and forwards the request to Gemini.
// The customer's browser never sees the key — only this server does.

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // The key lives here — set in Vercel's dashboard, never in your code
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "Server is missing GEMINI_API_KEY. Add it in Vercel → Settings → Environment Variables.",
    });
  }

  try {
    const { base64, mime, prompt } = req.body;

    if (!base64 || !mime || !prompt) {
      return res.status(400).json({ error: "Missing base64, mime, or prompt in request body." });
    }

    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: mime, data: base64 } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );

    const data = await geminiResp.json();

    if (!geminiResp.ok) {
      console.error("Gemini API error:", data);
      return res.status(geminiResp.status).json({
        error: data.error?.message || `Gemini API error ${geminiResp.status}`,
      });
    }

    // Pass Gemini's response straight back to the frontend
    return res.status(200).json(data);

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: err.message || "Unknown server error" });
  }
}
