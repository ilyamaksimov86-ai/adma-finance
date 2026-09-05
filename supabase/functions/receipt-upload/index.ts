import { requireUser, credentialsFromForm, AuthError } from '../_shared/auth.mjs';
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json" },
});
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");


  try {
    const form = await req.formData();
    const initData = String(form.get("initData") || "");
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "file_required" }, 400);

    const name = (file.name || "").toLowerCase();
    const isKnownImageName = /\.(jpe?g|png|webp|heic|heif)$/.test(name);
    if (!(file.type || "").startsWith("image/") && !isKnownImageName) return json({ error: "image_required" }, 400);
    if (file.size > 8 * 1024 * 1024) return json({ error: "receipt_too_large" }, 413);


    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const user = await requireUser(db, credentialsFromForm(form), botToken);

    const type = (file.type || "").toLowerCase();
    let ext = "jpg";
    if (type === "image/png" || name.endsWith(".png")) ext = "png";
    else if (type === "image/webp" || name.endsWith(".webp")) ext = "webp";
    else if (type === "image/heic" || name.endsWith(".heic")) ext = "heic";
    else if (type === "image/heif" || name.endsWith(".heif")) ext = "heif";
    const contentType = type || (ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "heic" ? "image/heic" : ext === "heif" ? "image/heif" : "image/jpeg");

    const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: uploadErr } = await db.storage.from("receipts").upload(path, bytes, {
      contentType,
      cacheControl: "3600",
      upsert: false,
    });
    if (uploadErr) throw uploadErr;

    return json({ ok: true, path });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown_error";
    const authErrors = ["missing_hash", "bad_signature", "expired_init_data", "missing_user"];
    return json({ error: message }, e instanceof AuthError ? e.status : authErrors.includes(message) ? 401 : 500);
  }
});
