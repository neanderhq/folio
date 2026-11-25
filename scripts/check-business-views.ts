import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { GET as authGet, POST as authPost } from '../app/api/auth/route';
import { POST as crmPost, PATCH as crmPatch } from '../app/api/crm/route';
import { GET as listsGet, POST as listsPost } from '../app/api/lists/route';
import { POST as fieldPost, PUT as valuesPut, PATCH as archiveField } from '../app/api/custom-fields/route';
if(!process.env.DATABASE_URL)throw Error('Explicit disposable DATABASE_URL required');
const db=new Client({connectionString:process.env.DATABASE_URL});const origin='http://localhost';
type Actor={cookie:string;workspace:string;user:string;email:string};type Handler=(r:Request)=>Promise<Response>;
async function call(handler:Handler,actor?:Actor,body?:object,method=body?'POST':'GET',query='') {const r=await handler(new Request(origin+'/api/test'+query,{method,headers:{...(body?{origin,'content-type':'application/json'}:{}),...(actor?{cookie:actor.cookie,'x-workspace-id':actor.workspace}:{})},body:body?JSON.stringify(body):undefined}));return {status:r.status,data:await r.json()};}
async function main(){await db.connect();const actors:Actor[]=[];const tag=randomUUID();try{
 const register=async(label:string)=>{const email=label+'-'+tag+'@example.test';const r=await authPost(new Request(origin+'/api/auth',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({action:'register',email,password:'Fictional safe password 123!',workspaceName:'CFV3 '+label})}));assert.equal(r.status,201);const cookie=r.headers.get('set-cookie')!.split(';')[0];const me=await call(authGet,{cookie,workspace:'',user:'',email});const a={cookie,workspace:me.data.workspaces[0].id,user:me.data.user.id,email};actors.push(a);return a;};
 const admin=await register('views-admin'),member=await register('views-member'),viewer=await register('views-viewer'),other=await register('views-outsider');
 for(const [a,role] of [[member,'Member'],[viewer,'Viewer']] as const)assert.equal((await call(authPost,admin,{action:'setMember',email:a.email,role})).status,200);
 const m={...member,workspace:admin.workspace},v={...viewer,workspace:admin.workspace};
 const createField=async(name:string,kind:string,actor=admin)=>{const r=await call(fieldPost,actor,{name,kind,objectType:'deal',required:false,unique:false,options:[]});assert.equal(r.status,201);return r.data;};
 const score=await createField('Score','number'),flag=await createField('Priority','checkbox'),foreign=await createField('Foreign','number',other);
 const company=(await call(crmPost,admin,{type:'company',name:'CFV3 Views Co'})).data;const person=(await call(crmPost,admin,{type:'person',name:'Views Contact',companyId:company.id})).data;
 const createDeal=async(name:string,currency:string,customValues:object)=>{const r=await call(crmPost,admin,{type:'deal',name,companyId:company.id,personId:person.id,stage:'Proposal',owner:'Sam Demo',currency,valueCents:10000,customValues});assert.equal(r.status,201);return r.data;};
 const zero=await createDeal('Zero USD','USD',{[score.id]:0,[flag.id]:false}),ten=await createDeal('Ten USD','USD',{[score.id]:10,[flag.id]:true}),missing=await createDeal('Missing USD','USD',{}),eur=await createDeal('Zero EUR','EUR',{[score.id]:0,[flag.id]:false});
 const list=(await call(listsPost,admin,{action:'create',name:'CFV3 typed segments',objectType:'deal',visibility:'private'})).data.list;
 const entries=new Map<number,string>();for(const deal of [zero,ten,missing,eur]){const r=await call(listsPost,admin,{action:'addEntry',listId:list.id,recordId:deal.id});assert.equal(r.status,201);entries.set(deal.id,r.data.entry.id);}
 const read=async(actor=admin)=>call(listsGet,actor,undefined,'GET','?listId='+list.id);let detail=(await read()).data;let view=detail.views.find((x:any)=>x.kind==='table');const legacy=view.config;assert.equal(detail.viewResults[view.id].entryIds.length,4);
 const config={version:2,filterStage:'',sort:'custom:'+score.id,direction:'asc',columns:['name','owner','value','custom:'+score.id,'custom:'+flag.id],filters:[{field:'currency',operator:'eq',value:'USD'},{field:'custom:'+score.id,operator:'gte',value:0},{field:'custom:'+flag.id,operator:'eq',value:false}]};
 const save=(c:object,actor=admin,version=view.version)=>call(listsPost,actor,{action:'saveView',listId:list.id,viewId:view.id,version,config:c});
 let saved=await save(config);assert.equal(saved.status,200);const staleVersion=view.version;view=saved.data.view;detail=(await read()).data;assert.deepEqual(detail.viewResults[view.id].entryIds,[entries.get(zero.id)]);assert.equal(detail.entries.find((e:any)=>e.recordId===zero.id).record.customValues[score.id],0);assert.equal(detail.entries.find((e:any)=>e.recordId===zero.id).record.customValues[flag.id],false);
 assert.equal((await save({...config,direction:'desc'},admin,staleVersion)).status,409);
 assert.equal((await save({...config,filters:[{field:'custom:'+foreign.id,operator:'eq',value:0}]})).status,400);
 assert.equal((await save({...config,filters:[{field:'value',operator:'gte',value:1}]})).status,400);
 assert.equal((await save({...config,filters:[{field:'custom:'+score.id,operator:'eq',value:'0'}]})).status,400);
 assert.deepEqual((await read()).data.views.find((x:any)=>x.id===view.id).config,config,'Invalid/stale saves are atomic');
 assert.equal((await read({...other,workspace:admin.workspace})).status,404);assert.equal((await read(m)).status,404);
 await call(listsPost,admin,{action:'grant',listId:list.id,email:member.email,access:'Reader'});assert.equal((await read(m)).status,200);assert.equal((await save(config,m)).status,403);
 await call(listsPost,admin,{action:'grant',listId:list.id,email:viewer.email,access:'Editor'});assert.equal((await save(config,v)).status,403);
 await call(listsPost,admin,{action:'grant',listId:list.id,email:member.email,access:'Editor'});saved=await save(config,m);assert.equal(saved.status,200);view=saved.data.view;
 // A real value edit changes the saved segment after a fresh read.
 assert.equal((await call(valuesPut,admin,{objectType:'deal',recordId:zero.id,version:zero.version,values:{[flag.id]:true}},'PUT')).status,200);assert.deepEqual((await read()).data.viewResults[view.id].entryIds,[]);
 saved=await save({...config,sort:'name',columns:['name'],filters:[{field:'custom:'+score.id,operator:'isEmpty'}]});assert.equal(saved.status,200);view=saved.data.view;assert.deepEqual((await read()).data.viewResults[view.id].entryIds,[entries.get(missing.id)]);
 saved=await save({...config,sort:'name',columns:['name'],filters:[{field:'custom:'+score.id,operator:'neq',value:0}]});assert.equal(saved.status,200);view=saved.data.view;assert.deepEqual((await read()).data.viewResults[view.id].entryIds,[entries.get(ten.id)],'Missing does not match not-equals');
 saved=await save(config);assert.equal(saved.status,200);view=saved.data.view;
 assert.equal((await call(archiveField,admin,{action:'archive',id:score.id},'PATCH')).status,200);detail=(await read()).data;assert.equal(detail.viewResults[view.id].entryIds.length,0);assert.match(detail.viewResults[view.id].issues.join(' '),/Unavailable view field/);assert.deepEqual(detail.views.find((x:any)=>x.id===view.id).config,config);
 assert.equal((await save(config)).status,400);saved=await save(legacy);assert.equal(saved.status,200);view=saved.data.view;assert.equal((await read()).data.viewResults[view.id].entryIds.length,4);
 console.log('Business views passed: persisted typed AND segments/columns/sort,0/false/null, currency guards, invalid and stale atomicity, changing membership, private Reader/Editor/Viewer/isolation, archive stops results and explicit legacy correction.');
}finally{
 const ids=actors.map(a=>a.workspace);if(ids.length){for(const table of ['crm_lists','crm_custom_values','record_changes','tasks','notes','deals','people','companies','crm_custom_fields','crm_workspace_seeds'])await db.query(`delete from ${table} where workspace_id=ANY($1::uuid[])`,[ids]);await db.query('delete from crm_memberships where workspace_id=ANY($1::uuid[])',[ids]);await db.query('delete from crm_workspaces where id=ANY($1::uuid[])',[ids]);}
 for(const a of actors){await db.query('delete from crm_sessions where user_id=$1',[a.user]);await db.query('delete from crm_users where id=$1',[a.user]);}await db.end();}}
main().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
