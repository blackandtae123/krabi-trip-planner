const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TYPES = new Set(["set_day_window","set_buffer","add_place","remove_place","swap_places","set_preference"]);
const TARGETS = new Set(["water","temple","boat","island","hiking","active","cultural","cafe","viewpoint","beach","nature","shopping","food","full_day","land","sea","any"]);
const PERIODS = new Set(["morning","afternoon","evening","any"]);
const MODES = new Set(["avoid","prefer","require"]);
const schema = {
  type:"OBJECT",
  properties:{
    status:{type:"STRING",enum:["apply","clarify","no_match"]},
    understanding:{type:"STRING",nullable:true},
    clarificationQuestion:{type:"STRING",nullable:true},
    clarificationContext:{type:"OBJECT",nullable:true,properties:{topic:{type:"STRING",nullable:true},missing:{type:"STRING",nullable:true},options:{type:"ARRAY",items:{type:"STRING"},nullable:true}}},
    commands:{type:"ARRAY",items:{type:"OBJECT",properties:{
      type:{type:"STRING"}, day:{type:"INTEGER",nullable:true}, days:{type:"ARRAY",items:{type:"INTEGER"},nullable:true},
      startTime:{type:"STRING",nullable:true}, endTime:{type:"STRING",nullable:true}, bufferDeltaMinutes:{type:"INTEGER",nullable:true},
      placeId:{type:"STRING",nullable:true}, toPlaceId:{type:"STRING",nullable:true},
      mode:{type:"STRING",nullable:true}, targetType:{type:"STRING",nullable:true}, target:{type:"STRING",nullable:true},
      placeIds:{type:"ARRAY",items:{type:"STRING"},nullable:true}, periods:{type:"ARRAY",items:{type:"STRING"},nullable:true},
      strength:{type:"STRING",nullable:true}
    },required:["type"]}},
    learnedPreferences:{type:"ARRAY",items:{type:"OBJECT",properties:{key:{type:"STRING"},value:{type:"STRING"},confidence:{type:"NUMBER"},scope:{type:"STRING"},day:{type:"INTEGER",nullable:true}},required:["key","value","confidence"]},nullable:true}
  },required:["status","commands"]
};
const clean=(v,n=1000)=>typeof v==="string"?v.trim().slice(0,n):"";
const time=v=>{const s=clean(v,5);return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)?s:null};
const finiteInt=v=>Number.isInteger(v)?v:null;
function send(res,status,body){res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(body));}
function inferTargetFromText(s){
  const t=String(s||'').toLowerCase();
  if(/วัด|temple|mosque|มัสยิด|ศาล/.test(t)) return 'temple';
  if(/เล่นน้ำ|ลงน้ำ|เปียก|ว่ายน้ำ|snorkel|swim|beach/.test(t)) return 'water';
  if(/เรือ|boat|speedboat/.test(t)) return 'boat';
  if(/เกาะ|island/.test(t)) return 'island';
  if(/เดินป่า|ปีน|hiking|trek/.test(t)) return 'hiking';
  return null;
}
function inferredDaysFromPhrase(message, neededDays){
  const text=String(message||'').toLowerCase();
  const days=new Set();
  const re=/(?:วัน|day)\s*(\d{1,2})/g; let m;
  while((m=re.exec(text))){const d=Number(m[1]);if(d>=1&&d<=neededDays)days.add(d);}
  if(/ทั้ง\s*(?:\d+\s*)?วัน|ทุกวัน|ทุกๆวัน|every day|all days/.test(text)) return Array.from({length:neededDays},(_,i)=>i+1);
  const ranges=text.match(/(?:วัน|day)\s*(\d{1,2})\s*(?:ถึง|[-–—]|to)\s*(?:วัน|day)?\s*(\d{1,2})/);
  if(ranges){let a=Number(ranges[1]),b=Number(ranges[2]);if(a>b)[a,b]=[b,a];for(let d=a;d<=b&&d<=neededDays;d++)if(d>=1)days.add(d);}
  return Array.from(days).sort((a,b)=>a-b);
}
function normalizeDays(arr, neededDays){
  if(!Array.isArray(arr)) return [];
  return [...new Set(arr.map(Number).filter(d=>Number.isInteger(d)&&d>=1&&d<=neededDays))].sort((a,b)=>a-b);
}
function buildPrompt({message,lang,neededDays,days,places,learnedPreferences,currentPreferences,conversationHistory,conversationState}){
 return `You are the natural-language understanding layer for a travel itinerary app. Think like a capable conversational AI: infer the user's meaning from context and ordinary Thai/English language, including wording you have never seen before. Do not require exact keywords. However, never invent facts about places or feasibility.

Your job is ONLY to translate the request into composable structured intent/preferences. The app's scheduler will later calculate the itinerary and enforce opening hours, travel time, monsoon, duration, transport, and other hard constraints.

A request may combine MANY dimensions at once: action (avoid/prefer/require), target activity/place category, time periods, one or multiple days, place names, and persistence. Do NOT enumerate possible phrasings. Instead normalize their meaning into structured fields.

Supported preference targets: ${Array.from(TARGETS).join(', ')}.
Supported periods: morning, afternoon, evening, any.
Supported modes: avoid, prefer, require.
Supported preference command:
set_preference({mode,targetType,target,placeIds,periods,days,strength})
- targetType=category for semantic categories; targetType=place when referring to named places.
- days=[] means all days in the trip.
- periods=[] or ["any"] means all periods.
- strength=hard for explicit prohibitions/requirements such as "ไม่เอา/ห้าม/ต้อง", otherwise soft.

Examples of semantic normalization (examples are illustrative, not a closed list):
"ไม่อยากเล่นน้ำช่วงเช้า" => avoid water, periods=[morning]
"บ่ายไม่เอาเปียก" => avoid water, periods=[afternoon]
"อยากเล่นน้ำทั้งเช้าเย็น" => prefer water, periods=[morning,evening]
"ไม่เอาเล่นน้ำทั้งเช้าเย็น" => avoid water, periods=[morning,evening]
"ไม่เล่นน้ำสองวันเลย" => avoid water, days=all trip days
"วันที่ 1 และวันที่ 4 ไม่เอาเล่นน้ำ" => avoid water, days=[1,4], periods=any
"วันที่ 2 อยากไปวัด แต่วันที่ 4 ไม่อยากไปวัดแล้ว" => require/prefer temple on day 2 AND avoid temple on day 4 (two commands)
"ไม่อยากไปวัดแล้ววันที่ 4" => avoid temple, days=[4], periods=any
"วัดถ้ำเสือไม่เอาวันที่ 4" => targetType=place with matching placeId, avoid, days=[4].

Use current itinerary context and the recent conversation to understand references such as "อีกวัน", "วันนั้น", "ที่นี่", "อันนั้น", and answers to your own previous clarification questions. The conversation is cumulative: do not treat the latest user message as isolated. If a critical reference is genuinely ambiguous, set status=clarify and ask ONE concise, specific question in the user's language. Do not guess a day or place when ambiguity changes the meaning.

IMPORTANT CONVERSATION RULE: Never use no_match merely because the user uses an unfamiliar word, slang, typo, indirect wording, or a phrase not listed in the examples. First infer its likely meaning from context. If there is still insufficient evidence, use status=clarify and ask a useful question that helps you learn the missing meaning. After the user answers, use the previous turns to resolve it. Do not discard the request.

Persistence: If the user clearly states a stable preference (e.g. "โดยปกติฉันไม่ชอบ...", "จำไว้ว่าฉัน..." or an unqualified recurring preference), return learnedPreferences with a canonical key/value and confidence >= 0.80. A one-off day-specific instruction should normally remain a trip command, not a permanent preference.

Other supported edits remain: set_day_window(day,startTime,endTime), set_buffer(day,bufferDeltaMinutes), add_place(day,placeId), remove_place(day,placeId), swap_places(day,placeId,toPlaceId).

IMPORTANT — requests naming ONE specific catalog place (e.g. "ไปวัดถ้ำเสือ", "อยากไป [place name]", "เพิ่ม [place name] วันที่ N"): these are add_place requests, not set_preference. Resolve the named place to its exact catalog id by matching name/tags (never invent an id). add_place ALWAYS requires a specific day — if the user gave one, use it; if they did not, do NOT guess a day and do NOT emit a set_preference instead — set status=clarify and ask specifically which day they want that place on. A mentioned time period (เช้า/บ่าย/เย็น) for a named place is informational only; add_place has no period field, so drop the period once the day is resolved — do not try to force it into set_preference.
set_preference is for category-level or recurring rules (avoid/prefer/require across periods/days), not for a one-off "add this specific place" request.

Worked examples (follow this exact JSON shape for analogous requests — do not copy the sample values, resolve placeId/day from the actual user request and catalog):

Request: "ไปวัดถ้ำเสือในช่วงเช้าของวันที่ 1" (a named place + a specific day given)
Correct response shape:
{"status":"apply","commands":[{"type":"add_place","day":1,"placeId":"<resolved catalog id for the named place>"}],"clarificationQuestion":null,"understanding":"เพิ่มวัดถ้ำเสือในวันที่ 1"}

Request: "ไปวัดถ้ำเสือในช่วงเช้า" (a named place, NO day given — do not guess, do not use set_preference)
Correct response shape:
{"status":"clarify","commands":[],"clarificationQuestion":"อยากให้จัดวัดถ้ำเสือไว้วันไหนคะ","clarificationContext":{"topic":"add_place","missing":"day","options":[]}}

Request: "บ่ายไม่เอาเปียก" (a category-level recurring rule, no specific place named — this is the set_preference case)
Correct response shape:
{"status":"apply","commands":[{"type":"set_preference","mode":"avoid","targetType":"category","target":"water","placeIds":[],"periods":["afternoon"],"days":[],"strength":"hard"}],"clarificationQuestion":null,"understanding":"หลีกเลี่ยงกิจกรรมทางน้ำช่วงบ่ายทุกวัน"}

Never emit a set_preference command with an empty target or a null mode — if either would be empty, that request did not actually match set_preference; re-classify it as add_place (if a specific place + day were given) or as clarify (if information is missing).

Return status=apply when there is a sufficiently clear actionable interpretation; clarify whenever the request is related to the trip but you need more information. Use no_match only for clearly unrelated messages (for example, a weather joke or a greeting that contains no itinerary request), and even then prefer a clarification question if the message could reasonably be an itinerary request.

Language: ${lang}. Trip has ${neededDays} day(s).
Current days: ${JSON.stringify(days)}
Catalog: ${JSON.stringify(places)}
Currently learned preferences: ${JSON.stringify(learnedPreferences||{})}
Current trip preference constraints: ${JSON.stringify(currentPreferences||[])}
Recent conversation (most recent last): ${JSON.stringify(conversationHistory||[])}
Pending conversation state (if any): ${JSON.stringify(conversationState||{})}
If pending=true, the latest user message may be a SHORT ANSWER to the assistant question. Treat it as an answer first, not as a standalone itinerary command.
User request: ${JSON.stringify(message)}`;
}
export default async function handler(req,res){
 if(req.method!=="POST")return send(res,405,{error:"Method not allowed"});
 if(!GEMINI_API_KEY)return send(res,503,{error:"GEMINI_API_KEY is not configured"});
 try{
  const b=req.body||{};
  const message=clean(b.message,2000), lang=b.lang==="en"?"en":"th";
  const neededDays=Number.isInteger(b.neededDays)?Math.max(1,Math.min(14,b.neededDays)):1;
  if(!message)return send(res,200,{status:"no_match",commands:[]});
  const places=Array.isArray(b.places)?b.places.slice(0,60).map(p=>({id:clean(p?.id,100),name:clean(p?.name,200),axis:clean(p?.axis,30),tags:Array.isArray(p?.tags)?p.tags.slice(0,15):[],boatRequired:!!p?.boatRequired,fullDayActivity:!!p?.fullDayActivity,visitWindow:p?.visitWindow||null})):[];
  const days=Array.isArray(b.days)?b.days.slice(0,14):[];
  const conversationHistory=Array.isArray(b.conversationHistory)?b.conversationHistory.slice(-12).map(x=>({role:x?.role==='assistant'?'assistant':'user',text:clean(x?.text,1200)})):[];
  const conversationState=(b.conversationState&&typeof b.conversationState==='object')?{pending:!!b.conversationState.pending,question:clean(b.conversationState.question,700),topic:clean(b.conversationState.topic,300),lastInterpretation:clean(b.conversationState.lastInterpretation,300)}:{};
  const prompt=buildPrompt({message,lang,neededDays,days,places,learnedPreferences:b.learnedPreferences,currentPreferences:b.currentPreferences,conversationHistory,conversationState});
  async function callGemini(contents){
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,{method:"POST",headers:{"x-goog-api-key":GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:"Return only JSON matching the supplied schema. Use semantic reasoning, not keyword matching. Never fabricate place IDs or facts."}]},contents,generationConfig:{temperature:0,responseMimeType:"application/json",responseSchema:schema}})});
    const raw=await r.text();
    if(!r.ok) return {error:"Gemini API request failed"};
    let outer; try{outer=JSON.parse(raw)}catch{return {error:"Invalid Gemini response"}}
    const rawText=outer?.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("")||"";
    let result; try{result=JSON.parse(rawText)}catch{return {error:"Invalid structured response"}}
    return {result,rawText};
  }
  function cleanOneCommand(c,ids,neededDays){
    const type=TYPES.has(c?.type)?c.type:""; if(!type) return null;
    const out={type,day:finiteInt(c?.day)};
    if(type==='set_day_window'){out.startTime=time(c.startTime);out.endTime=time(c.endTime);}
    else if(type==='set_buffer'){out.bufferDeltaMinutes=Number.isInteger(c.bufferDeltaMinutes)?Math.max(-60,Math.min(120,c.bufferDeltaMinutes)):null;}
    else if(["add_place","remove_place","swap_places"].includes(type)){
      out.placeId=ids.has(c?.placeId)?c.placeId:null;
      if(type==='swap_places')out.toPlaceId=ids.has(c?.toPlaceId)?c.toPlaceId:null;
    } else if(type==='set_preference'){
      out.mode=MODES.has(c?.mode)?c.mode:null;
      out.targetType=c?.targetType==='place'?'place':'category';
      out.target=TARGETS.has(String(c?.target||'').toLowerCase())?String(c.target).toLowerCase():inferTargetFromText(c?.target)||null;
      out.placeIds=Array.isArray(c?.placeIds)?c.placeIds.filter(id=>ids.has(id)).slice(0,30):[];
      out.periods=Array.isArray(c?.periods)?[...new Set(c.periods.map(String).map(x=>x.toLowerCase()).filter(x=>PERIODS.has(x)))]:['any'];
      out.days=normalizeDays(c?.days,neededDays);
      out.strength=c?.strength==='hard'?'hard':'soft';
      if(out.targetType==='place'&&!out.placeIds.length) out.target=null;
    }
    return out;
  }
  // A command is "malformed" when its essential fields are empty — this is exactly the
  // shape that used to reach the frontend as a silent "preference not specific enough"
  // error. Catching it here and giving the model one self-correction pass (with its own
  // prior answer in context) fixes most of these before they ever reach the user.
  function isMalformedCommand(out){
    if(out.type==='set_preference') return !out.mode || (!out.target && !(out.placeIds&&out.placeIds.length));
    if(out.type==='add_place'||out.type==='remove_place') return !Number.isInteger(out.day) || !out.placeId;
    if(out.type==='swap_places') return !Number.isInteger(out.day) || !out.placeId || !out.toPlaceId;
    if(out.type==='set_day_window') return !out.startTime && !out.endTime;
    if(out.type==='set_buffer') return !Number.isInteger(out.bufferDeltaMinutes);
    return false;
  }

  const ids=new Set(places.map(p=>p.id));
  const firstAttempt=await callGemini([{role:"user",parts:[{text:prompt}]}]);
  if(firstAttempt.error) return send(res,502,{error:firstAttempt.error});
  let result=firstAttempt.result;
  let cleanCommands=(Array.isArray(result.commands)?result.commands:[]).slice(0,20).map(c=>cleanOneCommand(c,ids,neededDays)).filter(Boolean);
  const firstAttemptHadRawCommands=Array.isArray(result.commands)&&result.commands.length>0;
  const needsRetry=(firstAttemptHadRawCommands&&cleanCommands.length===0)||cleanCommands.some(isMalformedCommand);
  if(needsRetry){
    const correction=lang==='th'
      ? "คำตอบก่อนหน้าของคุณมีคำสั่งที่ไม่สมบูรณ์ (เช่น set_preference ที่ mode หรือ target ว่างเปล่า หรือ add_place ที่ไม่มี day/placeId ที่ถูกต้อง) กรุณาพิจารณาคำขอเดิมอีกครั้งและตอบเป็น JSON ที่ถูกต้องครบถ้วนตาม schema เท่านั้น ถ้าคำขอระบุชื่อสถานที่และวันที่ชัดเจน ให้ใช้ add_place ถ้าขาดข้อมูลวันที่ ให้ตอบ status=clarify แทนการเดา"
      : "Your previous response contained an incomplete command (e.g. a set_preference with an empty mode or target, or an add_place missing a valid day/placeId). Reconsider the original request and respond with complete, valid JSON matching the schema. If a specific place and day were named, use add_place; if the day is missing, respond with status=clarify instead of guessing.";
    const retryAttempt=await callGemini([
      {role:"user",parts:[{text:prompt}]},
      {role:"model",parts:[{text:firstAttempt.rawText}]},
      {role:"user",parts:[{text:correction}]}
    ]);
    if(!retryAttempt.error){
      result=retryAttempt.result;
      cleanCommands=(Array.isArray(result.commands)?result.commands:[]).slice(0,20).map(c=>cleanOneCommand(c,ids,neededDays)).filter(Boolean);
    }
    // If the retry itself errors, we fall through and use the first attempt's
    // (possibly still-malformed) result rather than failing the whole request —
    // the existing water/afternoon fallback and clarify path below still apply.
  }
  // Backward-compatible fallback for the very common water-afternoon phrase if the model omitted a command.
  if(!cleanCommands.length){
    const target=inferTargetFromText(message), low=message.toLowerCase();
    if(target==='water' && /บ่าย|afternoon/.test(low) && /ไม่|ไม่อยาก|ไม่เอา|avoid|don't|do not/.test(low)){
      cleanCommands.push({type:'set_preference',mode:'avoid',targetType:'category',target:'water',placeIds:[],periods:['afternoon'],days:inferredDaysFromPhrase(message,neededDays),strength:'hard'});
    }
  }
  let clarificationQuestion=clean(result.clarificationQuestion,700);
  const clarificationContext=result.clarificationContext&&typeof result.clarificationContext==='object'?{topic:clean(result.clarificationContext.topic,200),missing:clean(result.clarificationContext.missing,200),options:Array.isArray(result.clarificationContext.options)?result.clarificationContext.options.slice(0,6).map(x=>clean(x,120)).filter(Boolean):[]}:null;
  let status;
  if(cleanCommands.length){
    status='apply';
  }else if(result.status==='clarify' || clarificationQuestion || result.status==='no_match'){
    // no_match is intentionally converted into a conversational clarification state.
    // This prevents the UI from saying "unsupported" and ending the learning loop.
    status='clarify';
    if(!clarificationQuestion){
      clarificationQuestion=lang==='th'
        ? 'ฉันยังไม่แน่ใจว่าคุณหมายถึงอะไร ขอรายละเอียดเพิ่มนิดหนึ่งได้ไหม — คุณต้องการปรับสถานที่ กิจกรรม ช่วงเวลา หรือวันที่ไหน? ถ้ามีคำเฉพาะที่ใช้เรียกสิ่งนั้น บอกความหมายหรือยกตัวอย่างให้ฉันได้เลย'
        : 'I am not fully sure what you mean yet. Could you clarify the place, activity, time period, or day? If you used a special term, briefly explain what it means or give an example.';
    }
  }else{
    status='clarify';
    clarificationQuestion=lang==='th'?'ขอรายละเอียดเพิ่มอีกนิด เพื่อให้ฉันตีความและปรับโปรแกรมได้ถูกต้อง':'I need one more detail so I can interpret and adjust the itinerary correctly.';
  }
  return send(res,200,{status,understanding:clean(result.understanding,500),clarificationQuestion,clarificationContext,commands:cleanCommands,learnedPreferences:Array.isArray(result.learnedPreferences)?result.learnedPreferences.slice(0,12):[]});
 }catch(e){console.error("adjust-itinerary error",e);return send(res,500,{error:"Internal server error"});}
}
