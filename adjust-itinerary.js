const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const types = new Set(["set_day_window","set_buffer","add_place","remove_place","swap_places","set_activity_timing"]);
const schema = {type:"OBJECT",properties:{status:{type:"STRING",enum:["apply","understood","clarify"]},understanding:{type:"STRING",nullable:true},clarificationQuestion:{type:"STRING",nullable:true},learnedPreferences:{type:"ARRAY",items:{type:"OBJECT",properties:{key:{type:"STRING"},value:{type:"STRING"},confidence:{type:"NUMBER"},scope:{type:"STRING",nullable:true},day:{type:"INTEGER",nullable:true}},required:["key","value","confidence"]}},commands:{type:"ARRAY",items:{type:"OBJECT",properties:{type:{type:"STRING"},day:{type:"INTEGER",nullable:true},startTime:{type:"STRING",nullable:true},endTime:{type:"STRING",nullable:true},bufferDeltaMinutes:{type:"INTEGER",nullable:true},placeId:{type:"STRING",nullable:true},toPlaceId:{type:"STRING",nullable:true},activityType:{type:"STRING",nullable:true},period:{type:"STRING",nullable:true},mode:{type:"STRING",nullable:true}},required:["type"]}}},required:["status","learnedPreferences","commands"]};
const clean=(v,n=1000)=>typeof v==="string"?v.trim().slice(0,n):"";
const time=v=>{const s=clean(v,5);return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)?s:null;};
function send(res,status,body){res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(body));}
export default async function handler(req,res){
 if(req.method!=="POST")return send(res,405,{error:"Method not allowed"});
 if(!GEMINI_API_KEY)return send(res,503,{error:"GEMINI_API_KEY is not configured"});
 try{
  let b=req.body||{}; if(typeof b==='string'){try{b=JSON.parse(b)}catch{b={}}}
  const message=clean(b.message,2000), lang=b.lang==="en"?"en":"th";
  const neededDays=Number.isInteger(b.neededDays)?Math.max(1,Math.min(14,b.neededDays)):1;
  const places=Array.isArray(b.places)?b.places.slice(0,40).map(p=>({id:clean(p?.id,100),name:clean(p?.name,200),axis:clean(p?.axis,40),boatRequired:!!p?.boatRequired,physicalDemand:clean(p?.physicalDemand,30),fullDayActivity:!!p?.fullDayActivity,visitWindow:p?.visitWindow||null})):[ ];
  const days=Array.isArray(b.days)?b.days.slice(0,14):[];
  const learned= b.learnedPreferences && typeof b.learnedPreferences==='object' ? b.learnedPreferences : {};
  if(!message)return send(res,200,{status:"clarify",clarificationQuestion:lang==='th'?"ลองบอกสิ่งที่อยากเปลี่ยนอีกนิดได้เลยครับ":"Tell me what you'd like to change.",learnedPreferences:[],commands:[]});
  const prompt=`You are the semantic understanding layer for a travel itinerary app. Interpret the user's natural language even when it uses slang, shorthand, misspellings, or wording that is not in any fixed dictionary. Infer MEANING, not exact keywords.

You are NOT the scheduler. You may only return normalized preferences or safe commands. The app itself enforces opening hours, travel times, monsoon safety, capacity, and day-overload rules.

Possible commands: set_day_window(day,startTime,endTime); set_buffer(day,bufferDeltaMinutes); add_place(day,placeId); remove_place(day,placeId); swap_places(day,placeId,toPlaceId); set_activity_timing(day?,activityType,period,mode).
Currently supported activity timing command: water + afternoon + avoid.

Learning policy:
- learnedPreferences are persistent user preferences supplied from earlier conversations. Use them as context, but do not treat them as absolute if the user's current request conflicts with them.
- Create a learnedPreference only when the current wording clearly expresses a durable preference or a preference confirmed by the user. Confidence must be >= 0.80.
- Normalize paraphrases and unfamiliar wording. Example: “บ่ายไม่เอาเปียก”, “ช่วงบ่ายขอไม่ลงน้ำ”, “ไม่อยากเล่นน้ำหลังเที่ยง” all mean avoid water activities in the afternoon.
- Do NOT claim to understand an ambiguous phrase merely because it resembles a known preference.
- If the user asks something whose meaning cannot be determined with confidence, return status=clarify and ask one concise question. Do not invent a command.
- For a recognized preference that the current scheduler can apply, return an appropriate normalized command.
- For a recognized preference that the scheduler cannot yet apply directly, you may return status=understood plus learnedPreferences and explain what was understood; do not invent unsupported commands.
- Never invent place IDs. Only use IDs from catalog.
- Do not invent opening hours, prices, travel facts, or feasibility.
- No day means the preference can apply to all days. If the user says a specific day, include it.

Preference keys you may normalize when clearly expressed:
- avoid_water_afternoon = true/false
- preferred_start_time = HH:MM
- preferred_end_time = HH:MM
- extra_buffer_minutes = integer
- avoid_outdoor_afternoon = true/false (store only; do not create a command unless a supported scheduler command exists)
- preferred_pace = relaxed/normal/active
For a day-specific preference, set scope=day and day=N; otherwise scope=trip.

Current remembered preferences:
${JSON.stringify(learned)}

Current trip days:
${JSON.stringify(days)}

Catalog:
${JSON.stringify(places)}

Language: ${lang}. Reply JSON only.
User message:
${JSON.stringify(message)}`;
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,{method:"POST",headers:{"x-goog-api-key":GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:"Return only JSON matching the supplied schema. You are a semantic interpreter, not a scheduler."}]},contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{temperature:0.1,responseMimeType:"application/json",responseSchema:schema}})});
  const raw=await r.text(); if(!r.ok){console.error('Gemini',r.status,raw.slice(0,500));return send(res,502,{error:"Gemini API request failed"});}
  let outer;try{outer=JSON.parse(raw)}catch{return send(res,502,{error:"Invalid Gemini response"})}
  const text=outer?.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("")||"";let result;try{result=JSON.parse(text)}catch{return send(res,502,{error:"Invalid structured response"})}
  const ids=new Set(places.map(p=>p.id));
  const safeLearned=(Array.isArray(result.learnedPreferences)?result.learnedPreferences:[]).slice(0,12).map(x=>({key:clean(x?.key,80),value:clean(x?.value,240),confidence:Math.max(0,Math.min(1,Number(x?.confidence)||0)),scope:x?.scope==='day'?'day':'trip',day:Number.isInteger(x?.day)?x.day:null})).filter(x=>x.key&&x.value&&x.confidence>=0.8&&(!x.day||(x.day>=1&&x.day<=neededDays)));
  const commands=(Array.isArray(result.commands)?result.commands:[]).slice(0,8).map(c=>{
   const out={type:types.has(c?.type)?c.type:"",day:Number.isInteger(c?.day)?c.day:null};
   if(out.type==='set_day_window'){out.startTime=time(c.startTime);out.endTime=time(c.endTime)}
   if(out.type==='set_buffer')out.bufferDeltaMinutes=Number.isInteger(c.bufferDeltaMinutes)?Math.max(-60,Math.min(120,c.bufferDeltaMinutes)):null;
   if(out.type==='set_activity_timing'){out.activityType=clean(c.activityType,30).toLowerCase();out.period=clean(c.period,30).toLowerCase();out.mode=clean(c.mode,30).toLowerCase()}
   if(['add_place','remove_place','swap_places'].includes(out.type)){out.placeId=ids.has(c?.placeId)?c.placeId:null;if(out.type==='swap_places')out.toPlaceId=ids.has(c?.toPlaceId)?c.toPlaceId:null}
   return out;
  }).filter(c=>{
   if(!c.type)return false;
   if(c.type==='set_activity_timing') return (c.day==null || (c.day>=1&&c.day<=neededDays))&&c.activityType==='water'&&c.period==='afternoon'&&c.mode==='avoid';
   return Number.isInteger(c.day)&&c.day>=1&&c.day<=neededDays && (!['add_place','remove_place','swap_places'].includes(c.type)|| (c.placeId&&ids.has(c.placeId))) && (c.type!=='swap_places'||(c.toPlaceId&&ids.has(c.toPlaceId)));
  });
  let status=['apply','understood','clarify'].includes(result.status)?result.status:(commands.length?'apply':'clarify');
  if(status!=='clarify' && !commands.length && !safeLearned.length) status='clarify';
  const clarificationQuestion=clean(result.clarificationQuestion,500)|| (status==='clarify' ? (lang==='th'?"ผมยังไม่แน่ใจว่าคุณหมายถึงอะไร ช่วยบอกอีกนิดได้ไหมครับ?":"I’m not fully sure what you mean. Could you clarify a little?") : null);
  return send(res,200,{status,understanding:clean(result.understanding,600)||null,clarificationQuestion,status==='clarify'?clarificationQuestion:null,learnedPreferences:safeLearned,commands:status==='clarify'?[]:commands});
 }catch(e){console.error('adjust-itinerary error',e);return send(res,500,{error:'Internal server error'});}
}
