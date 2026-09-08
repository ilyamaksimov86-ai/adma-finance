import { requireUser, AuthError } from '../_shared/auth.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const isoDate=/^\d{4}-\d{2}-\d{2}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const specialties=new Set(['demolition','rough','plaster','painting','tile','plumbing','electrical','drywall','flooring','carpentry','universal','other']);
const priceLevels=new Set(['low','medium','high','premium']);
const assignmentStatuses=new Set(['planned','active','completed','cancelled']);
const text=(value:any,max:number,required=false)=>{const s=String(value??'').trim();if(required&&!s)throw new Error('required_field');if(s.length>max)throw new Error('field_too_long');return s||null};
const id=(value:any)=>{const s=String(value||'');if(!uuid.test(s))throw new Error('invalid_id');return s};
const date=(value:any,required=false)=>{const s=String(value||'');if(!s&&!required)return null;if(!isoDate.test(s))throw new Error('invalid_date');return s};

function masterInput(value:any){
  const specialty=String(value?.primary_specialty||'other');if(!specialties.has(specialty))throw new Error('invalid_specialty');
  const skills=[...new Set((Array.isArray(value?.additional_skills)?value.additional_skills:[]).map((x:any)=>String(x)).filter((x:string)=>specialties.has(x)&&x!==specialty))];if(skills.length>20)throw new Error('too_many_skills');
  const rating=value?.rating==null||value.rating===''?null:Number(value.rating);if(rating!=null&&(!Number.isFinite(rating)||rating<1||rating>5))throw new Error('invalid_rating');
  const price=value?.price_level==null||value.price_level===''?null:String(value.price_level);if(price&&!priceLevels.has(price))throw new Error('invalid_price_level');
  return {name:text(value?.name,160,true),phone:text(value?.phone,80),telegram:text(value?.telegram,100),primary_specialty:specialty,additional_skills:skills,rating,price_level:price,notes:text(value?.notes,4000)};
}

function assignmentInput(value:any){
  const status=String(value?.status||'planned');if(!assignmentStatuses.has(status))throw new Error('invalid_assignment_status');
  const start=date(value?.start_date,true)!;const planned=date(value?.planned_end_date);const actual=date(value?.actual_end_date);
  if(planned&&planned<start)throw new Error('invalid_assignment_dates');if(actual&&actual<start)throw new Error('invalid_assignment_dates');
  return {master_id:id(value?.master_id),project_id:id(value?.project_id),stage_id:value?.stage_id?id(value.stage_id):null,start_date:start,planned_end_date:planned,actual_end_date:actual,status,comment:text(value?.comment,2000)};
}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  try{
    const body=await req.json();
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
    const user=await requireUser(db,body,Deno.env.get('TELEGRAM_BOT_TOKEN'));
    const privileged=user.role==='owner'||user.role==='partner';
    const action=String(body?.action||'load');
    const allowedProjectIds=async()=>{if(privileged)return null;const {data,error}=await db.from('project_members').select('project_id').eq('user_id',user.id);if(error)throw error;return(data||[]).map((x:any)=>x.project_id)};

    if(action==='load'){
      const projectIds=await allowedProjectIds();
      let aq=db.from('master_assignments').select('*').order('start_date',{ascending:false});
      if(projectIds)aq=projectIds.length?aq.in('project_id',projectIds):aq.eq('project_id','00000000-0000-0000-0000-000000000000');
      const {data:assignments,error:ae}=await aq;if(ae)throw ae;
      let mq=db.from('masters').select('*').order('name',{ascending:true});
      if(!privileged){const masterIds=[...new Set((assignments||[]).map((x:any)=>x.master_id))];mq=masterIds.length?mq.in('id',masterIds):mq.eq('id','00000000-0000-0000-0000-000000000000')}
      const {data:masters,error:me}=await mq;if(me)throw me;
      let pmq=db.from('project_members').select('project_id,user_id,role');
      if(projectIds)pmq=projectIds.length?pmq.in('project_id',projectIds):pmq.eq('project_id','00000000-0000-0000-0000-000000000000');
      const {data:members,error:pme}=await pmq;if(pme)throw pme;
      const userIds=[...new Set((members||[]).map((x:any)=>x.user_id))];
      const {data:users,error:ue}=userIds.length?await db.from('app_users').select('id,first_name,last_name,telegram_username,web_login,role,is_active').in('id',userIds):{data:[],error:null};if(ue)throw ue;
      return json({ok:true,masters:masters||[],assignments:assignments||[],project_responsibles:(members||[]).map((member:any)=>({...member,user:(users||[]).find((x:any)=>x.id===member.user_id)||null}))});
    }

    if(!privileged)return json({error:'forbidden'},403);

    if(action==='save_master'){
      const value=masterInput(body.master);let data,error;
      if(body.master?.id)({data,error}=await db.from('masters').update({...value,updated_at:new Date().toISOString()}).eq('id',id(body.master.id)).select('*').single());
      else({data,error}=await db.from('masters').insert({...value,created_by:user.id}).select('*').single());
      if(error)throw error;return json({ok:true,master:data});
    }
    if(action==='set_master_archived'){
      const masterId=id(body.id),isActive=!body.archived;
      const {data,error}=await db.from('masters').update({is_active:isActive,updated_at:new Date().toISOString()}).eq('id',masterId).select('*').single();if(error)throw error;
      return json({ok:true,master:data});
    }
    if(action==='save_assignment'){
      const value=assignmentInput(body.assignment);
      const [{data:master,error:me},{data:project,error:pe}]=await Promise.all([db.from('masters').select('id,is_active').eq('id',value.master_id).single(),db.from('projects').select('id').eq('id',value.project_id).single()]);if(me)throw me;if(pe)throw pe;if(!master.is_active)return json({error:'master_archived'},400);
      if(value.stage_id){const {data:stage,error}=await db.from('project_stages').select('id,project_id').eq('id',value.stage_id).single();if(error)throw error;if(stage.project_id!==value.project_id)return json({error:'stage_project_mismatch'},400)}
      if(['planned','active'].includes(value.status)&&!body.allow_conflict){
        const searchEnd=value.planned_end_date||'9999-12-31';let cq=db.from('master_assignments').select('id,project_id,stage_id,start_date,planned_end_date,status').eq('master_id',value.master_id).neq('project_id',value.project_id).in('status',['planned','active']).lte('start_date',searchEnd).or(`planned_end_date.is.null,planned_end_date.gte.${value.start_date}`);
        if(body.assignment?.id)cq=cq.neq('id',id(body.assignment.id));const {data:conflicts,error:ce}=await cq;if(ce)throw ce;if((conflicts||[]).length)return json({error:'assignment_conflict',conflicts},409);
      }
      let data,error;if(body.assignment?.id)({data,error}=await db.from('master_assignments').update({...value,updated_at:new Date().toISOString()}).eq('id',id(body.assignment.id)).select('*').single());else({data,error}=await db.from('master_assignments').insert({...value,created_by:user.id}).select('*').single());if(error)throw error;
      return json({ok:true,assignment:data});
    }
    if(action==='cancel_assignment'){
      const assignmentId=id(body.id);const {data,error}=await db.from('master_assignments').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('id',assignmentId).select('*').single();if(error)throw error;return json({ok:true,assignment:data});
    }
    return json({error:'unknown_action'},400);
  }catch(e){const message=e instanceof Error?e.message:'unknown_error';const bad=['required_field','field_too_long','too_many_skills','invalid_specialty','invalid_rating','invalid_price_level','invalid_assignment_status','invalid_assignment_dates','invalid_date','invalid_id'];return json({error:message},e instanceof AuthError?e.status:bad.includes(message)?400:500)}
});
