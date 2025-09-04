import os
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

# SQLAlchemy engine for Supabase Postgres
# Requires environment variable SUPABASE_DB_URL (include sslmode=require)
raw_url = os.environ["SUPABASE_DB_URL"]

# Ensure SQLAlchemy uses psycopg v3 driver (not psycopg2)
if raw_url.startswith("postgres://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgres://"):]
elif raw_url.startswith("postgresql://") and not raw_url.startswith("postgresql+psycopg://"):
    DB_URL = "postgresql+psycopg://" + raw_url[len("postgresql://"):]
else:
    DB_URL = raw_url  # already correct or custom

# Use NullPool with Transaction Pooler (port 6543)
engine = create_engine(
    DB_URL,
    poolclass=NullPool,                  # disabilita il pool lato client
    connect_args={"sslmode": "require"}, # Supabase richiede SSL
    pool_pre_ping=True                   # opzionale, evita connessioni zombie
)


def run(sql: str, params=None):
    """Execute a SQL statement within a transaction and return the result cursor."""
    with engine.begin() as conn:
        return conn.execute(text(sql), params or {})

