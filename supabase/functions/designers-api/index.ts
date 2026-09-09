import { requireUser, AuthError } from '../_shared/auth.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses=new Set(['found','to_review','contacted','replied','meeting','agreed','referred_lead','has_project','ignored','rejected']);
const priorities=new Set(['low','normal','high']);
const interactionTypes=new Set(['message','call','meeting','note','other']);
const directions=new Set(['incoming','outgoing']);
const id=(value:unknown)=>{const result=String(value||'');if(!uuid.test(result))throw new Error('invalid_id');return result};
const text=(value:unknown,max:number,required=false)=>{const result=String(value??'').trim();if(required&&!result)throw new Error('required_field');if(result.length>max)throw new Error('field_too_long');return result||null};
const timestamp=(value:unknown)=>{if(value==null||value==='')return null;const parsed=new Date(String(value));if(Number.isNaN(parsed.getTime()))throw new Error('invalid_datetime');return parsed.toISOString()};
const normalized=value=>String(value||'').toLowerCase().replace(/^https?:\/\/(www\.)?/,'').replace(/^@/,'').replace(/[\s/]+$/g,'').trim();
const normalizedPhone=value=>String(value||'').replace(/\D/g,'');

function designerInput(value:any){
 const status=String(value?.status||'found'),priority=String(value?.priority||'normal');if(!statuses.has(status))throw new Error('invalid_status');if(!priorities.has(priority))throw new Error('invalid_priority');
 const responsible=value?.responsible_user_id?id(value.responsible_user_id):null;
 const tags=Array.isArray(value?.tags)?[...new Set(value.tags.map((item:unknown)=>String(item).trim()).filter(Boolean))].slice(0,20):[];
 return{full_name:text(value?.full_name,200,true),studio:text(value?.studio,200),instagram:text(value?.instagram,300),telegram:text(value?.telegram,200),phone:text(value?.phone,80),email:text(value?.email,240),website:text(value?.website,500),status,responsible_user_id:responsible,next_contact_at:timestamp(value?.next_contact_at),next_action:text(value?.next_action,1000),notes:text(value?.notes,5000),source:text(value?.source,200),city:text(value?.city,160),portfolio_url:text(value?.portfolio_url,500),priority,tags};
}

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 try{
  const body=await req.json(),db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}}),user=await requireUser(db,body,Deno.env.get('TELEGRAM_BOT_TOKEN'));
  if(!['owner','partner'].includes(user.role))throw new AuthError('forbidden',403);const action=String(body.action||'load');
  if(action==='load'){
   const [designers,interactions,projects,users]=await Promise.all([
    db.from('designers').select('*,responsible:app_users!designers_responsible_user_id_fkey(id,first_name,last_name,web_login,telegram_username,role,is_active)').order('created_at',{ascending:false}),
    db.from('designer_interactions').select('*,author:app_users!designer_interactions_created_by_fkey(first_name,last_name,web_login,telegram_username)').order('occurred_at',{ascending:false}),
    db.from('projects').select('id,name,status,designer_id'),
    db.from('app_users').select('id,first_name,last_name,web_login,telegram_username,role,is_active').eq('is_active',true).in('role',['owner','partner']),
   ]);for(const result of [designers,interactions,projects,users])if(result.error)throw result.error;
   return json({ok:true,designers:designers.data||[],interactions:interactions.data||[],projects:projects.data||[],users:users.data||[]});
  }
  if(action==='save_designer'){
   const raw=body.designer||{},value=designerInput(raw);
   if(value.responsible_user_id){const {data,error}=await db.from('app_users').select('id,role,is_active').eq('id',value.responsible_user_id).single();if(error)throw error;if(!data.is_active||!['owner','partner'].includes(data.role))throw new Error('invalid_responsible')}
   const {data:existing,error:existingError}=await db.from('designers').select('id,full_name,studio,instagram,telegram,phone').eq('is_archived',false);if(existingError)throw existingError;
   const matches=(existing||[]).filter((item:any)=>item.id!==raw.id&&((value.instagram&&normalized(item.instagram)===normalized(value.instagram))||(value.telegram&&normalized(item.telegram)===normalized(value.telegram))||(value.phone&&normalizedPhone(item.phone)===normalizedPhone(value.phone))||(normalized(item.full_name)===normalized(value.full_name)&&normalized(item.studio)===normalized(value.studio))));
   if(matches.length&&!body.allow_duplicate)return json({error:'possible_duplicate',matches},409);
   let data,error,previous:any=null;if(raw.id){const itemId=id(raw.id);const old=await db.from('designers').select('status').eq('id',itemId).single();if(old.error)throw old.error;previous=old.data;({data,error}=await db.from('designers').update({...value,updated_at:new Date().toISOString()}).eq('id',itemId).select('*').single())}else({data,error}=await db.from('designers').insert({...value,created_by:user.id}).select('*').single());if(error)throw error;
   if(previous&&previous.status!==value.status)await db.from('designer_interactions').insert({designer_id:data.id,interaction_type:'note',comment:`Статус изменён: ${previous.status} → ${value.status}`,created_by:user.id});
   return json({ok:true,designer:data});
  }
  if(action==='archive_designer'){
   const itemId=id(body.id),archived=body.archived!==false;const {data,error}=await db.from('designers').update({is_archived:archived,updated_at:new Date().toISOString()}).eq('id',itemId).select('*').single();if(error)throw error;return json({ok:true,designer:data});
  }
  if(action==='add_interaction'){
   const value=body.interaction||{},designerId=id(value.designer_id),type=String(value.interaction_type||'note'),direction=value.direction?String(value.direction):null;if(!interactionTypes.has(type))throw new Error('invalid_interaction_type');if(direction&&!directions.has(direction))throw new Error('invalid_direction');
   const {data:designer,error:designerError}=await db.from('designers').select('id').eq('id',designerId).single();if(designerError||!designer)throw designerError||new Error('designer_not_found');
   const {data,error}=await db.from('designer_interactions').insert({designer_id:designerId,occurred_at:timestamp(value.occurred_at)||new Date().toISOString(),interaction_type:type,direction,comment:text(value.comment,4000,true),result:text(value.result,1000),created_by:user.id}).select('*').single();if(error)throw error;const updated=await db.from('designers').select('*').eq('id',designerId).single();if(updated.error)throw updated.error;return json({ok:true,interaction:data,designer:updated.data});
  }
  return json({error:'unknown_action'},400);
 }catch(error){const message=error instanceof Error?error.message:'unknown_error',bad=['invalid_id','required_field','field_too_long','invalid_datetime','invalid_status','invalid_priority','invalid_responsible','invalid_interaction_type','invalid_direction','designer_not_found'];return json({error:message},error instanceof AuthError?error.status:bad.includes(message)?400:500)}
});
