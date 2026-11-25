import { NextResponse } from 'next/server';
import { AccessError, sameOrigin, workspaceAccess } from '../../../server/auth';
import { changeMail, disconnectMail, readMail, startMail, syncMail } from '../../../server/mail';
export const dynamic='force-dynamic';
const fail=(e:unknown)=>NextResponse.json({error:e instanceof AccessError?e.message:'Email capture is unavailable. No credentials or provider details are exposed; retry or disconnect.'},{status:e instanceof AccessError?e.status:503});
export async function GET(request:Request){try{const a=await workspaceAccess(request),q=new URL(request.url).searchParams,type=q.get('recordType'),id=Number(q.get('recordId'));if(type&&(!Number.isSafeInteger(id)||id<=0))throw new AccessError('Invalid record.',400);return NextResponse.json(await readMail(a,type?{type,id}:undefined),{headers:{'Cache-Control':'no-store'}});}catch(e){return fail(e);}}
export async function POST(request:Request){try{sameOrigin(request);const a=await workspaceAccess(request,true),text=await request.text();if(text.length>4096)throw new AccessError('Request is too large.',413);let b:Record<string,unknown>;try{b=JSON.parse(text);}catch{throw new AccessError('Provide a valid capture action.',400);}if(!b||typeof b!=='object')throw new AccessError('Provide a valid capture action.',400);
 if(b.action==='connect')return NextResponse.json({url:await startMail(request,a)});if(b.action==='sync'){const r=await syncMail(a);return NextResponse.json(r,{status:r.ok?200:r.status});}return NextResponse.json(await changeMail(a,b));}catch(e){return fail(e);}}
export async function DELETE(request:Request){try{sameOrigin(request);const a=await workspaceAccess(request);return NextResponse.json(await disconnectMail(a));}catch(e){return fail(e);}}
