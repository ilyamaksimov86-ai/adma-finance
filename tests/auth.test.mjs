import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {requireUser,verifyTelegram} from '../supabase/functions/_shared/auth.mjs';
const bot='test-only-bot-token';
function telegram(date=Math.floor(Date.now()/1000)) {
 const p=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id:123})});
 const data=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=createHmac('sha256','WebAppData').update(bot).digest();
 p.set('hash',createHmac('sha256',secret).update(data).digest('hex'));return p.toString();
}
function db(user,authError=false) {
 return {auth:{getUser:async token=>({data:{user:{id:'verified-id',user_metadata:{role:'owner',id:'victim'}}},error:authError?Error('bad'):null})},from:table=>({select:()=>({eq:(field,id)=>{assert.equal(table,'app_users');if(field==='id')assert.equal(id,'verified-id');else assert.equal(id,123);return{maybeSingle:async()=>({data:user,error:null})};}})})};
}
test('valid Telegram signature is accepted',async()=>assert.equal((await verifyTelegram(telegram(),bot)).id,123));
test('forged Telegram signature is rejected',async()=>assert.rejects(()=>verifyTelegram(telegram().replace('123','456'),bot),/bad_signature/));
test('expired Telegram credentials are rejected',async()=>assert.rejects(()=>verifyTelegram(telegram(1),bot),/expired_init_data/));
test('web identity uses verified Supabase ID; ignores editable role metadata',async()=>assert.equal((await requireUser(db({role:'foreman',is_active:true}),{accessToken:'test'},bot)).role,'foreman'));
test('invalid JWT cannot fall back to a supplied Telegram account',async()=>assert.rejects(()=>requireUser(db({},true),{accessToken:'forged',initData:telegram()},bot),/invalid_session/));
test('unmapped Auth user has no app access',async()=>assert.rejects(()=>requireUser(db(null),{accessToken:'test'},bot),/not_registered/));
test('disabled user denied even with a valid token',async()=>assert.rejects(()=>requireUser(db({is_active:false}),{accessToken:'test'},bot),/not_approved/));
test('Telegram resolves existing application account',async()=>assert.equal((await requireUser(db({id:'original',is_active:true}),{initData:telegram()},bot)).id,'original'));
