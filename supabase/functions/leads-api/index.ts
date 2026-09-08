import { requireUser, AuthError } from '../_shared/auth.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,isoDate=/^\d{4}-\d{2}-\d{2}$/;
const statuses=new Set(['new','contacted','measurement','estimate','negotiation','contract','lost']);
const sources=new Set(['designer','referral','website','instagram','telegram','flatica','other']);
const priorities=new Set(['low','normal','high']);
const losses=new Set(['expensive','competitor','postponed','no_response','timing','other']);
const interactionTypes=new Set(['message','call','meeting','measurement','estimate_sent','note','other']);
const projectStatuses=new Set(['preparation','in_progress','paused','handover','warranty']);
const id=(value:unknown)=>{const result=String(value||'');if(!uuid.test(result))throw new Error('invalid_id');return result};
const text=(value:unknown,max:number,required=false)=>{const result=String(value??'').trim();if(required&&!result)throw new Error('required_field');if(result.length>max)throw new Error('field_too_long');return result||null};
const date=(value:unknown)=>{if(value==null||value==='')return null;if(!isoDate.test(String(value)))throw new Error('invalid_date');return String(value)};
const timestamp=(value:unknown)=>{if(value==null||value==='')return null;const parsed=new Date(String(value));if(Number.isNaN(parsed.getTime()))throw new Error('invalid_datetime');return parsed.toISOString()};
const number=(value:unknown,max:number)=>{if(value==null||value==='')return null;const result=Number(value);if(!Number.isFinite(result)||result<0||result>max)throw new Error('invalid_number');return result};
const normalized=value=>String(value||'').toLowerCase().replace(/^https?:\/\/(www\.)?/,'').replace(/^@/,'').replace(/[\s/]+$/g,'').trim();
const normalizedPhone=value=>String(value||'').replace(/\D/g,'');

function leadInput(value:any){
 const status=String(value?.status||'new'),source=String(value?.source||'other'),priority=String(value?.priority||'normal');if(!statuses.has(status))throw new Error('invalid_status');if(!sources.has(source))throw new Error('invalid_source');if(!priorities.has(priority))throw new Error('invalid_priority');
 const designer=source==='designer'?id(value?.designer_id):null,responsible=value?.responsible_user_id?id(value.responsible_user_id):null,loss=status==='lost'?String(value?.loss_reason||''):null;if(status==='lost'&&!losses.has(loss))throw new Error('loss_reason_required');
 const area=number(value?.area_sqm,100000);if(area!==null&&area<=0)throw new Error('invalid_number');return{client_name:text(value?.client_name,200,true),phone:text(value?.phone,80),telegram:text(value?.telegram,200),email:text(value?.email,240),project_name:text(value?.project_name,240,true),address:text(value?.address,400),area_sqm:area,estimated_budget:number(value?.estimated_budget,999999999999),has_design_project:value?.has_design_project==null||value.has_design_project===''?null:!!value.has_design_project,design_project_url:text(value?.design_project_url,800),desired_start_date:date(value?.desired_start_date),source,designer_id:designer,responsible_user_id:responsible,status,priority,comment:text(value?.comment,5000),next_contact_at:timestamp(value?.next_contact_at),next_action:text(value?.next_action,1000),loss_reason:loss,loss_comment:status==='lost'?text(value?.loss_comment,2000):null,closed_at:status==='lost'?new Date().toISOString():null};
}

function projectInput(value:any){
 const status=String(value?.status||'preparation');if(!projectStatuses.has(status))throw new Error('invalid_project_status');const name=text(value?.name,160,true),area=number(value?.area_sqm,10000),start=date(value?.start_date);if(area!==null&&area<=0)throw new Error('invalid_number');
 return{name,address:text(value?.address,300),area_sqm:area,client_name:text(value?.client_name,160),client_phone:text(value?.client_phone,40),status,start_date:start,comment:text(value?.comment,2000)};
}

Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return json({error:'method_not_allowed'},405);
 try{
  const body=await req.json(),db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}}),user=await requireUser(db,body,Deno.env.get('TELEGRAM_BOT_TOKEN'));
  if(!['owner','partner'].includes(user.role))throw new AuthError('forbidden',403);const action=String(body.action||'load');
  if(action==='load'){
   const [leads,interactions,designers,projects,users]=await Promise.all([
    db.from('leads').select('*,designer:designers!leads_designer_id_fkey(id,full_name,studio,status,is_archived),responsible:app_users!leads_responsible_user_id_fkey(id,first_name,last_name,web_login,telegram_username),project:projects!leads_project_id_fkey(id,name,status)').order('created_at',{ascending:false}),
    db.from('lead_interactions').select('*,author:app_users!lead_interactions_created_by_fkey(first_name,last_name,web_login,telegram_username)').order('occurred_at',{ascending:false}),
    db.from('designers').select('id,full_name,studio,status,is_archived').eq('is_archived',false).neq('status','inactive').order('full_name'),
    db.from('projects').select('id,name,status,designer_id'),
    db.from('app_users').select('id,first_name,last_name,web_login,telegram_username,role,is_active').eq('is_active',true).in('role',['owner','partner']),
   ]);for(const result of [leads,interactions,designers,projects,users])if(result.error)throw result.error;return json({ok:true,leads:leads.data||[],interactions:interactions.data||[],designers:designers.data||[],projects:projects.data||[],users:users.data||[]});
  }
  if(action==='save_lead'){
   const raw=body.lead||{},value=leadInput(raw);
   if(value.responsible_user_id){const {data,error}=await db.from('app_users').select('role,is_active').eq('id',value.responsible_user_id).single();if(error)throw error;if(!data.is_active||!['owner','partner'].includes(data.role))throw new Error('invalid_responsible')}
   if(value.designer_id){const {data,error}=await db.from('designers').select('id,status,is_archived').eq('id',value.designer_id).single();if(error)throw error;if(data.is_archived||data.status==='inactive')throw new Error('inactive_designer')}
   if(raw.id){const {data:old,error}=await db.from('leads').select('project_id').eq('id',id(raw.id)).single();if(error)throw error;if(old.project_id&&value.status!=='contract')throw new Error('converted_lead_status_locked')}
   const {data:existing,error:existingError}=await db.from('leads').select('id,client_name,phone,telegram,project_name,status,project_id');if(existingError)throw existingError;
   const matches=(existing||[]).filter((item:any)=>item.id!==raw.id&&((value.phone&&normalizedPhone(item.phone)===normalizedPhone(value.phone))||(value.telegram&&normalized(item.telegram)===normalized(value.telegram))||(normalized(item.client_name)===normalized(value.client_name)&&normalized(item.project_name)===normalized(value.project_name))));
   if(matches.length&&!body.allow_duplicate)return json({error:'possible_duplicate',matches},409);
   let data,error;if(raw.id)({data,error}=await db.from('leads').update({...value,updated_at:new Date().toISOString()}).eq('id',id(raw.id)).select('*').single());else({data,error}=await db.from('leads').insert({...value,created_by:user.id}).select('*').single());if(error)throw error;return json({ok:true,lead:data});
  }
  if(action==='add_interaction'){
   const value=body.interaction||{},leadId=id(value.lead_id),type=String(value.interaction_type||'note');if(!interactionTypes.has(type))throw new Error('invalid_interaction_type');const {data:lead,error:leadError}=await db.from('leads').select('id').eq('id',leadId).single();if(leadError||!lead)throw leadError||new Error('lead_not_found');const {data,error}=await db.from('lead_interactions').insert({lead_id:leadId,occurred_at:timestamp(value.occurred_at)||new Date().toISOString(),interaction_type:type,comment:text(value.comment,4000,true),created_by:user.id}).select('*').single();if(error)throw error;return json({ok:true,interaction:data});
  }
  if(action==='convert_lead'){
   const leadId=id(body.lead_id),project=projectInput(body.project||{});const {data,error}=await db.rpc('convert_lead_to_project',{p_lead_id:leadId,p_project:project,p_actor_id:user.id});if(error)throw error;return json({ok:true,project:data});
  }
  return json({error:'unknown_action'},400);
 }catch(error){const raw=error instanceof Error?error.message:'unknown_error',message=['lead_already_converted','lead_not_contract','lead_not_found'].find(x=>raw.includes(x))||raw,bad=['invalid_id','required_field','field_too_long','invalid_date','invalid_datetime','invalid_number','invalid_status','invalid_source','invalid_priority','loss_reason_required','invalid_responsible','inactive_designer','converted_lead_status_locked','invalid_interaction_type','lead_not_found','lead_not_contract'];return json({error:message},error instanceof AuthError?error.status:message==='lead_already_converted'?409:bad.includes(message)?400:500)}
});
