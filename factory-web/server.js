import express from "express";
const app=express();
const port=Number(process.env.PORT||8080);
app.use(express.static("public",{extensions:["html"],maxAge:"1h"}));
app.get("/health",(_req,res)=>res.json({ok:true,product:"Publisher Factory Web"}));
app.get("*",(_req,res)=>res.sendFile(process.cwd()+"/public/index.html"));
app.listen(port,"0.0.0.0",()=>console.log("Publisher Factory Web listening",port));
