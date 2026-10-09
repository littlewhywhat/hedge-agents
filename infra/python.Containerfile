FROM docker.io/library/python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HEDGE_SERVICE_PROCESS=1
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY agents ./agents
COPY monitor ./monitor
COPY runtime ./runtime
COPY infra ./infra
ENV PATH="/app/.venv/bin:$PATH"
USER 10001:10001
CMD ["uvicorn", "monitor.app:app", "--host", "0.0.0.0", "--port", "8000"]