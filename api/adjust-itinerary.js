const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const types = new Set(["set_day_window","set_buffer","add_place","remove_place","swap_places","set_origin_preference"]);
const schema = {type:"OBJECT",properties:{commands:{type:"ARRAY",items:{type:"OBJECT",properties:{type:{type:"STRING"},day:{type:"INTEGER",nullable:true},startTime:{type:"STRING",nullable:true},endTime:{type:"STRING",nullable:true},bufferDeltaMinutes:{type:"INTEGER",nullable:true},placeId:{type:"STRING",nullable:true},toPlaceId:{type:"STRING",nullable:true},originPreference:{type:"STRING",nullable:true}},required:["type"]}}},required:["commands"]};
const clean=(v,n=1000)=>typeof v==="string"?v.trim().slice(0,n):"";
const time=v=>{const s=clean(v,5);return /^([01]\d|2[0-3]):[0-5]\d$/.test(s)?s:null};
function send(res,status,body){res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(body));}
export default async function handler(req,res){
 if(req.method!=="POST")return send(res,405,{error:"Method not allowed"});
 if(!GEMINI_API_KEY)return send(res,503,{error:"GEMINI_API_KEY is not configured"});
 try{
  const b=req.body||{}, message=clean(b.message,2000), lang=b.lang==="en"?"en":"th";
  const neededDays=Number.isInteger(b.neededDays)?Math.max(1,Math.min(14,b.neededDays)):1;
  const places=Array.isArray(b.places)?b.places.slice(0,40).map(p=>({id:clean(p?.id,100),name:clean(p?.name,200)})):[];
  const days=Array.isArray(b.days)?b.days.slice(0,14):[];
  const origin=b.origin&&typeof b.origin==='object'?{mode:clean(b.origin.mode,40),label:clean(b.origin.label,200),nearbyFirst:!!b.origin.nearbyFirst}:null;
  const prompt=`You are only a natural-language command parser for an itinerary adjustment UI. Convert the user's request into structured commands. Do not schedule or optimize anything. The app's existing generateItinerary recalculates the full schedule and enforces opening hours, travel time, monsoon, and other rules.
Supported types only: set_day_window(day,startTime,endTime); set_buffer(day,bufferDeltaMinutes); add_place(day,placeId); remove_place(day,placeId); swap_places(day,placeId,toPlaceId); set_origin_preference(originPreference). originPreference must be one of nearby_first or balanced. Use set_origin_preference with no day when user asks to prioritize nearby places from their starting point or stop doing so.
Safety: use only catalog IDs; never invent IDs; if day is unclear return no command; if a place is ambiguous/not in catalog return no command for it; do not invent feasibility, hours, prices, or travel facts. Positive buffer adds rest, negative buffer reduces it. Times must be HH:MM.
Language: ${lang}. Trip has ${neededDays} days.
Current days: ${JSON.stringify(days)}
Starting point context: ${JSON.stringify(origin)}
Learned preferences context: ${JSON.stringify(b.learnedPreferences||{})}
Catalog: ${JSON.stringify(places)}
User request: ${JSON.stringify(message)}`;
  if(!message)return send(res,200,{commands:[]});
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,{method:"POST",headers:{"x-goog-api-key":GEMINI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:"Return only JSON matching the supplied schema. You are a command parser, not a scheduler."}]},contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{temperature:0,responseMimeType:"application/json",responseSchema:schema}})});
  const raw=await r.text(); if(!r.ok)return send(res,502,{error:"Gemini API request failed"});
  let outer;try{outer=JSON.parse(raw)}catch{return send(res,502,{error:"Invalid Gemini response"})}
  const text=outer?.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("")||""; let result;try{result=JSON.parse(text)}catch{return send(res,502,{error:"Invalid structured response"})}
  const ids=new Set(places.map(p=>p.id));
  const commands=(Array.isArray(result.commands)?result.commands:[]).slice(0,8).map(c=>{
   const out={type:types.has(c?.type)?c.type:"",day:Number.isInteger(c?.day)?c.day:null};
   if(out.type==="set_origin_preference") out.originPreference = ["nearby_first","balanced"].includes(c?.originPreference)?c.originPreference:null;
   if(out.type==="set_day_window"){out.startTime=time(c.startTime);out.endTime=time(c.endTime);}
   if(out.type==="set_buffer")out.bufferDeltaMinutes=Number.isInteger(c.bufferDeltaMinutes)?Math.max(-60,Math.min(120,c.bufferDeltaMinutes)):null;
   if(["add_place","remove_place","swap_places"].includes(out.type)){out.placeId=ids.has(c?.placeId)?c.placeId:null;if(out.type==="swap_places")out.toPlaceId=ids.has(c?.toPlaceId)?c.toPlaceId:null;}
   return out;
  }).filter(c=>c.type && (c.type==="set_origin_preference" || (Number.isInteger(c.day)&&c.day>=1&&c.day<=neededDays)) && (!c.placeId||ids.has(c.placeId)) && (!c.toPlaceId||ids.has(c.toPlaceId)));
  return send(res,200,{commands});
 }catch(e){console.error("adjust-itinerary error",e);return send(res,500,{error:"Internal server error"});}
}
