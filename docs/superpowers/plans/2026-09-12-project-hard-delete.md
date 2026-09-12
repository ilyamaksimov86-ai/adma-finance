# Project Hard Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-only, explicitly confirmed, transactional permanent project deletion while preserving Leads and deferring physical file removal through the existing cleanup queue.

**Architecture:** The browser opens a dedicated typed-confirmation dialog and calls one `delete_project` API action. The Edge Function authorizes the owner and invokes one service-role-only PostgreSQL RPC; PostgreSQL locks the project, validates the actor and exact name, queues every project-owned file path, deletes RESTRICT children, and deletes the project so existing CASCADE and SET NULL constraints complete atomically.

**Tech Stack:** Vanilla browser JavaScript, Deno/Supabase Edge Functions, PostgreSQL/PLpgSQL, Node test runner, Playwright smoke harness.

**Spec:** `/Users/ilamaksimov/.codex/attachments/6eb20ef4-3a06-4d62-8a1e-b6edfce3b1d5/pasted-text.txt`

## Global Constraints

- Production UI behavior outside project deletion must remain unchanged.
- Only owners may see or invoke project hard delete; partners and foremen must be denied.
- Confirmation must exactly match the current project name.
- Database deletion and cleanup-queue inserts must happen in one transaction.
- `adma-backups` must never be queued or removed.
- Leads must survive with `project_id = NULL`.
- No bulk delete, recycle bin, soft-delete redesign, migration changes outside this feature, or synchronous Storage deletion.

---

### Task 1: Specify API and browser behavior

**Files:**
- Modify: `tests/edge.test.mjs`
- Modify: `tests/smoke.cjs`
- Create: `tests/project-delete.test.mjs`

**Interfaces:**
- Consumes: existing Edge handler test doubles and browser smoke API mock.
- Produces: failing tests for owner-only RPC invocation, exact confirmation, atomic error handling, local-state removal, and the SQL migration contract.

- [ ] Add focused tests that fail because `delete_project`, its modal, and its RPC do not exist.
- [ ] Run focused tests and confirm failures are caused by the missing feature.

### Task 2: Add the transactional database boundary

**Files:**
- Create: `supabase/migrations/20260912120000_add_project_hard_delete.sql`

**Interfaces:**
- Consumes: `public.app_users`, `public.projects`, project child tables, and `public.storage_cleanup_queue`.
- Produces: `public.hard_delete_project(uuid, uuid, text)` returning one aggregate result row; executable only by `service_role`.

- [ ] Implement owner validation, `FOR UPDATE`, exact-name validation, distinct cleanup queue inserts for `receipts`, `finance-documents`, and `project-files`, explicit RESTRICT-child deletes, and final project delete.
- [ ] Add explicit function privilege revocation and service-role grant.
- [ ] Run the migration contract test until green.

### Task 3: Add the server-only API action

**Files:**
- Modify: `supabase/functions/adma-api/index.ts`
- Modify: `contracts/api-contracts.json`
- Modify: `tests/edge.test.mjs`

**Interfaces:**
- Consumes: request `{action:"delete_project", project_id:string, confirmation:string}` and authenticated `user.id`.
- Produces: `{ok:true, project_id, cleanup_queued}` or an error response; calls only `hard_delete_project` for mutation.

- [ ] Implement exact input validation and an explicit `user.role === "owner"` authorization gate.
- [ ] Call the RPC with project ID, actor ID, and unmodified confirmation text; expose no file paths.
- [ ] Document the action contract and run Edge/contract checks until green.

### Task 4: Add the owner-only confirmation UI

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `src/cloud/projects.fragment.js`
- Regenerate: `cloud.js`
- Modify: `tests/smoke.cjs`

**Interfaces:**
- Consumes: the current edited project and `api('delete_project', ...)`.
- Produces: owner-only danger zone, separate modal, exact-name button gating, local in-memory cleanup, modal close, projects-list navigation, and success notification without `loadCloud`.

- [ ] Render the danger zone only for owners while editing an existing project.
- [ ] Implement the destructive-content warning and exact-name confirmation state.
- [ ] On success, remove project-owned local records, preserve Leads while nulling their project link, close dialogs, navigate to the project list, save/render state, and notify success.
- [ ] Build `cloud.js` and run browser smoke tests until green.

### Task 5: Verify, review, deploy, and integrate

**Files:**
- Review all changed files; make no unrelated changes.

**Interfaces:**
- Consumes: completed feature branch.
- Produces: green checks, independent security/code review, production migration and Edge Function deployment without a delete invocation, merged PR, and clean updated `main`.

- [ ] Run `npm run check` and `npm test` and record exact totals.
- [ ] Review authorization, transactional semantics, actual FK behavior, cleanup coverage, confirmation, finance/PDF regressions, and diff scope.
- [ ] Apply only the additive migration and deploy only `adma-api`; verify metadata and unchanged business counts without calling deletion.
- [ ] Create the PR, wait for GitHub Actions PASS, merge, update local `main`, and verify clean status and the new checkpoint.
