import { requireUser, AuthError } from '../_shared/auth.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const isoDate=/^\d{4}-\d{2}-\d{2}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actStatuses=new Set(['draft','issued','signed','partially_paid','paid']);
const waybillStatuses=new Set(['created','sent','partially_paid','paid','closed']);
const companyCategories=new Set(['advertising','services','office','transport','administrative','salaries','taxes','banking','other']);
const text=(v:any,max:number,required=false)=>{const s=String(v??'').trim();if(required&&!s)throw new Error('required_field');if(s.length>max)throw new Error('field_too_long');return s||null};
const date=(v:any)=>{const s=String(v||'');if(!isoDate.test(s))throw new Error('invalid_date');return s};
const amount=(v:any,allowZero=false)=>{const n=Number(v);if(!Number.isFinite(n)||(allowZero?n<0:n<=0)||n>999999999999.99)throw new Error('invalid_amount');return n};
const id=(v:any)=>{const s=String(v||'');if(!uuid.test(s))throw new Error('invalid_id');return s};

function actInput(v:any){
  const status=String(v?.status||'draft');if(!actStatuses.has(status))throw new Error('invalid_status');
  const stageId=v?.stage_id? id(v.stage_id):null;
  return {project_id:id(v?.project_id),stage_id:stageId,number:text(v?.number,100,true),act_date:date(v?.act_date),title:text(v?.title,300,true),amount:amount(v?.amount,true),status,file_path:text(v?.file_path,500),comment:text(v?.comment,4000)};
}
function waybillInput(v:any){
  const status=String(v?.status||'created');if(!waybillStatuses.has(status))throw new Error('invalid_status');
  return {project_id:id(v?.project_id),number:text(v?.number,100,true),waybill_date:date(v?.waybill_date),supplier:text(v?.supplier,200,true),description:text(v?.description,2000),amount:amount(v?.amount,true),status,file_path:text(v?.file_path,500),comment:text(v?.comment,4000)};
}
function companyInput(v:any){
  const category=String(v?.category||'');if(!companyCategories.has(category))throw new Error('invalid_category');
  return {expense_date:date(v?.expense_date),amount:amount(v?.amount),category,description:text(v?.description,1000,true),comment:text(v?.comment,4000),file_path:text(v?.file_path,500)};
}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  try{
    const body=await req.json();
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const user=await requireUser(db,body,Deno.env.get('TELEGRAM_BOT_TOKEN'));
    if(user.role!=='owner'&&user.role!=='partner')return json({error:'forbidden'},403);
    const action=String(body?.action||'load');
    const removeFile=async(path:any)=>{if(path)await db.storage.from('finance-documents').remove([String(path)])};
    const signed=async(rows:any[])=>Promise.all((rows||[]).map(async row=>{row.file_url=null;if(row.file_path){const {data}=await db.storage.from('finance-documents').createSignedUrl(row.file_path,3600);row.file_url=data?.signedUrl||null}return row}));
    const recalcAct=async(actId:string)=>{const [{data:act,error:ae},{data:payments,error:pe}]=await Promise.all([db.from('finance_acts').select('amount,status').eq('id',actId).single(),db.from('finance_act_payments').select('amount').eq('act_id',actId)]);if(ae)throw ae;if(pe)throw pe;const paid=(payments||[]).reduce((s:number,x:any)=>s+Number(x.amount||0),0);let status=act.status;if(paid>=Number(act.amount)&&Number(act.amount)>0)status='paid';else if(paid>0)status='partially_paid';else if(status==='paid'||status==='partially_paid')status='signed';const {error}=await db.from('finance_acts').update({status,updated_at:new Date().toISOString()}).eq('id',actId);if(error)throw error};
    const recalcWaybill=async(waybillId:string)=>{const [{data:w,error:we},{data:payments,error:pe}]=await Promise.all([db.from('finance_waybills').select('amount,status').eq('id',waybillId).single(),db.from('finance_waybill_payments').select('amount').eq('waybill_id',waybillId)]);if(we)throw we;if(pe)throw pe;if(w.status==='closed')return;const paid=(payments||[]).reduce((s:number,x:any)=>s+Number(x.amount||0),0);const status=paid>=Number(w.amount)&&Number(w.amount)>0?'paid':paid>0?'partially_paid':w.status==='paid'||w.status==='partially_paid'?'sent':w.status;const {error}=await db.from('finance_waybills').update({status,updated_at:new Date().toISOString()}).eq('id',waybillId);if(error)throw error};

    if(action==='load'){
      const [ar,acr,apr,wr,wpr,cer]=await Promise.all([
        db.from('finance_acts').select('*').order('act_date',{ascending:false}),
        db.from('finance_act_costs').select('*').order('cost_date',{ascending:false}),
        db.from('finance_act_payments').select('*').order('payment_date',{ascending:false}),
        db.from('finance_waybills').select('*').order('waybill_date',{ascending:false}),
        db.from('finance_waybill_payments').select('*').order('payment_date',{ascending:false}),
        db.from('company_expenses').select('*,author:app_users!company_expenses_created_by_fkey(first_name,last_name,telegram_username,web_login)').order('expense_date',{ascending:false}),
      ]);for(const r of [ar,acr,apr,wr,wpr,cer])if(r.error)throw r.error;
      return json({ok:true,acts:await signed(ar.data||[]),act_costs:acr.data||[],act_payments:apr.data||[],waybills:await signed(wr.data||[]),waybill_payments:wpr.data||[],company_expenses:await signed(cer.data||[])});
    }
    if(action==='save_act'){
      const value=actInput(body.act);let data,error;
      if(body.act?.id)({data,error}=await db.from('finance_acts').update({...value,updated_at:new Date().toISOString()}).eq('id',id(body.act.id)).select('*').single());
      else({data,error}=await db.from('finance_acts').insert({...value,created_by:user.id}).select('*').single());
      if(error)throw error;return json({ok:true,act:data});
    }
    if(action==='delete_act'){
      const actId=id(body.id);const {data:old,error:oe}=await db.from('finance_acts').select('file_path').eq('id',actId).single();if(oe)throw oe;const {error}=await db.from('finance_acts').delete().eq('id',actId);if(error)throw error;await removeFile(old.file_path);return json({ok:true});
    }
    if(action==='add_act_cost'||action==='add_act_payment'){
      const actId=id(body.act_id),isCost=action==='add_act_cost';const row=isCost?{act_id:actId,cost_date:date(body.date),amount:amount(body.amount),description:text(body.comment,1000),created_by:user.id}:{act_id:actId,payment_date:date(body.date),amount:amount(body.amount),comment:text(body.comment,1000),created_by:user.id};const {data,error}=await db.from(isCost?'finance_act_costs':'finance_act_payments').insert(row).select('*').single();if(error)throw error;if(!isCost)await recalcAct(actId);return json({ok:true,item:data});
    }
    if(action==='delete_act_cost'||action==='delete_act_payment'){
      const isCost=action==='delete_act_cost',table=isCost?'finance_act_costs':'finance_act_payments';const {data:old,error:oe}=await db.from(table).select('act_id').eq('id',id(body.id)).single();if(oe)throw oe;const {error}=await db.from(table).delete().eq('id',id(body.id));if(error)throw error;if(!isCost)await recalcAct(old.act_id);return json({ok:true});
    }
    if(action==='save_waybill'){
      const value=waybillInput(body.waybill);let data,error;
      if(body.waybill?.id)({data,error}=await db.from('finance_waybills').update({...value,updated_at:new Date().toISOString()}).eq('id',id(body.waybill.id)).select('*').single());
      else({data,error}=await db.from('finance_waybills').insert({...value,created_by:user.id}).select('*').single());
      if(error)throw error;return json({ok:true,waybill:data});
    }
    if(action==='delete_waybill'){
      const waybillId=id(body.id);const {data:old,error:oe}=await db.from('finance_waybills').select('file_path').eq('id',waybillId).single();if(oe)throw oe;const {error}=await db.from('finance_waybills').delete().eq('id',waybillId);if(error)throw error;await removeFile(old.file_path);return json({ok:true});
    }
    if(action==='add_waybill_payment'){
      const waybillId=id(body.waybill_id);const {data,error}=await db.from('finance_waybill_payments').insert({waybill_id:waybillId,payment_date:date(body.date),amount:amount(body.amount),comment:text(body.comment,1000),created_by:user.id}).select('*').single();if(error)throw error;await recalcWaybill(waybillId);return json({ok:true,item:data});
    }
    if(action==='delete_waybill_payment'){
      const itemId=id(body.id);const {data:old,error:oe}=await db.from('finance_waybill_payments').select('waybill_id').eq('id',itemId).single();if(oe)throw oe;const {error}=await db.from('finance_waybill_payments').delete().eq('id',itemId);if(error)throw error;await recalcWaybill(old.waybill_id);return json({ok:true});
    }
    if(action==='save_company_expense'){
      const value=companyInput(body.expense);let data,error;
      if(body.expense?.id)({data,error}=await db.from('company_expenses').update({...value,updated_at:new Date().toISOString()}).eq('id',id(body.expense.id)).select('*').single());
      else({data,error}=await db.from('company_expenses').insert({...value,created_by:user.id}).select('*').single());
      if(error)throw error;return json({ok:true,expense:data});
    }
    if(action==='delete_company_expense'){
      const expenseId=id(body.id);const {data:old,error:oe}=await db.from('company_expenses').select('file_path').eq('id',expenseId).single();if(oe)throw oe;const {error}=await db.from('company_expenses').delete().eq('id',expenseId);if(error)throw error;await removeFile(old.file_path);return json({ok:true});
    }
    return json({error:'unknown_action'},400);
  }catch(e){const message=e instanceof Error?e.message:'unknown_error';return json({error:message},e instanceof AuthError?e.status:['missing_hash','bad_signature','expired_init_data','missing_user'].includes(message)?401:message.startsWith('invalid_')||message==='required_field'||message==='field_too_long'?400:500)}
});
