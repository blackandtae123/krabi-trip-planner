// /api/analyze-constraints.js
// Vercel Serverless Function — เรียก Claude API จริง โดยเก็บ ANTHROPIC_API_KEY
// ไว้ฝั่งเซิร์ฟเวอร์เท่านั้น (ตั้งค่าใน Vercel Project Settings > Environment Variables)
//
// รับ: { notes: string, lang: "th"|"en", places: [{id, name, categories, feature, restaurants:[{name,cuisine}]}] }
// คืน (JSON):
// {
//   groupSize: number|null,
//   hasChildren: boolean,
//   hasElderly: boolean,
//   dietary: string[],           // เช่น ["vegetarian"]
//   allergies: string[],         // เช่น ["seafood"]
//   mobilityConcern: boolean,
//   placeNotes: { [placeId]: "คำเตือน/ข้อควรพิจารณาสั้นๆ สำหรับสถานที่นี้" },      // เฉพาะสถานที่ที่เกี่ยวข้องเท่านั้น
//   restaurantAdvice: { [placeId]: "คำแนะนำร้านอาหาร/เมนูสำหรับกลุ่มนี้ที่สถานที่นี้" } // เฉพาะสถานที่ที่เกี่ยวข้อง
// }

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Set it in Vercel Project Settings > Environment Variables."
    });
    return;
  }

  const { notes, lang, places } = req.body || {};

  if (!notes || typeof notes !== "string" || !notes.trim()) {
    res.status(400).json({ error: "Missing 'notes' text to analyze." });
    return;
  }
  if (!Array.isArray(places) || places.length === 0) {
    res.status(400).json({ error: "Missing 'places' list." });
    return;
  }

  const outputLang = lang === "en" ? "English" : "Thai (ภาษาไทย)";

  const systemPrompt = `You are a meticulous travel-planning assistant for a Krabi (Thailand) trip planner app.
You will receive free-text notes a traveler wrote about their group's constraints (e.g. dietary needs, children,
elderly members, allergies, group size, mobility concerns), plus a list of candidate destinations in Krabi, each
with a short list of real nearby restaurants (name + cuisine description).

Your job:
1. Extract structured facts from the notes (group size, whether there are children/elderly, dietary restrictions,
   allergies, mobility concerns). Do not invent facts that aren't implied by the notes.
2. For EACH destination, decide if there is something genuinely worth flagging for THIS group (e.g. a destination
   involves 1,237+ stone steps and the group has young children or elderly members; a destination is boat-only
   access and someone has severe seasickness/mobility issues mentioned). Only include a note if it's truly relevant
   — most destinations should have no note at all.
3. For EACH destination, look at its real restaurant list and give brief, honest advice for this group. If a
   restaurant's cuisine description suggests it can accommodate the constraint (e.g. mentions vegetarian/vegan
   options), say so. If NONE of the listed restaurants clearly fit (e.g. no vegetarian mentioned anywhere), do NOT
   invent a matching restaurant — instead give a practical workaround (e.g. "no restaurant here explicitly lists
   vegetarian options — ask staff for a meat-free stir-fried vegetable or egg dish, common at most Thai restaurants"
   translated appropriately). Keep advice to 1-2 short sentences per place, and only include a place in
   restaurantAdvice if the constraints actually require food-related advice (skip it if there's nothing relevant
   to say, e.g. no dietary/allergy constraint was mentioned at all).

Respond with ONLY a single JSON object, no markdown fences, no preamble, no explanation outside the JSON. All
human-readable text values (placeNotes and restaurantAdvice strings) must be written in ${outputLang}.

JSON shape:
{
  "groupSize": number|null,
  "hasChildren": boolean,
  "hasElderly": boolean,
  "dietary": string[],
  "allergies": string[],
  "mobilityConcern": boolean,
  "placeNotes": { "<placeId>": "short warning text" },
  "restaurantAdvice": { "<placeId>": "short restaurant advice text" }
}`;

  const userPrompt = `Traveler's constraint notes (verbatim):
"""
${notes}
"""

Candidate destinations with their real nearby restaurants:
${JSON.stringify(places, null, 2)}

Return the JSON object described in the system prompt now.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      res.status(502).json({ error: "Claude API request failed", detail: errText });
      return;
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === "text");
    const rawText = textBlock ? textBlock.text : "";

    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Failed to parse Claude JSON response:", rawText);
      res.status(502).json({ error: "Could not parse AI response as JSON" });
      return;
    }

    // ป้องกันฟิลด์หาย ให้มีโครงสร้างครบเสมอ
    const safeResult = {
      groupSize: parsed.groupSize ?? null,
      hasChildren: !!parsed.hasChildren,
      hasElderly: !!parsed.hasElderly,
      dietary: Array.isArray(parsed.dietary) ? parsed.dietary : [],
      allergies: Array.isArray(parsed.allergies) ? parsed.allergies : [],
      mobilityConcern: !!parsed.mobilityConcern,
      placeNotes: typeof parsed.placeNotes === "object" && parsed.placeNotes ? parsed.placeNotes : {},
      restaurantAdvice: typeof parsed.restaurantAdvice === "object" && parsed.restaurantAdvice ? parsed.restaurantAdvice : {}
    };

    res.status(200).json(safeResult);
  } catch (err) {
    console.error("Unexpected error calling Claude API:", err);
    res.status(500).json({ error: "Unexpected server error", detail: String(err) });
  }
}
