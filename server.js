import express from 'express';
import { CONFIG,PROJECT_ID,PROJECT_NAME } from './runtime-config.js';
const app=express();
const PORT=Number(process.env.PORT||8080);
app.use(express.json());
app.get('/factory/health',(req,res)=>res.json({
  ok:true,
  runtime_version:'publisher-runtime-v1',
  sandbox:true,
  publisher_enabled:false,
  show:CONFIG.identity.show_name,
  automation_provider:'FreeBrowserProvider',
  generation_provider:'GoogleFlowProvider',
  publication_provider:'YouTubeProvider',
  tinyfish_required:false,
  flow:{configured:Boolean(PROJECT_ID),project_id:PROJECT_ID||null,project_name:PROJECT_NAME||null},
  note:'Build sandbox. Production runtime security/review server remains canonical in publisher-runtime/server.js.'
}));
app.get('/',(req,res)=>res.type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publisher Runtime v1</title><body style="font-family:system-ui;padding:32px"><h1>Publisher Runtime v1</h1><p>Build sandbox is live. Generation is disabled.</p></body>'));
app.listen(PORT,'0.0.0.0',()=>console.log('Publisher Runtime build sandbox listening',PORT));