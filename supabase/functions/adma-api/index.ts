import { requireUser, AuthError } from '../_shared/auth.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
function decodeDataUrl(dataUrl:string){const m=dataUrl.match(/^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([A-Za-z0-9+/=]+)$/);if(!m)throw new Error("invalid_receipt_image");const mime=m[1],bin=atob(m[2]);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);if(bytes.byteLength>8*1024*1024)throw new Error("receipt_too_large");const ext=mime==="image/jpeg"?"jpg":mime.split("/")[1];return {mime,bytes,ext}}
const roles=new Set(["owner","partner","foreman"]);

Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"method_not_allowed"},405);
  const botToken=Deno.env.get("TELEGRAM_BOT_TOKEN");
  try{
    const body=await req.json();
    const db=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
    const user=await requireUser(db,body,botToken);
    const action=String(body?.action||"load"),privileged=user.role==="owner"||user.role==="partner";
    const allowedProjectIds=async()=>{if(privileged)return null;const {data,error}=await db.from("project_members").select("project_id").eq("user_id",user.id);if(error)throw error;return(data||[]).map((x:any)=>x.project_id)};
    const canAccessProject=async(projectId:string)=>{if(privileged)return true;const ids=await allowedProjectIds();return(ids||[]).includes(projectId)};

    if(action==="load"){
      const ids=await allowedProjectIds();let pq=db.from("projects").select("*").order("created_at",{ascending:true});if(ids)pq=ids.length?pq.in("id",ids):pq.eq("id","00000000-0000-0000-0000-000000000000");const {data:projects,error:pe}=await pq;if(pe)throw pe;
      let eq=db.from("expenses").select("*").order("expense_date",{ascending:false});if(ids)eq=ids.length?eq.in("project_id",ids):eq.eq("project_id","00000000-0000-0000-0000-000000000000");const {data:expenses,error:ee}=await eq;if(ee)throw ee;
      await Promise.all((expenses||[]).map(async(e:any)=>{if(e.receipt_path){const {data}=await db.storage.from("receipts").createSignedUrl(e.receipt_path,3600);e.receipt_url=data?.signedUrl||null}else e.receipt_url=null}));
      return json({ok:true,role:user.role,current_user:user,projects,expenses});
    }

    if(action==="list_users"){
      if(user.role!=="owner")return json({error:"forbidden"},403);
      const {data:users,error:ue}=await db.from("app_users").select("id,telegram_user_id,telegram_username,first_name,last_name,role,is_active,web_login,created_at,updated_at").order("created_at",{ascending:true});if(ue)throw ue;
      const {data:members,error:me}=await db.from("project_members").select("project_id,user_id,role");if(me)throw me;
      return json({ok:true,users:(users||[]).map((u:any)=>({...u,project_ids:(members||[]).filter((m:any)=>m.user_id===u.id).map((m:any)=>m.project_id)}))});
    }

    if(action==="update_user_access"){
      if(user.role!=="owner")return json({error:"forbidden"},403);
      const targetId=String(body?.user_id||"");if(!targetId)return json({error:"user_id_required"},400);
      const role=String(body?.role||"");if(!roles.has(role))return json({error:"invalid_role"},400);
      const isActive=!!body?.is_active;
      if(targetId===user.id&&(role!=="owner"||!isActive))return json({error:"cannot_lock_yourself_out"},400);
      const {data:updated,error}=await db.from("app_users").update({role,is_active:isActive,updated_at:new Date().toISOString()}).eq("id",targetId).select("id,telegram_user_id,telegram_username,first_name,last_name,role,is_active").single();if(error)throw error;
      if(role!=="foreman")await db.from("project_members").delete().eq("user_id",targetId);
      return json({ok:true,user:updated});
    }

    if(action==="set_project_members"){
      if(user.role!=="owner")return json({error:"forbidden"},403);
      const targetId=String(body?.user_id||"");if(!targetId)return json({error:"user_id_required"},400);
      const {data:target,error:te}=await db.from("app_users").select("id,role").eq("id",targetId).single();if(te)throw te;
      const raw=Array.isArray(body?.project_ids)?body.project_ids:[];const projectIds=[...new Set(raw.map((x:any)=>String(x)).filter(Boolean))];
      const {error:de}=await db.from("project_members").delete().eq("user_id",targetId);if(de)throw de;
      if(target.role==="foreman"&&projectIds.length){const {data:valid,error:ve}=await db.from("projects").select("id").in("id",projectIds);if(ve)throw ve;const validIds=(valid||[]).map((x:any)=>x.id);if(validIds.length!==projectIds.length)return json({error:"invalid_project"},400);const rows=validIds.map((project_id:string)=>({project_id,user_id:targetId,role:"member"}));const {error:ie}=await db.from("project_members").insert(rows);if(ie)throw ie;}
      return json({ok:true,project_ids:target.role==="foreman"?projectIds:[]});
    }

    if(action==="sign_receipt"){
      const ext=String(body?.ext||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"");const safeExt=["jpg","jpeg","png","webp","heic","heif"].includes(ext)?ext:"jpg";const path=`${user.id}/${crypto.randomUUID()}.${safeExt}`;const {data,error}=await db.storage.from("receipts").createSignedUploadUrl(path,{upsert:false});if(error)throw error;return json({ok:true,path,token:data.token});
    }
    if(action==="upload_receipt"){
      const {mime,bytes,ext}=decodeDataUrl(String(body?.data_url||""));const path=`${user.id}/${crypto.randomUUID()}.${ext}`;const {error}=await db.storage.from("receipts").upload(path,bytes,{contentType:mime,cacheControl:"3600",upsert:false});if(error)throw error;const {data:signed}=await db.storage.from("receipts").createSignedUrl(path,3600);return json({ok:true,path,url:signed?.signedUrl||null});
    }

    if(action==="create_project"){
      if(!privileged)return json({error:"forbidden"},403);const p=body.project||{};if(!String(p.name||"").trim())return json({error:"name_required"},400);const {data,error}=await db.from("projects").insert({name:String(p.name).trim(),address:p.address||null,client_name:p.client_name||null,comment:p.comment||null,status:p.status==="archived"?"archived":"active",created_by:user.id}).select("*").single();if(error)throw error;return json({ok:true,project:data});
    }
    if(action==="update_project"){
      if(!privileged)return json({error:"forbidden"},403);const p=body.project||{};if(!p.id)return json({error:"id_required"},400);const patch:any={updated_at:new Date().toISOString()};for(const k of ["name","address","client_name","comment","status"])if(k in p)patch[k]=p[k];if("name" in patch&&!String(patch.name||"").trim())return json({error:"name_required"},400);if("status" in patch&&!['active','archived'].includes(patch.status))return json({error:"invalid_status"},400);const {data,error}=await db.from("projects").update(patch).eq("id",p.id).select("*").single();if(error)throw error;return json({ok:true,project:data});
    }
    if(action==="create_expense"){
      const e=body.expense||{};if(!e.project_id||!(await canAccessProject(e.project_id)))return json({error:"forbidden"},403);const amount=Number(e.amount||0);if(!Number.isFinite(amount)||amount<=0)return json({error:"amount_must_be_positive"},400);const paidBy=e.paid_by==="client"?"client":"adma";const reimbursementRequired=paidBy==="adma"&&!!e.reimbursement_required;const reimbursed=reimbursementRequired&&!!e.reimbursed;const {data,error}=await db.from("expenses").insert({project_id:e.project_id,amount,expense_date:e.expense_date,category:e.category||"Прочее",supplier:e.supplier||null,paid_by:paidBy,reimbursement_required:reimbursementRequired,reimbursed,reimbursed_at:reimbursed?new Date().toISOString():null,comment:e.comment||null,receipt_path:e.receipt_path||null,created_by:user.id}).select("*").single();if(error)throw error;return json({ok:true,expense:data});
    }
    if(action==="update_expense"){
      const e=body.expense||{};if(!e.id)return json({error:"id_required"},400);const {data:old,error:oldErr}=await db.from("expenses").select("project_id,receipt_path,paid_by,reimbursement_required,reimbursed").eq("id",e.id).single();if(oldErr)throw oldErr;if(!(await canAccessProject(old.project_id)))return json({error:"forbidden"},403);if(e.project_id&&!(await canAccessProject(e.project_id)))return json({error:"forbidden"},403);
      const patch:any={updated_at:new Date().toISOString()};for(const k of ["project_id","amount","expense_date","category","supplier","paid_by","reimbursement_required","reimbursed","comment","receipt_path"])if(k in e)patch[k]=e[k];if("amount" in patch){patch.amount=Number(patch.amount);if(!Number.isFinite(patch.amount)||patch.amount<=0)return json({error:"amount_must_be_positive"},400)}
      const finalPaidBy=("paid_by" in patch?(patch.paid_by==="client"?"client":"adma"):old.paid_by);patch.paid_by=finalPaidBy;const requestedReq=("reimbursement_required" in patch?!!patch.reimbursement_required:!!old.reimbursement_required);const finalReq=finalPaidBy==="adma"&&requestedReq;patch.reimbursement_required=finalReq;const requestedReimb=("reimbursed" in patch?!!patch.reimbursed:!!old.reimbursed);const finalReimb=finalReq&&requestedReimb;patch.reimbursed=finalReimb;patch.reimbursed_at=finalReimb?new Date().toISOString():null;
      const {data,error}=await db.from("expenses").update(patch).eq("id",e.id).select("*").single();if(error)throw error;if(old.receipt_path&&("receipt_path" in patch)&&old.receipt_path!==patch.receipt_path)await db.storage.from("receipts").remove([old.receipt_path]);return json({ok:true,expense:data});
    }
    if(action==="mark_reimbursed"){
      const id=String(body.id||"");const {data:old,error:oldErr}=await db.from("expenses").select("project_id,paid_by,reimbursement_required").eq("id",id).single();if(oldErr)throw oldErr;if(!(await canAccessProject(old.project_id)))return json({error:"forbidden"},403);if(old.paid_by!=="adma"||!old.reimbursement_required)return json({error:"not_reimbursable"},400);const {data,error}=await db.from("expenses").update({reimbursed:true,reimbursed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id).select("*").single();if(error)throw error;return json({ok:true,expense:data});
    }
    if(action==="delete_expense"){
      const id=String(body.id||"");const {data:old,error:oldErr}=await db.from("expenses").select("project_id,receipt_path").eq("id",id).single();if(oldErr)throw oldErr;if(!(await canAccessProject(old.project_id)))return json({error:"forbidden"},403);const {error}=await db.from("expenses").delete().eq("id",id);if(error)throw error;if(old.receipt_path)await db.storage.from("receipts").remove([old.receipt_path]);return json({ok:true});
    }
    return json({error:"unknown_action"},400);
  }catch(e){const message=e instanceof Error?e.message:"unknown_error";const authErrors=["missing_hash","bad_signature","expired_init_data","missing_user"];return json({error:message},e instanceof AuthError?e.status:authErrors.includes(message)?401:500)}
});
