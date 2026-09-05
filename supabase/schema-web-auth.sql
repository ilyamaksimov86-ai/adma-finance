-- Additive extension. Existing users, roles, projects, expenses and storage are preserved.
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS web_login text;
ALTER TABLE public.app_users ALTER COLUMN telegram_user_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_web_login_unique ON public.app_users(web_login) WHERE web_login IS NOT NULL;
