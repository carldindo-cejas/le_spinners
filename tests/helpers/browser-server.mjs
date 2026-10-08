// Read-only static server for real browser modules with intercepted synthetic APIs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.env.SYSTEM_BROWSER_ROOT||'.','public');
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');let name;
  try{name=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end();return;}
  let file=path.resolve(root,'.'+name);
  if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(404);res.end();return;}
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
  if(!fs.existsSync(file)&&!path.extname(name))file=path.join(root,name.startsWith('/admin')||name.startsWith('/revenue')?'admin/index.html':name.startsWith('/staff')?'staff/index.html':'index.html');
  if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT||8799),'127.0.0.1',()=>console.log('Browser fixture server ready on '+(process.env.PORT||8799)));
