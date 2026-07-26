create table if not exists users (
  id text primary key,
  login_provider text not null
    check (login_provider in ('TEST', 'KAKAO', 'NAVER', 'GOOGLE')),
  login_id text,
  password_hash text,
  nickname varchar(20) not null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists users_test_login_id_unique
  on users (lower(login_id))
  where login_provider = 'TEST' and login_id is not null;

create table if not exists auth_sessions (
  access_token text primary key,
  refresh_token text unique,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists auth_sessions_user_id_idx
  on auth_sessions(user_id);

create table if not exists places (
  id text primary key,
  naver_place_id text not null unique,
  name text not null,
  category text not null,
  address text not null,
  road_address text not null,
  latitude double precision not null,
  longitude double precision not null,
  station text not null default '',
  distance_text text not null default '',
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_places (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  place_id text not null references places(id) on delete restrict,
  purpose text not null check (purpose in ('STUDY', 'CAFE', 'MEAL', 'DRINK')),
  mood text not null check (mood in ('FUN', 'QUIET', 'BUSINESS', 'TIPSY')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, place_id)
);

create index if not exists user_places_user_active_idx
  on user_places(user_id, is_active);

create table if not exists meetings (
  id text primary key,
  name varchar(20) not null,
  host_user_id text not null references users(id) on delete restrict,
  capacity integer not null check (capacity >= 2),
  meeting_at timestamptz not null,
  purpose text not null check (purpose in ('STUDY', 'CAFE', 'MEAL', 'DRINK')),
  mood text not null check (mood in ('FUN', 'QUIET', 'BUSINESS', 'TIPSY')),
  join_code char(4) not null check (join_code ~ '^[0-9]{4}$'),
  status text not null
    check (status in ('RECRUITING', 'VOTING', 'FINAL_SELECTION', 'COMPLETED', 'DELETED')),
  final_candidate_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists meetings_active_join_code_unique
  on meetings(join_code)
  where status in ('RECRUITING', 'VOTING', 'FINAL_SELECTION');

create index if not exists meetings_host_user_id_idx
  on meetings(host_user_id);

create table if not exists meeting_members (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  meeting_nickname varchar(20) not null,
  role text not null check (role in ('HOST', 'MEMBER')),
  status text not null check (status in ('ACTIVE', 'LEFT', 'KICKED')),
  joined_at timestamptz not null default now(),
  unique (meeting_id, user_id)
);

create index if not exists meeting_members_meeting_status_idx
  on meeting_members(meeting_id, status);

create table if not exists meeting_candidates (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  place_id text not null references places(id) on delete restrict,
  is_frozen boolean not null default false,
  unique (meeting_id, place_id)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meetings_final_candidate_fk'
  ) then
    alter table meetings
      add constraint meetings_final_candidate_fk
      foreign key (final_candidate_id)
      references meeting_candidates(id)
      on delete set null
      deferrable initially deferred;
  end if;
end
$$;

create table if not exists candidate_recommendations (
  candidate_id text not null references meeting_candidates(id) on delete cascade,
  member_id text not null references meeting_members(id) on delete cascade,
  user_place_id text not null references user_places(id) on delete restrict,
  purpose text not null check (purpose in ('STUDY', 'CAFE', 'MEAL', 'DRINK')),
  mood text not null check (mood in ('FUN', 'QUIET', 'BUSINESS', 'TIPSY')),
  created_at timestamptz not null default now(),
  primary key (candidate_id, member_id)
);

create table if not exists votes (
  id text primary key,
  meeting_id text not null unique references meetings(id) on delete cascade,
  status text not null check (status in ('OPEN', 'FINAL_SELECTION', 'CLOSED')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists vote_sessions (
  id text primary key,
  vote_id text not null references votes(id) on delete cascade,
  meeting_id text not null references meetings(id) on delete cascade,
  member_id text not null references meeting_members(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  status text not null check (status in ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')),
  total_rounds integer not null check (total_rounds >= 1),
  completed_rounds integer not null default 0 check (completed_rounds >= 0),
  candidate_order text[] not null,
  current_winner_candidate_id text references meeting_candidates(id) on delete restrict,
  updated_at timestamptz not null default now(),
  unique (vote_id, member_id)
);

create index if not exists vote_sessions_meeting_user_idx
  on vote_sessions(meeting_id, user_id);

create table if not exists vote_choices (
  session_id text not null references vote_sessions(id) on delete cascade,
  round_number integer not null check (round_number >= 1),
  candidate_a_id text not null references meeting_candidates(id) on delete restrict,
  candidate_b_id text not null references meeting_candidates(id) on delete restrict,
  selected_candidate_id text not null references meeting_candidates(id) on delete restrict,
  selected_at timestamptz not null default now(),
  primary key (session_id, round_number)
);

alter table users enable row level security;
alter table auth_sessions enable row level security;
alter table places enable row level security;
alter table user_places enable row level security;
alter table meetings enable row level security;
alter table meeting_members enable row level security;
alter table meeting_candidates enable row level security;
alter table candidate_recommendations enable row level security;
alter table votes enable row level security;
alter table vote_sessions enable row level security;
alter table vote_choices enable row level security;

revoke all on users, auth_sessions, places, user_places, meetings,
  meeting_members, meeting_candidates, candidate_recommendations,
  votes, vote_sessions, vote_choices
from anon, authenticated;
