create table if not exists wallets (
  role text primary key,
  address text not null
);

create table if not exists manager_state (
  id int primary key default 1 check (id = 1),
  running boolean not null default false,
  cycle_id bigint,
  next_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into manager_state (id) values (1) on conflict do nothing;

create table if not exists cycles (
  id bigserial primary key,
  phase text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  weights_before jsonb not null,
  weights_after jsonb,
  strategies jsonb,
  trends jsonb,
  rationale text,
  source text,
  moves jsonb,
  error text
);

create table if not exists reports (
  cycle_id bigint not null references cycles(id),
  role text not null,
  phase text not null,
  wallet bigint not null,
  deposited bigint not null,
  withdrawn bigint not null,
  pnl bigint not null,
  trades int not null,
  experience text not null,
  created_at timestamptz not null default now(),
  primary key (cycle_id, role)
);

create table if not exists transfers (
  id text primary key,
  cycle_id bigint,
  kind text not null,
  from_role text not null,
  to_role text not null,
  to_address text not null,
  amount bigint not null,
  status text not null,
  tx_id text,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_state (
  role text primary key,
  phase text not null,
  cycle_id bigint,
  strategy jsonb,
  deposited bigint not null default 0,
  withdrawn bigint not null default 0,
  experience text not null default '',
  updated_at timestamptz not null default now()
);
alter table agent_state add column if not exists thought jsonb;

create table if not exists broker_accounts (
  role text primary key,
  cash bigint not null default 0,
  qty double precision not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists broker_credits (
  tx_id text primary key,
  role text not null,
  amount bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists broker_orders (
  id bigserial primary key,
  role text not null,
  cycle_id bigint,
  side text not null,
  qty double precision not null,
  price double precision not null,
  cash bigint not null,
  fee bigint not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists broker_orders_role_cycle on broker_orders (role, cycle_id);

create table if not exists prices (
  asset text not null,
  at timestamptz not null,
  price double precision not null,
  primary key (asset, at)
);

create table if not exists value_snapshots (
  id bigserial primary key,
  role text not null,
  at timestamptz not null default now(),
  cash bigint not null,
  qty double precision not null,
  price double precision not null,
  value bigint not null
);
create index if not exists value_snapshots_role_at on value_snapshots (role, at);
