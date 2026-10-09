import hashlib
import hmac
import json

from fastapi import Header, HTTPException


def operator_auth(settings):
    async def verify(authorization: str | None = Header(default=None)):
        expected = settings.operator_token.get_secret_value()
        if len(expected) < 32:
            raise HTTPException(503, "Operator credential is not configured")
        scheme, _, value = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(value, expected):
            raise HTTPException(401, "Operator authorization required", headers={"WWW-Authenticate": "Bearer"})
        return "operator"
    return verify


def service_auth(settings, allowed: set[str] | None = None):
    hashes = json.loads(settings.service_token_hashes_json)
    async def verify(authorization: str | None = Header(default=None), x_agent_id: str | None = Header(default=None)):
        expected = hashes.get(x_agent_id or "", "")
        scheme, _, value = (authorization or "").partition(" ")
        digest = hashlib.sha256(value.encode()).hexdigest()
        if not expected or scheme.lower() != "bearer" or not hmac.compare_digest(digest, expected) or (allowed is not None and x_agent_id not in allowed):
            raise HTTPException(403, "Scoped service authorization required")
        return x_agent_id
    return verify