FROM python:3.11-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Dipendenze di sistema minime
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installa dipendenze
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copia il codice backend
COPY backend ./backend

# Crea utente non-root (hardening opzionale)
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Porta e comando di avvio
EXPOSE 8000
CMD [ "uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000" ]