import os
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

# SQLAlchemy engine for Supabase Postgres
raw_url = os.environ["SUPABASE_DB_URL"]

# Ensure SQLAlchemy uses psycopg v3 driver (not psycopg2)
if raw_url.startswith("postgres://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgres://"):]
elif raw_url.startswith("postgresql://") and not raw_url.startswith("postgresql+psycopg://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgresql://"):]
else:
    DB_URL = raw_url  # already correct or custom

# IMPORTANTE: Usa NullPool per Transaction Pooler
engine = create_engine(
    DB_URL,
    poolclass=NullPool,  # Disabilita completamente il pooling SQLAlchemy
    echo=False  # Metti True per debug
)

def run(sql: str, params=None):
    """Execute a SQL statement within a transaction and return the result cursor."""
    with engine.begin() as conn:
        return conn.execute(text(sql), params or {})

