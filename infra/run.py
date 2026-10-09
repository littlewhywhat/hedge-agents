import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import os
from pathlib import Path
import subprocess
import sys

from dotenv import dotenv_values


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_SETTINGS = ("ENVIRONMENT", "CARDANO_NETWORK", "SOLANA_CLUSTER", "FUND_MODE", "ACTIVE_AGENTS", "WEB_ORIGIN", "SOLANA_RPC_URL", "DEVNET_USDC_MINT", "PAYMENT_SERVICE_URL", "GATEWAY_URL", "FACILITATOR_URL", "TRADER_URLS_JSON", "SERVICE_TOKEN_HASHES_JSON", "ADA_PRICE_MINT", "SAMPLE_SECONDS", "TICK_SECONDS", "ALLOCATION_SECONDS", "XSTOCKS_ELIGIBLE", "LLM_MODEL", "LLM_API_URL")
OS_SETTINGS = ("PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY")


def service_environment(service, values):
    result = {key: value for key, value in os.environ.items() if key in OS_SETTINGS}
    result.update({key: values[key] for key in PUBLIC_SETTINGS if values.get(key) is not None})
    result["HEDGE_SERVICE_PROCESS"] = "1"
    result["PYTHONUTF8"] = "1"
    result["NODE_USE_SYSTEM_CA"] = "1"
    if service == "web":
        return {**{key: value for key, value in result.items() if key in OS_SETTINGS}, "MONITOR_URL": values.get("MONITOR_URL", "http://127.0.0.1:8000")}
    signer = service == "facilitator" or service == "gateway" or service in ("btc", "eth", "gold", "stocks")
    result["DATABASE_URL"] = values["SIGNER_DATABASE_URL" if signer else "DATABASE_URL"]
    result["SERVICE_TOKEN"] = values.get(f"{service.upper()}_SERVICE_TOKEN", "")
    if service in ("monitor", "runtime"):
        for key in ("JUPITER_API_KEY", "BLOCKFROST_PROJECT_ID", "PAYMENT_READ_KEY"):
            result[key] = values.get(key, "")
        if service == "monitor":
            result["OPERATOR_TOKEN"] = values.get("OPERATOR_TOKEN", "")
    elif service == "facilitator":
        result["BLOCKFROST_PROJECT_ID"] = values.get("BLOCKFROST_PROJECT_ID", "")
        for name in ("BTC", "ETH", "GOLD", "STOCKS", "GATEWAY"):
            result[name + "_CAPITAL_MNEMONIC"] = values.get(name + "_CAPITAL_MNEMONIC", "")
    else:
        result["AGENT_ID"] = service
        result["SOLANA_PRIVATE_KEY"] = values.get(service.upper() + "_SOLANA_PRIVATE_KEY", "")
        result["PAYMENT_AGENT_KEY"] = values.get(service.upper() + "_PAYMENT_KEY", "")
        result["PAYMENT_READ_KEY"] = values.get(service.upper() + "_PAYMENT_KEY", "")
        result["BLOCKFROST_PROJECT_ID"] = values.get("BLOCKFROST_PROJECT_ID", "")
        if service != "gateway":
            for key in ("JUPITER_API_KEY", "LLM_API_KEY"):
                result[key] = values.get(key, "")
    return result


def main():
    parser = argparse.ArgumentParser(description="Launch a service with only its permitted credentials")
    parser.add_argument("service", choices=("core", "monitor", "runtime", "gateway", "facilitator", "btc", "eth", "gold", "stocks", "web"))
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    if args.service == "core":
        services = ("runtime", "gateway", "facilitator", "btc", "eth", "gold", "stocks")
        children = [subprocess.Popen([sys.executable, "-m", "infra.run", name], cwd=ROOT) for name in services]
        try:
            with ThreadPoolExecutor(max_workers=len(children)) as executor:
                futures = [executor.submit(child.wait) for child in children]
                wait(futures, return_when=FIRST_COMPLETED)
                for child in children:
                    if child.poll() is None:
                        child.terminate()
        except KeyboardInterrupt:
            for child in children:
                if child.poll() is None:
                    child.terminate()
        return
    values = dotenv_values(ROOT / ".env")
    if not values.get("DATABASE_URL"):
        raise SystemExit("Initialize .env before starting services")
    environment = service_environment(args.service, values)
    if args.service == "runtime":
        command = [sys.executable, "-m", "runtime.main"]
    elif args.service in ("facilitator", "web"):
        import shutil
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        if not npm:
            raise SystemExit("Node.js and npm are required")
        directory = ROOT / ("agents/facilitator" if args.service == "facilitator" else "web")
        command = [npm, "--prefix", str(directory), "run", "start" if args.service == "facilitator" else "dev"]
        if args.service == "web":
            command += ["--", "--hostname", "127.0.0.1", "--port", str(args.port or 3000)]
        else:
            environment["PORT"] = str(args.port or 8084)
    else:
        module = "monitor.app:app" if args.service == "monitor" else ("agents.gateway.app:app" if args.service == "gateway" else "agents.trader.app:app")
        default_port = {"monitor": 8000, "gateway": 8082, "btc": 8101, "eth": 8102, "gold": 8103, "stocks": 8104}[args.service]
        command = [sys.executable, "-m", "uvicorn", module, "--host", "127.0.0.1", "--port", str(args.port or default_port)]
    try:
        raise SystemExit(subprocess.run(command, cwd=ROOT, env=environment).returncode)
    except KeyboardInterrupt:
        raise SystemExit(0)


if __name__ == "__main__":
    main()