# The agent service (FastAPI). Models are files in agent/models, versioned with the code.
#   docker build -f deploy/docker/agent.Dockerfile .
FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 REVOPS_ROOT=/app AGENT_PROVIDER=live PORT=8080
WORKDIR /app/agent
COPY agent/pyproject.toml ./
COPY agent/revops_agent ./revops_agent
RUN pip install --no-cache-dir .
COPY agent/models ./models
COPY config /app/config
RUN useradd --create-home agent
USER agent
EXPOSE 8080
CMD ["sh", "-c", "uvicorn revops_agent.app:app --host 0.0.0.0 --port ${PORT} --workers 2"]
