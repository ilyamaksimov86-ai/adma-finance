create or replace function public.read_backup_live_schema()
returns table(table_name text,columns jsonb,numeric_columns text[],primary_key text[],foreign_keys jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join private.backup_table_registry b on b.table_name = c.relname
     where n.nspname = 'public' and c.relkind in ('r','p') and b.table_name is null
  ) then
    raise exception 'unclassified public tables';
  end if;
  if exists (
    select 1
      from private.backup_table_registry b
      join pg_catalog.pg_class c on c.relname = b.table_name
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where b.included
       and not (a.attname = any(b.excluded_columns))
       and a.attname ~* '(^|_)(password(_hash)?|token|secret|api_key|service_key|credential|encryption_key|private_key|signing_key|jwt(_secret|_key)?|session(_id|_key|_token)?|refresh_token|access_token)($|_)'
  ) then
    raise exception 'secret-like unclassified columns';
  end if;
  return query
  select b.table_name,
         (
           select jsonb_agg(jsonb_build_object(
                    'name',a.attname,
                    'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
                    'nullable',not a.attnotnull,
                    'ordinal',a.attnum
                  ) order by a.attnum)
             from pg_catalog.pg_attribute a
             join pg_catalog.pg_class c on c.oid = a.attrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = b.table_name
              and a.attnum > 0 and not a.attisdropped
              and not (a.attname = any(b.excluded_columns))
         ) as columns,
         coalesce((
           select array_agg(a.attname::text order by a.attnum)
             from pg_catalog.pg_attribute a
             join pg_catalog.pg_class c on c.oid = a.attrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             join pg_catalog.pg_type t on t.oid = a.atttypid
            where n.nspname = 'public' and c.relname = b.table_name
              and a.attnum > 0 and not a.attisdropped
              and not (a.attname = any(b.excluded_columns))
              and t.typname = 'numeric'
         ),'{}'::text[]) as numeric_columns,
         (
           select array_agg(a.attname::text order by k.ordinality)
             from pg_catalog.pg_constraint con
             join lateral unnest(con.conkey) with ordinality k(attnum,ordinality) on true
             join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
             join pg_catalog.pg_class c on c.oid = con.conrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where con.contype = 'p' and n.nspname = 'public' and c.relname = b.table_name
         ) as primary_key,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'name',con.conname,
                    'definition',pg_catalog.pg_get_constraintdef(con.oid,true),
                    'columns',(
                      select array_agg(local_attribute.attname order by local_key.ordinality)
                        from unnest(con.conkey) with ordinality local_key(attnum,ordinality)
                        join pg_catalog.pg_attribute local_attribute
                          on local_attribute.attrelid = con.conrelid
                         and local_attribute.attnum = local_key.attnum
                    ),
                    'referenced_schema',rn.nspname,
                    'referenced_table',rc.relname,
                    'referenced_columns',(
                      select array_agg(referenced_attribute.attname order by referenced_key.ordinality)
                        from unnest(con.confkey) with ordinality referenced_key(attnum,ordinality)
                        join pg_catalog.pg_attribute referenced_attribute
                          on referenced_attribute.attrelid = con.confrelid
                         and referenced_attribute.attnum = referenced_key.attnum
                    )
                  ) order by con.conname)
             from pg_catalog.pg_constraint con
             join pg_catalog.pg_class c on c.oid = con.conrelid
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             join pg_catalog.pg_class rc on rc.oid = con.confrelid
             join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
            where con.contype = 'f' and n.nspname = 'public' and c.relname = b.table_name
         ),'[]'::jsonb) as foreign_keys
   from private.backup_table_registry b
   where b.included
   order by b.table_name;
end;
$$;

revoke all on function public.read_backup_live_schema() from public, anon, authenticated;
grant execute on function public.read_backup_live_schema() to service_role;
