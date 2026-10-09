from copy import deepcopy

import pytest

from agents.common.errors import DomainError
from agents.trader.service import confirmed_swap_amounts


def test_actual_net_movements_not_quoted_estimates():
    transaction = {"meta": {"err": None, "preTokenBalances": [{"owner": "trader", "mint": "usdc", "uiTokenAmount": {"amount": "100000000"}}, {"owner": "trader", "mint": "token", "uiTokenAmount": {"amount": "0"}}], "postTokenBalances": [{"owner": "trader", "mint": "usdc", "uiTokenAmount": {"amount": "75000000"}}, {"owner": "trader", "mint": "token", "uiTokenAmount": {"amount": "24800000"}}]}}
    assert confirmed_swap_amounts(transaction, "trader", "usdc", "token") == (25_000_000, 24_800_000)
    invalid = deepcopy(transaction)
    invalid["meta"]["err"] = {"InstructionError": "failed"}
    with pytest.raises(DomainError):
        confirmed_swap_amounts(invalid, "trader", "usdc", "token")


def test_missing_net_fill_is_not_success():
    with pytest.raises(DomainError):
        confirmed_swap_amounts({"meta": {"err": None, "preTokenBalances": [], "postTokenBalances": []}}, "trader", "usdc", "token")