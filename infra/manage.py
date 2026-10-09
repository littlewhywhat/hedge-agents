import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

from dotenv import dotenv_values
import psycopg
from psycopg import sql

from agents.common.config import Settings
from agents.common.db import Database


ROOT = Path(__file__).resolve().parents[1]


def initialize():
    target = ROOT / ".env"
    if target.exists():
        print("Existing .env preserved.")
        return
    owner_password, app_password, signer_password, masumi_password = (secrets.token_hex(24) for _ in range(4))
    tokens = {name: secrets.token_urlsafe(36) for name in ("runtime", "monitor", "gateway", "btc", "eth", "gold", "stocks")}
    values = {
        "ENVIRONMENT": "preprod", "CARDANO_NETWORK": "preprod", "SOLANA_CLUSTER": "devnet",
        "FUND_MODE": "2", "ACTIVE_AGENTS": "btc,eth,gold,stocks", "POSTGRES_PORT": "55432",
        "POSTGRES_PASSWORD": owner_password, "APP_DATABASE_PASSWORD": app_password,
        "SIGNER_DATABASE_PASSWORD": signer_password, "MASUMI_DATABASE_PASSWORD": masumi_password,
        "DATABASE_URL": f"postgresql+psycopg://hedge_app:{app_password}@127.0.0.1:55432/hedge",
        "SIGNER_DATABASE_URL": f"postgresql+psycopg://hedge_signer:{signer_password}@127.0.0.1:55432/hedge",
        "ADMIN_DATABASE_URL": f"postgresql+psycopg://hedge_owner:{owner_password}@127.0.0.1:55432/hedge",
        "OPERATOR_TOKEN": secrets.token_urlsafe(48), "WEB_ORIGIN": "http://localhost:3000", "MONITOR_URL": "http://127.0.0.1:8000",
        "SERVICE_TOKEN_HASHES_JSON": json.dumps({name: hashlib.sha256(token.encode()).hexdigest() for name, token in tokens.items()}, separators=(",", ":")),
        "SOLANA_RPC_URL": "https://api.devnet.solana.com", "DEVNET_USDC_MINT": "", "JUPITER_API_KEY": "", "BLOCKFROST_PROJECT_ID": "",
        "PAYMENT_SERVICE_URL": "http://127.0.0.1:3001/api/v1", "PAYMENT_READ_KEY": "", "PAYMENT_AGENT_KEY": "",
        "LLM_API_KEY": "", "XSTOCKS_ELIGIBLE": "false", "ENCRYPTION_KEY": secrets.token_hex(32), "PAYMENT_ADMIN_KEY": secrets.token_urlsafe(48),
    }
    values.update({f"{name.upper()}_SERVICE_TOKEN": token for name, token in tokens.items()})
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write("\n".join(f"{key}='{value}'" for key, value in values.items()) + "\n")
    print("Created untracked local credentials in .env. No chain keys were generated.")


def config():
    values = dotenv_values(ROOT / ".env")
    if not values.get("ADMIN_DATABASE_URL"):
        raise SystemExit("Run uv run python -m infra.manage init first")
    return values


def dsn(url):
    return url.replace("postgresql+psycopg://", "postgresql://")


def initialize_database():
    values = config()
    with psycopg.connect(dsn(values["ADMIN_DATABASE_URL"]), autocommit=True) as connection:
        for name, password_key in (("hedge_app", "APP_DATABASE_PASSWORD"), ("hedge_signer", "SIGNER_DATABASE_PASSWORD"), ("masumi_app", "MASUMI_DATABASE_PASSWORD")):
            exists = connection.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,)).fetchone()
            if not exists:
                connection.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(name), sql.Literal(values[password_key])))
        if not connection.execute("SELECT 1 FROM pg_database WHERE datname = 'masumi'").fetchone():
            connection.execute("CREATE DATABASE masumi OWNER masumi_app")
    database = Database(values["ADMIN_DATABASE_URL"])
    database.create_schema()
    database.seed(Settings(_env_file=ROOT / ".env"))
    with psycopg.connect(dsn(values["ADMIN_DATABASE_URL"])) as connection:
        connection.execute((ROOT / "infra" / "schema.sql").read_text(encoding="utf-8"))
    database.engine.dispose()
    print("Initialized hedge and masumi databases, restricted roles, and append-only audit guards.")


def main():
    parser = argparse.ArgumentParser(description="Podman-only local application setup")
    parser.add_argument("command", choices=("init", "postgres", "init-db", "doctor", "test", "check-compose", "podman-app", "masumi"))
    args = parser.parse_args()
    os.chdir(ROOT)
    if args.command == "init":
        initialize()
    elif args.command in ("check-compose", "podman-app", "masumi"):
        values = config()
        files = ["-f", "infra/compose.yml"]
        if args.command != "masumi":
            files += ["-f", "infra/compose.app.yml"]
        files += ["-f", "infra/compose.masumi.yml"]
        if args.command == "masumi":
            network = values.get("ENVIRONMENT", "preprod").upper()
            for key in (f"MASUMI_BLOCKFROST_{network}", f"MASUMI_PURCHASING_{network}", f"MASUMI_SELLING_{network}"):
                if not values.get(key):
                    raise SystemExit(f"Set {key} first. Default mnemonic generation and logging are not permitted.")
        action = ["config", "--services"] if args.command == "check-compose" else ["up", "-d", "--build"] + (["payment-service"] if args.command == "masumi" else ["monitor", "runtime", "gateway", "facilitator", "trader-btc", "trader-eth", "trader-gold", "trader-stocks", "web"])
        result = subprocess.run([sys.executable, "-m", "podman_compose", "--env-file", ".env", *files, *action], capture_output=True, text=True)
        output = result.stdout + result.stderr
        for key, value in values.items():
            if value and any(word in key for word in ("PASSWORD", "TOKEN", "KEY", "MNEMONIC", "DATABASE_URL")):
                output = output.replace(value, "[redacted]")
        print(output[-12000:])
        raise SystemExit(result.returncode)
    elif args.command == "postgres":
        values = config()
        result = subprocess.run([sys.executable, "-m", "podman_compose", "--env-file", ".env", "-f", "infra/compose.yml", "up", "-d", "postgres"], capture_output=True, text=True)
        if result.returncode:
            output = result.stdout + result.stderr
            for key, value in values.items():
                if value and any(word in key for word in ("PASSWORD", "TOKEN", "KEY", "DATABASE_URL")):
                    output = output.replace(value, "[redacted]")
            print(output)
            raise SystemExit(result.returncode)
        subprocess.run(["podman", "wait", "--condition=healthy", "hedge-agents-postgres"], check=True, timeout=120, stdout=subprocess.DEVNULL)
        print("Podman Postgres is healthy on 127.0.0.1:55432.")
    elif args.command == "init-db":
        initialize_database()
    elif args.command == "doctor":
        values = config()
        result = subprocess.run(["podman", "info", "--format", "{{.Version.Version}}"], capture_output=True, text=True)
        print("Podman:", "connected" if result.returncode == 0 else "unavailable")
        with psycopg.connect(dsn(values["DATABASE_URL"])) as connection:
            connection.execute("SELECT 1")
        print("Postgres application role: connected")
        for name in ("JUPITER_API_KEY", "BLOCKFROST_PROJECT_ID", "DEVNET_USDC_MINT", "PAYMENT_READ_KEY", "LLM_API_KEY"):
            print(f"{name}: {'configured' if values.get(name) else 'not configured'}")
    elif args.command == "test":
        environment = os.environ.copy()
        environment["HEDGE_POSTGRES_URL"] = config()["DATABASE_URL"]
        environment["HEDGE_TEST_ADMIN_URL"] = config()["ADMIN_DATABASE_URL"]
        result = subprocess.run([sys.executable, "-m", "pytest", "-q", "--disable-warnings"], env=environment)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()