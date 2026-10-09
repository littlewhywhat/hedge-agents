import pytest

from agents.common.config import Settings
from agents.common.db import Database


@pytest.fixture
def settings():
    return Settings(_env_file=None, operator_token="test-operator-token-at-least-32-characters", service_tokens_json='{"runtime":"runtime-test-token", "btc":"btc-test-token", "gateway":"gateway-test-token"}')


@pytest.fixture
def database(settings):
    database = Database("sqlite+pysqlite:///:memory:", testing=True)
    database.create_schema()
    database.seed(settings)
    yield database
    database.engine.dispose()