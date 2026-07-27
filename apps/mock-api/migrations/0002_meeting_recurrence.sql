alter table meetings
  add column if not exists series_id text,
  add column if not exists parent_meeting_id text,
  add column if not exists recurrence_type text,
  add column if not exists recurrence_next_at timestamptz,
  add column if not exists next_meeting_id text;

alter table meetings
  drop constraint if exists meetings_recurrence_type_check;

alter table meetings
  add constraint meetings_recurrence_type_check
  check (
    recurrence_type is null
    or recurrence_type in ('WEEKLY', 'MONTHLY', 'CUSTOM')
  );

create index if not exists meetings_series_id_idx
  on meetings(series_id);

create unique index if not exists meetings_parent_meeting_id_unique
  on meetings(parent_meeting_id)
  where parent_meeting_id is not null;
