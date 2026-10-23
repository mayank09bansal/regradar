# RegRadar backend (FastAPI + LangGraph)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY backend ./backend
COPY data ./data
COPY n8n ./n8n
COPY tests ./tests
COPY pyproject.toml .

RUN useradd --create-home regradar && mkdir -p /app/data/runtime && chown -R regradar /app
USER regradar

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
