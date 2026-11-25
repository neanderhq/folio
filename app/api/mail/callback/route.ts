import { NextResponse } from 'next/server';
import { AccessError } from '../../../../server/auth';
import { finishMail } from '../../../../server/mail';
import { mailConfig } from '../../../../server/mail-provider';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{const result=await finishMail(request),config=mailConfig()!;const url=new URL('/',config.redirectUri);url.searchParams.set('workspace',result.workspace);url.searchParams.set('mail',result.outcome);return NextResponse.redirect(url,{status:303,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}catch(e){return NextResponse.json({error:e instanceof AccessError?e.message:'Google authorization failed. Return to Email capture and reconnect.'},{status:e instanceof AccessError?e.status:503,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}}
