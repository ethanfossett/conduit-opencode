FROM docker.io/library/python:3.13-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY worker.py /app/worker.py
USER 65534:65534
ENTRYPOINT ["python", "-B", "/app/worker.py"]
