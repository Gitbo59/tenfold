import http from "node:http";
const base = ["Alpha","Bravo","Charlie","Delta","Echo","Foxtrot","Golf","Hotel","India","Juliet"].map((a,i)=>({answer:a,aliases:i===0?["A-lpha","the first letter"]:[],detail:`Fact ${i+1}`}));
let calls = 0; const seen = []; let flaky = 0;
const full = { title: "NATO alphabet, first ten", basis: "Order of the alphabet", source: "Wikipedia: NATO phonetic alphabet", answers: base };
http.createServer((req,res)=>{
  let body=""; req.on("data",d=>body+=d); req.on("end",()=>{
    res.setHeader("content-type","application/json");
    if (req.url === "/count") { res.end(JSON.stringify({calls, seen})); return; }
    const j = JSON.parse(body||"{}");
    const user = j.messages?.find(m=>m.role==="user")?.content ?? "";
    const system = j.messages?.find(m=>m.role==="system")?.content ?? "";
    calls++; seen.push({ user, hard: system.includes("Difficulty HARD"), easy: system.includes("Difficulty EASY"), auth: req.headers.authorization, model: j.model, max_tokens: j.max_tokens });
    const reply = (obj) => res.end(JSON.stringify({choices:[{message:{content: typeof obj==="string"?obj:JSON.stringify(obj)}}]}));
    if (user.includes("boom")) { res.statusCode = 500; res.end("upstream exploded"); return; }
    if (user.includes("bad")) return reply({title:"x",basis:"y",source:"",rejection_reason:"Not suitable for the game.",answers:[]});
    if (user.includes("flaky") && flaky++ % 2 === 0) return reply({...full, answers: base.slice(0,5)});
    if (user.includes("fenced")) return reply("```json\n"+JSON.stringify(full)+"\n```");
    reply(full);
  });
}).listen(9999,()=>console.log("mock ai up"));
