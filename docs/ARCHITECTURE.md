# ADMA Dashboard architecture

## Frontend source

`cloud.js` is a generated browser bundle retained for build-free GitHub Pages delivery. It must not be edited directly.

The authored source lives in `src/cloud/*.fragment.js`:

- `platform` — authentication lifecycle, routing composition and bootstrap;
- `shared` — API transport, shared mapping and small UI utilities;
- `dashboard` — company dashboard;
- `projects` — projects, schedule and project navigation;
- `finance` — acts, waybills, receipts, company expenses and PDF;
- `masters` — masters and assignments;
- `operations` — documents, tasks and photos;
- `designers` — designer CRM;
- `leads` — lead CRM and conversion.

Fragments are ordered source units composed by `npm run frontend:build`. Feature state and handlers belong to their feature source. Platform calls only named feature entry points; feature sources do not import each other's internals. Cross-feature relations use canonical IDs in shared application state and the shared navigation/API boundaries.

`npm run architecture:check` verifies the module inventory and size limits, prevents feature imports from shared/platform, rejects direct database calls in browser code, rejects business actions in platform, and verifies that `cloud.js` matches its source.

## API contracts

`contracts/api-contracts.json` is the checked source of truth for Edge Function action names, required request fields, response fields and the common error envelope. Existing actions and response fields are backward-compatible. Contract changes are additive unless a new versioned endpoint is introduced.

`npm run contracts:check` compares documented command actions with the deployed function source.

## Storage cleanup

Storage bytes remain in private Supabase buckets. Deletion APIs first delete the authorized business record and then remove its storage object. A failed storage removal is recorded in the private `storage_cleanup_queue`; the API returns the additive `cleanup_pending: true` field while the business deletion remains successful.

An hourly Supabase Cron job invokes the `storage-cleanup` Edge Function. Cron authorization is generated in Supabase Vault. The worker accepts no user-selected paths, processes only due queue rows, treats an absent object as successful through the Storage remove API, closes successful rows and applies capped exponential backoff after failures. Logs contain counts and error classes, not secrets or object paths.
