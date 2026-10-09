from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, JSON, LargeBinary, String, Text, UniqueConstraint, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class Agent(Base):
    __tablename__ = "agents"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    market: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    environment: Mapped[str] = mapped_column(String)
    registry_id: Mapped[str | None] = mapped_column(String)
    details: Mapped[dict] = mapped_column(JSON, default=dict)


class Wallet(Base):
    __tablename__ = "wallets"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    agent_id: Mapped[str] = mapped_column(String, index=True)
    environment: Mapped[str] = mapped_column(String)
    chain: Mapped[str] = mapped_column(String)
    address: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)
    signer: Mapped[str] = mapped_column(String)
    belongs_to_fund: Mapped[bool] = mapped_column(Boolean)
    __table_args__ = (UniqueConstraint("environment", "chain", "address"), UniqueConstraint("agent_id", "environment", "chain", "role"))


class Controls(Base):
    __tablename__ = "controls"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    kill_switch: Mapped[bool] = mapped_column(Boolean, default=True)
    armed: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str] = mapped_column(Text, default="Awaiting integration qualification")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    state: Mapped[dict] = mapped_column(JSON, default=dict)


class Policy(Base):
    __tablename__ = "policies"
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    hash: Mapped[str] = mapped_column(String(64))
    body: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String, default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    activation_boundary: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    applied_round_id: Mapped[str | None] = mapped_column(String)


class AuditHead(Base):
    __tablename__ = "audit_heads"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    hash: Mapped[str] = mapped_column(String(64), default="0" * 64)


class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    time: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String, index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    prev_hash: Mapped[str] = mapped_column(String(64), unique=True)
    hash: Mapped[str] = mapped_column(String(64), unique=True)


class BookState(Base):
    __tablename__ = "books"
    agent_id: Mapped[str] = mapped_column(String, primary_key=True)
    body: Mapped[dict] = mapped_column(JSON, default=dict)


class AccountingEntry(Base):
    __tablename__ = "accounting_entries"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    owner: Mapped[str] = mapped_column(String, index=True)
    proof: Mapped[str] = mapped_column(String)
    component: Mapped[str] = mapped_column(String)
    body: Mapped[dict] = mapped_column(JSON)
    recognized_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (UniqueConstraint("owner", "proof", "component"),)


class Intent(Base):
    __tablename__ = "transfer_intents"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    environment: Mapped[str] = mapped_column(String)
    buyer_id: Mapped[str] = mapped_column(String)
    request_id: Mapped[str] = mapped_column(String)
    direction: Mapped[str] = mapped_column(String)
    terms: Mapped[dict] = mapped_column(JSON)
    terms_hash: Mapped[str] = mapped_column(String(64))
    amount_raw: Mapped[int] = mapped_column(BigInteger)
    state: Mapped[str] = mapped_column(String, default="reserved", index=True)
    reserved: Mapped[bool] = mapped_column(Boolean, default=True)
    protected: Mapped[bool] = mapped_column(Boolean, default=False)
    fee_state: Mapped[str] = mapped_column(String, default="not_created")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    receipt_id: Mapped[str | None] = mapped_column(String)
    source_attempt_id: Mapped[str | None] = mapped_column(String)
    payout_attempt_id: Mapped[str | None] = mapped_column(String)
    refund_attempt_id: Mapped[str | None] = mapped_column(String)
    result: Mapped[dict | None] = mapped_column(JSON)
    reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("environment", "buyer_id", "request_id"),)


class ReceiptClaim(Base):
    __tablename__ = "receipt_claims"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    environment: Mapped[str] = mapped_column(String)
    chain: Mapped[str] = mapped_column(String)
    tx_id: Mapped[str] = mapped_column(String)
    locator: Mapped[str] = mapped_column(String)
    intent_id: Mapped[str] = mapped_column(String)
    proof: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint("environment", "chain", "tx_id", "locator"),)


class ChainAttempt(Base):
    __tablename__ = "chain_attempts"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    wallet_id: Mapped[str] = mapped_column(ForeignKey("wallets.id"))
    parent_id: Mapped[str] = mapped_column(String, index=True)
    leg: Mapped[str] = mapped_column(String)
    number: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String, default="prepared")
    chain: Mapped[str] = mapped_column(String)
    tx_id: Mapped[str] = mapped_column(String, unique=True)
    signed_bytes: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    request_id: Mapped[str | None] = mapped_column(String)
    validity: Mapped[dict] = mapped_column(JSON)
    reserved_inputs: Mapped[list] = mapped_column(JSON, default=list)
    confirmation: Mapped[dict | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        UniqueConstraint("wallet_id", "parent_id", "leg", "number"),
        Index("one_unresolved_attempt_per_wallet", "wallet_id", unique=True,
              postgresql_where=text("state IN ('prepared', 'submitted', 'unknown')"),
              sqlite_where=text("state IN ('prepared', 'submitted', 'unknown')")),
    )


class Inventory(Base):
    __tablename__ = "inventory"
    chain: Mapped[str] = mapped_column(String, primary_key=True)
    confirmed_raw: Mapped[int] = mapped_column(BigInteger, default=0)
    reserved_raw: Mapped[int] = mapped_column(BigInteger, default=0)
    protected_raw: Mapped[int] = mapped_column(BigInteger, default=0)
    low_water_raw: Mapped[int] = mapped_column(BigInteger, default=20_000_000)
    sampled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GatewayQuota(Base):
    __tablename__ = "gateway_quota"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    day: Mapped[str] = mapped_column(String)
    settled_raw: Mapped[int] = mapped_column(BigInteger, default=0)
    active_raw: Mapped[int] = mapped_column(BigInteger, default=0)


class MasumiJob(Base):
    __tablename__ = "masumi_jobs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    intent_id: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    buyer: Mapped[str] = mapped_column(String)
    seller: Mapped[str] = mapped_column(String)
    nonce: Mapped[str] = mapped_column(String, unique=True)
    source_index: Mapped[int | None] = mapped_column(Integer)
    blockchain_identifier: Mapped[str | None] = mapped_column(String, unique=True)
    terms: Mapped[dict] = mapped_column(JSON)
    input: Mapped[dict] = mapped_column(JSON)
    input_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String, default="created")
    price_raw: Mapped[int] = mapped_column(BigInteger)
    result: Mapped[str | None] = mapped_column(Text)
    result_hash: Mapped[str | None] = mapped_column(String(64))
    audit_head: Mapped[str | None] = mapped_column(String(64))


class Decision(Base):
    __tablename__ = "decisions"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agent_id: Mapped[str] = mapped_column(String, index=True)
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    policy_version: Mapped[int] = mapped_column(Integer)
    body: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String)


class Transfer(Base):
    __tablename__ = "transfers"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    environment: Mapped[str] = mapped_column(String)
    chain: Mapped[str] = mapped_column(String)
    tx_id: Mapped[str] = mapped_column(String)
    locator: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    body: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint("environment", "chain", "tx_id", "locator"),)


class Trade(Base):
    __tablename__ = "trades"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agent_id: Mapped[str] = mapped_column(String)
    signature: Mapped[str] = mapped_column(String)
    locator: Mapped[str] = mapped_column(String, default="swap")
    body: Mapped[dict] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint("signature", "locator"),)


class AllocationRound(Base):
    __tablename__ = "allocation_rounds"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    policy_version: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String)
    weights_before: Mapped[dict] = mapped_column(JSON)
    target_weights: Mapped[dict] = mapped_column(JSON)
    settled_weights: Mapped[dict | None] = mapped_column(JSON)
    snapshot_ids: Mapped[list] = mapped_column(JSON)
    scores: Mapped[dict] = mapped_column(JSON)
    objections: Mapped[list] = mapped_column(JSON, default=list)
    legs: Mapped[list] = mapped_column(JSON, default=list)
    reason: Mapped[str] = mapped_column(Text, default="")


class Price(Base):
    __tablename__ = "prices"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    mint: Mapped[str] = mapped_column(String, index=True)
    usd: Mapped[str] = mapped_column(String)
    multiplier: Mapped[str] = mapped_column(String, default="1")
    source: Mapped[str] = mapped_column(String, default="Jupiter Price v3")
    block_id: Mapped[str | None] = mapped_column(String)
    sampled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ValueSnapshot(Base):
    __tablename__ = "value_snapshots"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    agent_id: Mapped[str] = mapped_column(String, index=True)
    sampled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    valid: Mapped[bool] = mapped_column(Boolean)
    body: Mapped[dict] = mapped_column(JSON)


class Benchmark(Base):
    __tablename__ = "benchmark_lots"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String)
    proof: Mapped[str] = mapped_column(String, unique=True)
    body: Mapped[dict] = mapped_column(JSON)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    role: Mapped[str] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class GateEvidence(Base):
    __tablename__ = "gate_evidence"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    passed: Mapped[bool] = mapped_column(Boolean, default=False)
    environment: Mapped[str] = mapped_column(String)
    evidence: Mapped[dict] = mapped_column(JSON)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RuntimeState(Base):
    __tablename__ = "runtime_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    body: Mapped[dict] = mapped_column(JSON, default=dict)


class ReplayFrame(Base):
    __tablename__ = "replay_frames"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    time: Mapped[str] = mapped_column(String)
    body: Mapped[dict] = mapped_column(JSON)


class ReplayTrade(Base):
    __tablename__ = "replay_trades"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    frame_id: Mapped[int] = mapped_column(Integer, index=True)
    time: Mapped[str] = mapped_column(String)
    body: Mapped[dict] = mapped_column(JSON)


class ReplayHeadline(Base):
    __tablename__ = "replay_headlines"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    frame_id: Mapped[int] = mapped_column(Integer)
    body: Mapped[dict] = mapped_column(JSON)