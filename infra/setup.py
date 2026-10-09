import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ElementTree

from solders.pubkey import Pubkey
from sqlalchemy import select

from agents.common.config import Settings
from agents.common.db import Database, append_event
from agents.common.errors import DomainError
from agents.common.masumi import select_source
from agents.common.models import Agent, ChainAttempt, Controls, GateEvidence, Wallet
from infra.manage import ROOT, config


CHAIN_GATES = {"preprod_registry", "preprod_escrow", "preprod_x402", "devnet_transfer", "adapter_recovery", "mainnet_qualification"}


def validate_wallet_manifest(body, settings):
    if body.get("environment") != settings.environment:
        raise DomainError("Wallet manifest belongs to a different environment")
    seen, roles, rows = set(), set(), []
    for row in body.get("wallets", []):
        name, chain, role, address = (row.get(key) for key in ("agent_id", "chain", "role", "address"))
        if name not in settings.agent_ids + ["gateway", "operator"] or chain not in ("cardano", "solana") or not address or not row.get("id"):
            raise DomainError("Wallet manifest contains an invalid identity")
        if (chain, address) in seen or (name, chain, role) in roles:
            raise DomainError("Wallet roles must use distinct active addresses")
        if chain == "solana":
            try:
                Pubkey.from_string(address)
            except Exception:
                raise DomainError("Invalid Solana public address") from None
            expected_role = "gateway_inventory" if name == "gateway" else "trading"
            if name == "operator" or role != expected_role:
                raise DomainError("Invalid Solana wallet role")
            signer = name
        else:
            prefix = "addr_test1" if settings.environment == "preprod" else "addr1"
            if not address.startswith(prefix) or len(address) < 50:
                raise DomainError("Cardano address does not match the configured network")
            if name == "operator":
                if role != "distribution":
                    raise DomainError("Operator address must be a distribution wallet")
                signer = "external"
            elif role not in ("capital", "purchasing", "selling"):
                raise DomainError("Invalid Cardano wallet role")
            else:
                signer = "facilitator" if role == "capital" else "payment_service"
        seen.add((chain, address))
        roles.add((name, chain, role))
        rows.append({"id": row["id"], "agent_id": name, "chain": chain, "role": role, "address": address, "environment": settings.environment, "signer": signer, "belongs_to_fund": name in settings.agent_ids and role != "selling"})
    for name in settings.agent_ids + ["gateway"]:
        required = {(name, "cardano", role) for role in ("capital", "purchasing", "selling")} | {(name, "solana", "gateway_inventory" if name == "gateway" else "trading")}
        if not required <= roles:
            raise DomainError(f"{name} needs three distinct Cardano roles and one Solana wallet")
    return rows


def import_wallets(path):
    settings = Settings()
    body = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = validate_wallet_manifest(body, settings)
    database = Database(settings.database_url)
    with database.transaction() as session:
        controls = session.get(Controls, 1, with_for_update=True)
        if not controls.kill_switch or session.scalar(select(ChainAttempt.id).where(ChainAttempt.state.in_(("prepared", "submitted", "unknown")))):
            raise DomainError("Halt activity and resolve all attempts before configuring wallet ownership")
        for row in rows:
            old = session.get(Wallet, row["id"])
            if old:
                if any(getattr(old, key) != value for key, value in row.items()):
                    raise DomainError("Existing wallet ownership is immutable; use an audited handoff")
            else:
                session.add(Wallet(**row))
        for registry in body.get("registry", []):
            agent = session.get(Agent, registry["agent_id"])
            if not agent or not registry["identifier"].startswith("67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b"):
                raise DomainError("Registry identity is not a configured V2 agent")
            fee = settings.gateway_fee_raw if agent.id == "gateway" else 10_000
            select_source(registry["supportedPaymentSources"], settings, fee)
            agent.registry_id = registry["identifier"]
            agent.details = {**agent.details, "seller_vkey": registry["seller_vkey"], "supportedPaymentSources": registry["supportedPaymentSources"], "api_url": registry.get("api_url")}
        append_event(session, "wallet_configuration_imported", {"wallet_count": len(rows), "environment": settings.environment, "contains_secrets": False})
    print(f"Imported {len(rows)} public wallet records. Restart isolated signer services before qualification.")


def record_gate(name, evidence_path):
    if name not in CHAIN_GATES:
        raise DomainError("Offline acceptance can only be recorded by the verification command")
    evidence = json.loads(Path(evidence_path).read_text(encoding="utf-8"))
    required_network = "mainnet" if name == "mainnet_qualification" else "preprod"
    if evidence.get("environment") != required_network or evidence.get("verified_by") != "operator" or not evidence.get("receipts") or not evidence.get("checks") or any(value is not True for value in evidence["checks"].values()):
        raise DomainError("Gate evidence requires the correct environment, operator attribution, receipts, and passing checks")
    if name == "mainnet_qualification" and (evidence.get("budget_usd", 0) > 5 or not evidence["checks"].get("reconciled_raw_balances") or not evidence["checks"].get("cash_flow_pnl_identity")):
        raise DomainError("Mainnet qualification needs a reconciled bounded round trip and PnL identity")
    database = Database(config()["ADMIN_DATABASE_URL"])
    with database.transaction() as session:
        row = session.get(GateEvidence, name)
        if row:
            row.evidence, row.passed, row.environment = evidence, True, required_network
        else:
            session.add(GateEvidence(id=name, passed=True, environment=required_network, evidence=evidence))
        append_event(session, "acceptance_evidence_recorded", {"gate": name, "verified_by": "operator", "environment": required_network})
    print("Recorded operator-supplied chain evidence. Automation was not armed.")


def verify():
    values = config()
    environment = os.environ.copy()
    environment["HEDGE_POSTGRES_URL"] = values["DATABASE_URL"]
    environment["HEDGE_TEST_ADMIN_URL"] = values["ADMIN_DATABASE_URL"]
    environment["NODE_USE_SYSTEM_CA"] = "1"
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise DomainError("Node.js and npm are required for full verification")
    artifacts = ROOT / "artifacts"
    artifacts.mkdir(exist_ok=True)
    commands = [
        [sys.executable, "-m", "pytest", "-q", "--disable-warnings", "--junitxml=artifacts/offline-tests.xml"],
        [sys.executable, "-m", "ruff", "check", "agents", "monitor", "runtime", "infra", "tests"],
        [npm, "--prefix", "agents/facilitator", "run", "build"],
        [npm, "--prefix", "agents/facilitator", "test"],
        [npm, "--prefix", "web", "run", "lint"],
        [npm, "--prefix", "web", "run", "build"],
    ]
    for command in commands:
        result = subprocess.run(command, cwd=ROOT, env=environment)
        if result.returncode:
            raise SystemExit(result.returncode)
    report = artifacts / "offline-tests.xml"
    suites = ElementTree.parse(report).getroot().findall("testsuite")
    if not suites or any(int(suite.get("skipped", "0")) for suite in suites):
        raise DomainError("Full offline gate cannot pass with skipped Postgres checks")
    evidence = {"verified_by": "automated local verification", "python_tests": sum(int(suite.get("tests", "0")) for suite in suites), "report_sha256": hashlib.sha256(report.read_bytes()).hexdigest(), "commands": [" ".join(command[1:]) for command in commands], "chain_transactions_executed": False}
    database = Database(values["ADMIN_DATABASE_URL"])
    with database.transaction() as session:
        row = session.get(GateEvidence, "offline_acceptance")
        if row:
            row.evidence, row.passed = evidence, True
        else:
            session.add(GateEvidence(id="offline_acceptance", passed=True, environment=Settings().environment, evidence=evidence))
        append_event(session, "offline_acceptance_passed", evidence)
    print("Offline acceptance recorded. Real Preprod and mainnet gates remain separate; automation is not armed.")


def main():
    parser = argparse.ArgumentParser(description="Public wallet setup and explicit acceptance evidence")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("verify")
    wallets = sub.add_parser("import-wallets")
    wallets.add_argument("manifest")
    gate = sub.add_parser("record-gate")
    gate.add_argument("name", choices=sorted(CHAIN_GATES))
    gate.add_argument("evidence")
    args = parser.parse_args()
    try:
        if args.command == "verify":
            verify()
        elif args.command == "import-wallets":
            import_wallets(args.manifest)
        else:
            record_gate(args.name, args.evidence)
    except DomainError as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()