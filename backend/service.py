import json
from typing import Any, Dict, List, Optional

import numpy as np

from .db import run


def l2_normalize(arr: List[float]) -> List[float]:
    v = np.asarray(arr, dtype=np.float64)  # store as float8[] in PG
    n = np.linalg.norm(v)
    return (v / n).tolist() if n > 0 else v.tolist()


def get_db_dim() -> Optional[int]:
    res = run("select value from settings where key='db_dim' limit 1")
    row = res.fetchone()
    if not row:
        return None
    try:
        return int((row[0] or {}).get("value"))
    except Exception:
        return None


def ensure_db_dim(dim: int):
    run(
        """
        insert into settings(key, value)
        values ('db_dim', jsonb_build_object('value', :dim))
            on conflict (key) do nothing
        """,
        {"dim": dim},
    )


def upsert_monument_with_descriptors(data: Dict[str, Any]) -> Dict[str, Any]:
    monu_id = str(data["id"]).strip()
    descs = data.get("visual_descriptors") or []

    normalized: List[Dict[str, Any]] = []
    observed_dim: Optional[int] = None

    for idx, vd in enumerate(descs):
        emb = vd.get("embedding")

        # Accept both arrays and dicts with numeric keys (in case a TypedArray was JSON-serialized)
        if isinstance(emb, dict):
            try:
                numeric_items = sorted(
                    ((int(k), v) for k, v in emb.items() if str(k).isdigit()),
                    key=lambda kv: kv[0],
                )
                emb = [float(v) for _, v in numeric_items]
            except Exception:
                emb = None

        if isinstance(emb, list):
            norm = l2_normalize(emb)
            if observed_dim is None:
                observed_dim = len(norm)
            elif len(norm) != observed_dim:
                raise ValueError(f"Descriptor {idx} dim mismatch")
            normalized.append({"descriptor_id": vd.get("id") or f"main#{idx}", "embedding": norm})

    db_dim = get_db_dim()
    if observed_dim:
        if db_dim is None:
            ensure_db_dim(observed_dim)
        elif observed_dim != db_dim:
            raise ValueError(f"Embedding dim mismatch: got {observed_dim}, expected {db_dim}")

    # Upsert artwork metadata (single query)
    run(
        """
        insert into monuments (id, name, artist, year, descriptions, location_coords, updated_at)
        values (:id, :name, :artist, :year, cast(:descriptions as jsonb), cast(:location_coords as jsonb), now())
            on conflict (id) do update set
            name = excluded.name,
                                    artist = excluded.artist,
                                    year = excluded.year,
                                    descriptions = excluded.descriptions,
                                    location_coords = excluded.location_coords,
                                    updated_at = now()
        """,
        {
            "id": monu_id,
            "name": data.get("name"),
            "artist": data.get("artist"),
            "year": data.get("year"),
            "descriptions": json.dumps(data.get("descriptions") or {}),
            "location_coords": json.dumps(data.get("location_coords") or {}),
        },
    )

    # Batch upsert descriptors in one executemany call.
    # Use prepare=False to avoid server-side prepared statement naming conflicts.
    if normalized:
        values = [
            {"monu_id": monu_id, "desc_id": d["descriptor_id"], "embedding": d["embedding"]}
            for d in normalized
        ]
        run(
            """
            insert into descriptors (monument_id, descriptor_id, embedding)
            values (:monu_id, :desc_id, :embedding)
                on conflict (monument_id, descriptor_id) do update set
                embedding = excluded.embedding
            """,
            values,
            prepare=False,  # IMPORTANT to avoid DuplicatePreparedStatement issues
        )

    return {"id": monu_id, "descriptors": normalized, "observed_dim": observed_dim}
