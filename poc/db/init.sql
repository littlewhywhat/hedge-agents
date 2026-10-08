CREATE DATABASE hedge;
CREATE DATABASE masumi;

\c hedge

CREATE TABLE funds (
  id text PRIMARY KEY,
  deposit_address text NOT NULL,
  environment text NOT NULL CHECK (environment = 'preprod'),
  unit text NOT NULL
);

CREATE TABLE agents (
  id text PRIMARY KEY,
  fund_id text NOT NULL REFERENCES funds (id),
  role text NOT NULL CHECK (role IN ('manager', 'crypto', 'stocks')),
  cardano_address text NOT NULL DEFAULT '',
  agent_identifier text NOT NULL DEFAULT '',
  market text,
  solana_address text,
  UNIQUE (fund_id, role)
);

CREATE TABLE snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id),
  sampled_at timestamptz NOT NULL,
  cardano_stablecoin bigint NOT NULL,
  solana_usdc bigint NOT NULL,
  token_usd bigint NOT NULL
);

CREATE TABLE rounds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fund_id text NOT NULL REFERENCES funds (id),
  week date NOT NULL,
  weights_before jsonb NOT NULL,
  weights_after jsonb NOT NULL,
  scores jsonb NOT NULL,
  opened_at timestamptz,
  settled_at timestamptz,
  UNIQUE (fund_id, week)
);

CREATE TABLE reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id bigint NOT NULL REFERENCES rounds (id),
  agent_id text NOT NULL REFERENCES agents (id),
  blockchain_identifier text,
  fee bigint NOT NULL,
  decayed_return double precision NOT NULL,
  volatility double precision NOT NULL,
  result_hash text,
  UNIQUE (round_id, agent_id)
);

CREATE TABLE transfers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id bigint REFERENCES rounds (id),
  from_agent_id text REFERENCES agents (id),
  to_agent_id text REFERENCES agents (id),
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  tx_id text,
  detail text,
  CHECK (from_agent_id IS NOT NULL OR to_agent_id IS NOT NULL)
);

CREATE UNIQUE INDEX transfers_round_legs
  ON transfers (round_id, COALESCE(from_agent_id, ''), COALESCE(to_agent_id, ''));

CREATE TABLE gateway (
  id text PRIMARY KEY,
  cardano_inventory bigint NOT NULL,
  solana_inventory bigint NOT NULL
);

CREATE TABLE facilitator_claims (
  transfer_id text PRIMARY KEY,
  from_role text NOT NULL,
  to_address text NOT NULL,
  amount bigint NOT NULL,
  payload jsonb,
  tx_id text,
  status text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO gateway (id, cardano_inventory, solana_inventory) VALUES ('gateway', 0, 0);
