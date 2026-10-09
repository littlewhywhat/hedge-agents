from infra.run import service_environment


def values():
    result = {"DATABASE_URL": "app", "SIGNER_DATABASE_URL": "signer", "ADMIN_DATABASE_URL": "never", "OPERATOR_TOKEN": "operator", "PAYMENT_ADMIN_KEY": "never", "ENCRYPTION_KEY": "never", "BLOCKFROST_PROJECT_ID": "read-only", "JUPITER_API_KEY": "quote", "LLM_API_KEY": "model"}
    for name in ("BTC", "ETH", "GOLD", "STOCKS", "GATEWAY"):
        result[name + "_CAPITAL_MNEMONIC"] = "capital"
        result[name + "_PURCHASING_MNEMONIC"] = "fee-buyer"
        result[name + "_SELLING_MNEMONIC"] = "fee-seller"
        result[name + "_SOLANA_PRIVATE_KEY"] = name + "-solana"
        result[name + "_PAYMENT_KEY"] = name + "-payment"
    return result


def test_monitor_runtime_and_web_have_no_chain_keys():
    for name in ("monitor", "runtime", "web"):
        env = service_environment(name, values())
        assert not any("MNEMONIC" in key or "PRIVATE_KEY" in key for key in env)
        assert "ADMIN_DATABASE_URL" not in env and "PAYMENT_ADMIN_KEY" not in env
        if name != "monitor":
            assert "OPERATOR_TOKEN" not in env


def test_each_trader_gets_only_its_solana_key_and_scoped_payment_key():
    for name in ("btc", "eth", "gold", "stocks", "gateway"):
        env = service_environment(name, values())
        assert env["SOLANA_PRIVATE_KEY"] == name.upper() + "-solana"
        assert env["PAYMENT_AGENT_KEY"] == name.upper() + "-payment"
        assert not any("MNEMONIC" in key for key in env)
        assert "PAYMENT_ADMIN_KEY" not in env


def test_facilitator_never_gets_fee_wallet_or_solana_keys():
    env = service_environment("facilitator", values())
    assert len([key for key in env if key.endswith("_CAPITAL_MNEMONIC")]) == 5
    assert not any("PURCHASING" in key or "SELLING" in key or "SOLANA_PRIVATE" in key for key in env)