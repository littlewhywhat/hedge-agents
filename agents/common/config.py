from functools import lru_cache
import os
from typing import Literal

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


MARKETS = {
    "btc": {"name": "Bitcoin", "symbol": "cbBTC", "mint": "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", "decimals": 8, "program": "spl", "color": "#ec9a35"},
    "eth": {"name": "Ethereum", "symbol": "WETH", "mint": "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", "decimals": 8, "program": "spl", "color": "#5c87df"},
    "gold": {"name": "Gold", "symbol": "PAXG", "mint": "5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW", "decimals": 6, "program": "token2022", "color": "#c7b03d"},
    "stocks": {"name": "S&P 500", "symbol": "SPYx", "mint": "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", "decimals": 8, "program": "token2022", "color": "#429e83"},
}
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
STABLECOIN_UNITS = {
    "preprod": "16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d",
    "mainnet": "1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378",
}
V2_ADDRESSES = {
    "preprod": "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g",
    "mainnet": "addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    def __init__(self, **values):
        if os.environ.get("HEDGE_SERVICE_PROCESS") == "1":
            values.setdefault("_env_file", None)
        super().__init__(**values)

    environment: Literal["preprod", "mainnet"] = "preprod"
    cardano_network: Literal["preprod", "mainnet"] = "preprod"
    solana_cluster: Literal["devnet", "mainnet"] = "devnet"
    database_url: str = "postgresql+psycopg://hedge_app@127.0.0.1:55432/hedge"
    operator_token: SecretStr = SecretStr("")
    service_tokens_json: SecretStr = SecretStr("{}")
    service_token_hashes_json: str = "{}"
    service_token: SecretStr = SecretStr("")
    agent_id: str = "btc"
    fund_mode: Literal[1, 2] = 2
    active_agents: str = "btc,eth,gold,stocks"
    web_origin: str = "http://localhost:3000"
    payment_service_url: str = "http://127.0.0.1:3001/api/v1"
    payment_read_key: SecretStr = SecretStr("")
    payment_agent_key: SecretStr = SecretStr("")
    facilitator_url: str = "http://127.0.0.1:8084"
    gateway_url: str = "http://127.0.0.1:8082"
    trader_urls_json: str = '{"btc":"http://127.0.0.1:8101","eth":"http://127.0.0.1:8102","gold":"http://127.0.0.1:8103","stocks":"http://127.0.0.1:8104"}'
    jupiter_url: str = "https://api.jup.ag"
    jupiter_api_key: SecretStr = SecretStr("")
    ada_price_mint: str = ""
    solana_rpc_url: str = "https://api.devnet.solana.com"
    devnet_usdc_mint: str = ""
    blockfrost_project_id: SecretStr = SecretStr("")
    llm_api_url: str = "https://generativelanguage.googleapis.com/v1beta/openai"
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = "gemini-3.1-flash-lite"
    max_trade_usd: int = 100
    gateway_per_job_usd: int = 200
    gateway_daily_usd: int = 1000
    gateway_fee_raw: int = 100_000
    gateway_low_water_raw: int = 20_000_000
    sample_seconds: int = 60
    tick_seconds: int = 180
    allocation_seconds: int = 1800
    qualification_max_usd: int = 5
    xstocks_eligible: bool = False

    @field_validator("fund_mode", mode="before")
    @classmethod
    def parse_fund_mode(cls, value):
        return int(value)

    @model_validator(mode="after")
    def validate_environment(self):
        expected = ("preprod", "devnet") if self.environment == "preprod" else ("mainnet", "mainnet")
        if (self.cardano_network, self.solana_cluster) != expected:
            raise ValueError("Cardano and Solana must match the selected environment")
        names = self.agent_ids
        if not names or len(names) != len(set(names)) or not set(names) <= set(MARKETS):
            raise ValueError("Active agents must be a unique set of known markets")
        if (self.fund_mode == 1 and len(names) != 1) or (self.fund_mode == 2 and not 2 <= len(names) <= 4):
            raise ValueError("Mode 1 needs one agent; Mode 2 needs two to four")
        if self.gateway_fee_raw <= 0 or self.qualification_max_usd > 5 or self.qualification_max_usd <= 0:
            raise ValueError("Fees must be positive and qualification is bounded to five dollars")
        return self

    @property
    def agent_ids(self) -> list[str]:
        return sorted(name.strip() for name in self.active_agents.split(",") if name.strip())

    @property
    def stablecoin_unit(self) -> str:
        return STABLECOIN_UNITS[self.environment]

    @property
    def usdc_mint(self) -> str:
        return USDC_MINT if self.environment == "mainnet" else self.devnet_usdc_mint

    @property
    def blockfrost_url(self) -> str:
        return f"https://cardano-{self.environment}.blockfrost.io/api/v0"


@lru_cache
def get_settings() -> Settings:
    return Settings()