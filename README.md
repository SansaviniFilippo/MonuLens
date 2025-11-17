# MonumentSpot

MonumentSpot is a monument recognition system composed of:
- a web frontend that uses the device camera, detects the monument in the scene (MediaPipe ObjectDetector), produces a visual embedding (TensorFlow.js + MobileNet), and performs client-side matching;
- a FastAPI backend that exposes the archive and descriptors, along with admin endpoints to insert/update monuments and descriptors in the database (Postgres/Supabase).

## Deployment
- frontend on [Render](https://monumentspot.onrender.com)
- backend on [Railway](https://monumentspot-production.up.railway.app/docs)

## Overview and architecture
- Frontend (frontend/public):
  - index.html: landing page with “Scan Monument” and “Manager Login” buttons.
  - scanner.html: page with camera video, overlay, and detailed UI. It loads:
    - MediaPipe Tasks Vision (ObjectDetector) for object detection from a local TFLite model (public/models/model_24.tflite);
    - TensorFlow.js + MobileNet to generate 224×224 L2‑normalized embeddings;
    - JS code (src/js) for local matching against embeddings downloaded from the backend.
  - manager_access.html / manager_dashboard.html: demo access and a dashboard to insert monuments. The dashboard computes embeddings client‑side and sends them to the backend.
- Backend (backend/):
  - FastAPI with public endpoints for archive and descriptors, and admin endpoints for upsert/delete.
  - Connection to Postgres (Supabase) via SQLAlchemy.
  - In‑memory data cache for fast responses; optional on‑disk persistence.

## Run locally with Docker
Prerequisites:
- Docker Desktop (or Colima/OrbStack) installed and running

1) Create a `.env` file at the project root (do not commit real credentials):
```
SUPABASE_DB_URL=postgresql://<user>:<pass>@<host>:5432/<db>?sslmode=require
ADMIN_TOKEN=monumentspot_admin
FRONTEND_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
ENABLE_DISK_CACHE=true
```

2) Start the stack with Docker Compose:
```
docker compose up -d --build
```
- Frontend: http://localhost:8080
- Backend:  http://localhost:8000/health
- Proxy API: http://localhost:8080/api/health (goes through the frontend’s Nginx → backend)

Important notes:
- The frontend is served by Nginx (frontend/nginx.conf). APIs are exposed under `/api/...` and forwarded to the `backend:8000` service, so CORS is not needed locally.
- The backend `ADMIN_TOKEN` value must match the one used by the frontend for admin operations (see the Dashboard section).
- If you see browser cache issues after rebuilding the frontend, use Hard Reload (Ctrl/Cmd+Shift+R).

Quick troubleshooting:
- Docker won’t start → start Docker Desktop. `docker info` must work.
- 401 on admin endpoints → ensure the X-Admin-Token header sent by the frontend matches `ADMIN_TOKEN` in `.env`.
- Local CORS → make sure you use `/api` (the frontend default) and not an external domain.

---

## Usage

### User (Scanner)
- From the home page (index.html) click “Scan Monument” (opens scanner.html):
  - Grant geolocation permission (optional).
  - Grant camera permission.
  - A blue box appears when the model detects a monument.
  - The system computes an embedding with MobileNet and matches it against the local DB (downloaded from the backend). 
  - It displays monument's name, artist, description and, if the user has given permission for geolocation, it also displays a map showing the user with a blue dot and the monument with a red dot or red polygon. The map auto zooms to keep the user and the monument visible even if the user moves hundreds of meters away or is close to the monument.
  - IT/EN localization is available from the language bar.

### Manager (Dashboard)
- Demo access: manager_access.html (demo credentials saved in localStorage: email manager@archive.com, password tesi2025). This is for demonstration purposes only.
- Dashboard: manager_dashboard.html
  1. Upload one or more images of the monument.
  2. Enter metadata (name, artist, year), descriptions (IT/EN) and a point or a polygon that represent monument's coordinates on the map.
  3. On save, the browser computes embeddings (224×224, L2) and sends a JSON to POST /monuments with the X-Admin-Token header set automatically by the frontend (no prompt). Make sure it matches `ADMIN_TOKEN` on the backend.
  4. The backend stores metadata + descriptors + geojson coordinates in the DB and updates the cache; the frontend reloads the DB.
  5. If needed, use the “Manage Collection” tab to browse and manage the collection (requires the APIs to be running; includes actions such as fetch details /monuments/{id} and delete).


## Backend APIs (main)
- GET /health: backend status, number of descriptors, and embedding dimension.
- GET /health_db: check DB connection (monument count or concise error).
- GET /archive[?with_image_counts=true]: list of monument (id, name, artist, year, descriptions, location_coords).
- GET /descriptors: map { monument_id: embedding[] } (one descriptor per monument).
- GET /descriptors_v2: map { monument_id: [ [..emb1..], [..emb2..] ] } (all descriptors per monument).
- GET /descriptors_meta_v2: list with monument_id, descriptor_id, image_path, embedding.
- POST /match: { embedding: float[], top_k, threshold, lang } -> matches[] (not used by the default frontend, which does local matching, but useful for external clients).
- POST /log_perf: endpoint for performance telemetry (enabled via ?telemetry=1 in the frontend).

Admin endpoints (require X-Admin-Token header equal to ADMIN_TOKEN):
- POST /monuments: upsert monument and descriptors. Accepts payload like:
  ```json
  {
    "name": "Monument Name",
    "artist": "Artist Name",
    "year": "c. 1620",
    "descriptions": { "it": "Descrizione in italiano", "en": "Description in English" },
    "location_coords": { "type": "Point", "coordinates": [12.4924, 41.8902] },
    "visual_descriptors": [
      { "id": "img-1", "embedding": [0.01, 0.02, 0.03] },
      { "id": "img-2", "embedding": [0.04, 0.05, 0.06] }
    ]
  }
  ```
- GET /monuments/{id}: monument detail (including the list of descriptor_id).
- DELETE /monuments/{id}: remove the monument (cascade delete on descriptors).
- DELETE /monuments/{id}/descriptors/{descriptor_id}: remove a single descriptor.


## Expected DB schema (example SQL)
The backend expects three tables: settings, monuments, descriptors. Example compatible with Postgres/Supabase:
```sql
create table if not exists settings (
  key text primary key,
  value jsonb
);

create table if not exists monuments (
  id text primary key,
  name text,
  artist text,
  year text,
  descriptions jsonb,
  location_coords jsonb, 
  updated_at timestamptz default now()
);

create table if not exists descriptors (
  monuments_id text references monuments(id) on delete cascade,
  descriptor_id text,
  embedding double precision[],
  primary key (monuments_id, descriptor_id)
);
```
Notes:
- On the first upsert, the backend saves the observed embedding dimension in settings.key='db_dim'; subsequent inserts must have the same dimension.
- Embeddings are L2‑normalized (cosine = dot product).


## How it works (pipeline)
1. Detection: MediaPipe ObjectDetector (TFLite model in public/models/model_24.tflite) finds the monument bounding box.
2. Preprocessing: the box is cropped and resized to 224×224.
3. Embedding: TensorFlow.js MobileNet (version 2, alpha 1.0) generates a feature vector; the vector is L2‑normalized.
4. Matching: on the client, the embedding DB is downloaded from the backend (/descriptors_v2 + /archive). If the user has given permission for geolocation, the db is filtered and the similarity is calculated only for monuments that have at least one coordinate within a certain radius (0.3 km). If the user has not given permission for geolocation, the similarity is calculated for all monuments in the db. Similarity is computed as dot product (cosine). Thresholds and limits are in src/js/constants.js (e.g., COSINE_THRESHOLD).
5. UI: name, artist, description (in IT/EN based on the selected language) and map(if geolocation permission granted) are shown. Optionally, telemetry is recorded to /log_perf.


## Configuration
- Backend environment variables:
  - SUPABASE_DB_URL (required)
  - ADMIN_TOKEN (required for admin)
  - FRONTEND_ORIGINS (optional, CSV)
  - ENABLE_DISK_CACHE=true|false (default true)
  - DISK_CACHE_PATH (optional)
- Frontend:
  - Set window.BACKEND_URL in scanner.html/manager_dashboard.html to specify the backend URL (default http://localhost:8000).
  - TFLite model: public/models/model_24.tflite. You can update it by replacing the file; make sure it’s consistent with the types of objects to detect.
  - Parameters: see src/js/constants.js (COSINE_THRESHOLD, MIN_BOX_SCORE, CROP_SIZE, etc.).

## Troubleshooting
- The camera doesn’t start:
  - Use an HTTP server (not file://). On public domains you need HTTPS; locally, localhost is fine.
  - Check browser permissions and that it’s not inside a disallowed iFrame.
- CORS error from the frontend:
  - Add your static server’s origin to FRONTEND_ORIGINS and restart the backend.
- No results/empty matching:
  - The DB might be empty: use the manager dashboard to insert monuments.
  - Verify that /archive and /descriptors_v2 respond and that embeddings are present.
- Embedding dimension mismatch:
  - Ensure the embeddings in the DB were generated with the same MobileNet/224 and normalization. If the schema was populated with a different model, regenerate or clear/recreate descriptors.
- 401 error on admin endpoints:
  - Verify that the X-Admin-Token header matches ADMIN_TOKEN.
- DB connection failed:
  - Check SUPABASE_DB_URL (uses psycopg v3 driver; sslmode=require on Supabase).


## Project structure (main)
- backend/
  - app.py (API, cache, matching, admin)
  - service.py (upsert and normalization, dimension consistency)
  - db.py (SQLAlchemy connection)
  - requirements.txt
- frontend/
  - public/ (HTML pages, CSS, images, .tflite models)
  - src/js/ (scanner logic, map and geolocalization logic,embedding, matching, UI, dashboard)