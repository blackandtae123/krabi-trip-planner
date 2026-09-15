const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ALLOWED_NEEDS = new Set([
  "youngChildren", "elderly", "mobility", "avoidStrenuous", "pregnancy",
  "vegetarian", "veganJain", "halal", "seafoodAllergy", "nutAllergy",
  "dairyAllergy", "eggAllergy", "noSpicy"
]);

const responseSchema = {
  type: "OBJECT",
  properties: {
    groupSize: { type: "INTEGER", nullable: true },
    hasChildren: { type: "BOOLEAN" },
    hasElderly: { type: "BOOLEAN" },
    dietary: { type: "ARRAY", items: { type: "STRING" } },
    allergies: { type: "ARRAY", items: { type: "STRING" } },
    mobilityConcern: { type: "BOOLEAN" },
    avoidStrenuous: { type: "BOOLEAN" },
    placeNotes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, note: { type: "STRING" } },
        required: ["id", "note"]
      }
    },
    restaurantAdvice: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, note: { type: "STRING" } },
        required: ["id", "note"]
      }
    },
    timingPreference: {
      type: "OBJECT",
      nullable: true,
      properties: {
        preferredStartTime: { type: "STRING", nullable: true },
        mustReturnBy: { type: "STRING", nullable: true },
        extraBufferMinutes: { type: "INTEGER", nullable: true }
      }
    }
  },
  required: ["hasChildren", "hasElderly", "dietary", "allergies", "mobilityConcern", "avoidStrenuous", "placeNotes", "restaurantAdvice"]
};

function cleanString(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// รับเฉพาะเวลารูปแบบ "HH:MM" ที่ถูกต้องจริงเท่านั้น (00:00-23:59) กัน Gemini ส่งค่าแปลกๆ ที่จะไปพัง
// การเปรียบเทียบ string เวลาแบบ lexicographic ที่โค้ดฝั่ง frontend (generateItinerary) ใช้อยู่
function cleanTimeString(value) {
  const s = cleanString(value, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

// รับ array ของ {id, note} จาก Gemini (แทน object แบบ additionalProperties ที่ Gemini ไม่รองรับ)
// แล้วแปลงกลับเป็น map { placeId: note } เหมือนเดิมสำหรับฝั่ง frontend
function normalizeObject(arr, allowedIds) {
  if (!Array.isArray(arr)) return {};
  const out = {};
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const id = cleanString(entry.id, 100);
    if (!id || !allowedIds.has(id)) continue;
    const s = cleanString(entry.note, 600);
    if (s) out[id] = s;
  }
  return out;
}

function fallbackFromNeeds(specialNeeds) {
  const needs = new Set(specialNeeds);
  return {
    groupSize: null,
    hasChildren: needs.has("youngChildren"),
    hasElderly: needs.has("elderly"),
    dietary: [
      needs.has("vegetarian") ? "vegetarian" : null,
      needs.has("veganJain") ? "vegan/Jain" : null,
      needs.has("halal") ? "halal" : null
    ].filter(Boolean),
    allergies: [
      needs.has("seafoodAllergy") ? "seafood" : null,
      needs.has("nutAllergy") ? "nut" : null,
      needs.has("dairyAllergy") ? "dairy/lactose" : null,
      needs.has("eggAllergy") ? "egg" : null
    ].filter(Boolean),
    mobilityConcern: needs.has("mobility"),
    avoidStrenuous: needs.has("avoidStrenuous"),
    placeNotes: {},
    restaurantAdvice: {},
    timingPreference: null
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!GEMINI_API_KEY) return send(res, 503, { error: "GEMINI_API_KEY is not configured" });

  try {
    const body = req.body || {};
    const notes = cleanString(body.notes, 2000);
    const lang = body.lang === "en" ? "en" : "th";
    const specialNeeds = Array.isArray(body.specialNeeds)
      ? body.specialNeeds.filter(v => typeof v === "string" && ALLOWED_NEEDS.has(v)).slice(0, 6)
      : [];
    const places = Array.isArray(body.places) ? body.places.slice(0, 40) : [];
    const placeIds = new Set(places.map(p => p && p.id).filter(Boolean));

    // If there is nothing for AI to interpret, return deterministic structured data.
    if (!notes && specialNeeds.length === 0) return send(res, 200, fallbackFromNeeds([]));

    const placeCatalog = places.map(p => ({
      id: cleanString(p?.id, 100),
      name: cleanString(p?.name, 200),
      categories: Array.isArray(p?.categories) ? p.categories.slice(0, 8) : [],
      feature: cleanString(p?.feature, 500),
      restaurants: Array.isArray(p?.restaurants) ? p.restaurants.slice(0, 8).map(r => ({
        name: cleanString(r?.name, 160),
        cuisine: cleanString(r?.cuisine, 180)
      })) : []
    }));

    const languageInstruction = lang === "th"
      ? "ตอบคำอธิบาย placeNotes และ restaurantAdvice เป็นภาษาไทย"
      : "Write placeNotes and restaurantAdvice in English";

    const prompt = `You are the constraint-analysis component of a Krabi travel itinerary planner.
Your job is ONLY to interpret the traveler's human-language constraints and turn them into structured data and concise advisory notes.
Do NOT invent opening hours, prices, transport schedules, restaurant allergen guarantees, or facts not present in the supplied catalog.
Do NOT decide the itinerary or override hard scheduling rules.
${languageInstruction}.

Structured specialNeeds selected by the user:
${JSON.stringify(specialNeeds)}

Additional free-text notes:
${JSON.stringify(notes)}

Place/restaurant catalog (use IDs exactly as supplied):
${JSON.stringify(placeCatalog)}

Rules:
- Treat structured specialNeeds as authoritative.
- Free text can add context such as group size, but do not turn a negation such as "not allergic" into an allergy.
- If an allergy is selected, restaurantAdvice should emphasize confirmation with staff; never claim a restaurant is allergen-safe unless the catalog explicitly says so.
- placeNotes should only be included when a selected constraint creates a meaningful suitability concern for that place. Return it as an array of {id, note} objects, where id is the place's id from the catalog above.
- restaurantAdvice should only mention restaurants actually present in the supplied catalog. Return it as an array of {id, note} objects, where id is the place's id whose restaurants the note concerns.
- Keep each note concise (normally one or two sentences).
- groupSize should be null unless a clear group size is stated in the notes.
- dietary may contain vegetarian, vegan/Jain, or halal.
- allergies may contain seafood, nut, dairy/lactose, or egg.
- timingPreference is ONLY about how the traveler wants their day paced — it does NOT decide real opening/closing hours or travel times, those come from the app's own schedule engine, not from you.
  - preferredStartTime: fill in "HH:MM" (24h) ONLY if the traveler explicitly asked to start later/earlier than a typical day (e.g. "wake up late", "no rush in the morning" → around "10:00"; "start early" → around "07:30"). Leave null if not mentioned.
  - mustReturnBy: fill in "HH:MM" (24h) ONLY if the traveler explicitly stated a hard time they must finish or be back by (e.g. "need to catch a flight at 4pm" → "14:00" to leave buffer). Leave null if not mentioned.
  - extraBufferMinutes: a small integer (0-60) ONLY if the traveler asked for a relaxed/unhurried pace with more rest between activities. Leave null otherwise.
  - Never invent a time preference the traveler did not express. If nothing about pacing was said, return timingPreference as null entirely.
`;

    const apiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "Return only the requested structured JSON. You are an advisory constraint parser, not the itinerary scheduler." }]
          },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema
          }
        })
      }
    );

    const raw = await apiResponse.text();
    if (!apiResponse.ok) {
      console.error("Gemini API error", apiResponse.status, raw.slice(0, 1000));
      return send(res, 502, { error: "Gemini API request failed" });
    }

    let payload;
    try { payload = JSON.parse(raw); } catch { return send(res, 502, { error: "Invalid Gemini response" }); }
    const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!text) return send(res, 502, { error: "Gemini returned no structured content" });

    let result;
    try { result = JSON.parse(text); } catch { return send(res, 502, { error: "Gemini returned invalid JSON" }); }

    const fallback = fallbackFromNeeds(specialNeeds);
    const safe = {
      groupSize: Number.isInteger(result.groupSize) && result.groupSize > 0 && result.groupSize <= 100 ? result.groupSize : fallback.groupSize,
      hasChildren: !!result.hasChildren || fallback.hasChildren,
      hasElderly: !!result.hasElderly || fallback.hasElderly,
      dietary: Array.isArray(result.dietary) ? result.dietary.filter(v => typeof v === "string").slice(0, 8) : fallback.dietary,
      allergies: Array.isArray(result.allergies) ? result.allergies.filter(v => typeof v === "string").slice(0, 8) : fallback.allergies,
      mobilityConcern: !!result.mobilityConcern || fallback.mobilityConcern,
      avoidStrenuous: !!result.avoidStrenuous || fallback.avoidStrenuous,
      placeNotes: normalizeObject(result.placeNotes, placeIds),
      restaurantAdvice: normalizeObject(result.restaurantAdvice, placeIds),
      timingPreference: (() => {
        const tp = result.timingPreference;
        if (!tp || typeof tp !== "object") return null;
        const preferredStartTime = cleanTimeString(tp.preferredStartTime);
        const mustReturnBy = cleanTimeString(tp.mustReturnBy);
        const rawBuffer = Number.isInteger(tp.extraBufferMinutes) ? tp.extraBufferMinutes : null;
        const extraBufferMinutes = rawBuffer === null ? null : Math.min(60, Math.max(0, rawBuffer));
        if (!preferredStartTime && !mustReturnBy && !extraBufferMinutes) return null;
        return { preferredStartTime, mustReturnBy, extraBufferMinutes };
      })()
    };

    return send(res, 200, safe);
  } catch (error) {
    console.error("analyze-constraints error", error);
    return send(res, 500, { error: "Internal server error" });
  }
}
