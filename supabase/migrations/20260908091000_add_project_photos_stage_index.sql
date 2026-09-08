-- Cover the stage foreign key independently for SET NULL and stage-filter operations.
create index if not exists idx_project_photos_stage on public.project_photos(stage_id);
