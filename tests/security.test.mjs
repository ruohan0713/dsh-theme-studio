import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
const dir=await mkdtemp(join(tmpdir(),'theme-security-'));
await cp(new URL('../index.js',import.meta.url),join(dir,'index.mjs'));
const {apply}=await import(pathToFileURL(join(dir,'index.mjs')));
function routes(connection){const out=[];apply({connection,webServer:{register:r=>{out.push(r);return()=>{}}},effect:f=>f()});return out;}
async function call(route,method='POST',type='application/json',body='{}'){
 const req=Readable.from([Buffer.from(body)]);Object.assign(req,{method,url:route.path+'?name=test.png',headers:{'content-type':type}});
 const res={status:0,body:'',writeHead(n){this.status=n},end(s){this.body=s}};
 await route.handler(req,res);return res;
}
test('every route fails closed without a supported access gate',async()=>{
 for(const connection of [undefined,{}, {admit(){throw Error('unavailable')}}])for(const route of routes(connection)){
 const status=route.handler?(await call(route)).status:(await route.resource(new Request('http://localhost/theme-studio/manifest.json'))).status;assert.equal(status,503);
 }
});
test('legacy and new admission rejections protect reads and writes',async()=>{
 for(const connection of [{requestRejection:()=>403},{admit:()=>({rejection:401})}])for(const route of routes(connection)){
 const expected=connection.admit?401:403;
 assert.equal(route.auth,'required');
 assert.equal(route.handler?(await call(route)).status:(await route.resource(new Request('http://localhost/theme-studio/manifest.json'))).status,expected);
 }
});
test('authorized diagnostics and upload retain safe request contracts',async()=>{
 for(const connection of [{requestRejection:()=>undefined},{admit:()=>({peer:{}})}]){
 const rs=routes(connection),diag=rs.find(r=>r.path.endsWith('/diag')),upload=rs.find(r=>r.path.endsWith('/upload'));
 await rm(join(dir,'enable-diagnostics'),{force:true});assert.equal((await call(diag)).status,403);
 await writeFile(join(dir,'enable-diagnostics'),'');
 assert.equal((await call(diag,'GET')).status,405);
 assert.equal((await call(diag,'POST','text/plain')).status,415);
 assert.equal((await call(diag,'POST','application/json','bad')).status,400);
 assert.equal((await call(diag,'POST','application/json; charset=utf-8','{"ok":true}')).status,204);
 assert.equal(JSON.parse(await readFile(join(dir,'theme-studio-diagnostics.json'))).payload.ok,true);
 assert.equal((await call(upload,'GET')).status,405);
 assert.equal((await call(upload,'POST','text/plain')).status,415);
 assert.equal((await call(upload,'POST','image/png','test-image')).status,200);
 const resource=rs[0].resource;
 assert.equal((await resource(new Request('http://localhost/theme-studio/manifest.json'))).status,200);
 assert.equal((await resource(new Request('http://localhost/theme-studio/manifest.json',{method:'POST'}))).status,405);
 }
});
test.after(async()=>rm(dir,{recursive:true,force:true}));
