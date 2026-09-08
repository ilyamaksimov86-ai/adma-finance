# Security backlog

## Supabase Auth leaked-password protection

Supabase currently reports the optional leaked-password protection recommendation. It should be enabled in a planned authentication maintenance window after confirming the effect on existing web accounts, password reset flow and user messaging. This hardening stage does not toggle the production setting automatically.

## Boundaries kept in this stage

- Browser code continues to call authenticated Edge Functions and has no direct database client.
- Storage buckets remain private; signed URLs remain temporary access artifacts only.
- `storage_cleanup_queue` has RLS enabled and no client policies; `anon` and `authenticated` grants are revoked.
- The cleanup cron secret is generated and read only inside Supabase Vault.
- The secret verifier is executable only by `service_role`; that key is used only inside Edge Functions.
