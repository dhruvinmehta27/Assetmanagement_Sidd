-- Run after 2026-08-20-corporate-actions.sql to confirm it applied.
-- Paste into the Supabase SQL Editor. Expected results are on each block.

-- Should return 9 rows: the columns the migration adds.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_name = 'corporate_actions'
   and column_name in ('ratio_from','ratio_to','target_isin','target_symbol',
                       'target_security_name','target_key','cost_fraction',
                       'price_per_share','quantity')
 order by column_name;

-- quantity_multiplier must now be nullable (is_nullable = YES).
select column_name, is_nullable
  from information_schema.columns
 where table_name = 'corporate_actions' and column_name = 'quantity_multiplier';

-- Should return NO rows: the two old CHECK constraints must be gone.
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'corporate_actions' and con.contype = 'c';

-- Should show the key including target_key.
select pg_get_constraintdef(con.oid) as unique_key
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
 where rel.relname = 'corporate_actions' and con.contype = 'u';
