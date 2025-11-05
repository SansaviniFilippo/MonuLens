import { initEmbeddingModel, embedFromCanvas } from './embedding.js';
import { BACKEND_URL, CROP_SIZE } from './constants.js';
import { getLang, loadArtworkDB } from './db.js';

const ADMIN_TOKEN_FIXED = 'artlens_admin';

const submitBtn = document.getElementById('submitBtn');
const statusEl = document.getElementById('statusMsg');

// === MAPPA OPENLAYERS ===
let selectedCoordinates = null; // qui salveremo l'array [[lat, lon], ...]

// === FUNZIONE: inizializza e mostra la mappa ===
function initMapOverlay(existingGeoJSON = null) {

  if (window.currentMap) {
    try {
      window.currentMap.setTarget(null); // distrugge la mappa vecchia
    } catch (_) {}
    window.currentMap = null;
  }

  const overlay = document.getElementById("mapOverlay");
  overlay.style.display = "flex";

  const MAX_SEGMENT_LENGTH_METERS = 1.0;

  const map = new ol.Map({
    target: "map",
    layers: [new ol.layer.Tile({ source: new ol.source.OSM() })],
    view: new ol.View({
      center: ol.proj.fromLonLat([12.0409, 44.2220]), // 📍 Forlì
      zoom: 16,
    }),
  });

  window.currentMap = map;

  // === Sorgenti e layer ===
  const polySource = new ol.source.Vector({ wrapX: false });
  const pointsSource = new ol.source.Vector({ wrapX: false });

  const polyLayer = new ol.layer.Vector({
    source: polySource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "rgba(0,128,255,0.8)", width: 2 }),
      fill: new ol.style.Fill({ color: "rgba(0,128,255,0.15)" }),
    }),
  });

  const pointsLayer = new ol.layer.Vector({
    source: pointsSource,
    style: new ol.style.Style({
      image: new ol.style.Circle({
        radius: 4,
        fill: new ol.style.Fill({ color: "red" }),
        stroke: new ol.style.Stroke({ color: "white", width: 1 }),
      }),
    }),
  });

  map.addLayer(polyLayer);
  map.addLayer(pointsLayer);

  // === Se esistono coordinate salvate, disegnale ===
  if (existingGeoJSON) {
      if (existingGeoJSON.type === "Point") {
          const [lon, lat] = existingGeoJSON.coordinates;
          const feature = new ol.Feature(
              new ol.geom.Point(ol.proj.fromLonLat([lon, lat]))
          );
          pointsSource.addFeature(feature);
          map.getView().setCenter(ol.proj.fromLonLat([lon, lat]));
          map.getView().setZoom(16);
      }
      else if (existingGeoJSON.type === "Polygon") {
          const coords = existingGeoJSON.coordinates[0].map(([lon, lat]) =>
              ol.proj.fromLonLat([lon, lat])
          );
          const feature = new ol.Feature(new ol.geom.Polygon([coords]));
          polySource.addFeature(feature);
          map.getView().fit(feature.getGeometry(), { padding: [30, 30, 30, 30] });
      }
  }


  let drawInteraction = null;
  let pointInteraction = null;

  // === Funzione di densificazione (interpola punti ogni 1m) ===
  function densifyRingByDistance(ring, maxDistanceMeters) {
    if (!ring || ring.length < 4) return ring;
    const isClosed =
      ring.length > 2 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1];
    const coords = isClosed ? ring.slice(0, -1) : ring.slice();
    const densified = [];

    for (let i = 0; i < coords.length; i++) {
      const a = coords[i];
      const b = coords[(i + 1) % coords.length];
      densified.push(a);

      const [lon1, lat1] = ol.proj.toLonLat(a);
      const [lon2, lat2] = ol.proj.toLonLat(b);
      const segLen = ol.sphere.getDistance([lon1, lat1], [lon2, lat2]);

      const nExtra = Math.floor(segLen / maxDistanceMeters);
      for (let k = 1; k <= nExtra; k++) {
        const t = k / (nExtra + 1);
        densified.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }

    densified.push(densified[0]);
    return densified;
  }

  // === Disegno poligono ===
  function toggleDrawingMode(enable) {
    // 🧹 reset layer
    polySource.clear();
    pointsSource.clear();

    if (enable) {
      if (drawInteraction) map.removeInteraction(drawInteraction);
      if (pointInteraction) map.removeInteraction(pointInteraction);

      drawInteraction = new ol.interaction.Draw({
        source: polySource,
        type: "Polygon",
      });

      drawInteraction.on("drawend", (e) => {
        const geom = e.feature.getGeometry();
        const rings = geom.getCoordinates();
        const densified = densifyRingByDistance(
          rings[0],
          MAX_SEGMENT_LENGTH_METERS
        );

        e.feature.setGeometry(new ol.geom.Polygon([densified]));
        pointsSource.clear();
        densified.forEach(([x, y]) =>
          pointsSource.addFeature(new ol.Feature(new ol.geom.Point([x, y])))
        );
      });

      map.addInteraction(drawInteraction);
    } else if (drawInteraction) {
      map.removeInteraction(drawInteraction);
      drawInteraction = null;
    }
  }

  // === Disegno punto singolo ===
  function toggleAddPointMode(enable) {
    // 🧹 reset layer
    polySource.clear();
    pointsSource.clear();

    if (enable) {
      if (drawInteraction) map.removeInteraction(drawInteraction);
      if (pointInteraction) map.removeInteraction(pointInteraction);

      pointInteraction = new ol.interaction.Draw({
        source: pointsSource,
        type: "Point",
      });

      map.addInteraction(pointInteraction);
    } else if (pointInteraction) {
      map.removeInteraction(pointInteraction);
      pointInteraction = null;
    }
  }

  // Permetti di modificare la geometria esistente
  const modify = new ol.interaction.Modify({
    source: polySource.getFeatures().length ? polySource : pointsSource,
  });
  map.addInteraction(modify);

  modify.on("modifyend", (e) => {
      const features = e.features.getArray();
      features.forEach((f) => {
          const geom = f.getGeometry();
          if (geom.getType() === "Polygon") {
              const rings = geom.getCoordinates();
              const densified = densifyRingByDistance(
                  rings[0],
                  MAX_SEGMENT_LENGTH_METERS
              );

              // aggiorna geometria
              f.setGeometry(new ol.geom.Polygon([densified]));

              // aggiorna i punti visivi
              pointsSource.clear();
              densified.forEach(([x, y]) =>
                  pointsSource.addFeature(new ol.Feature(new ol.geom.Point([x, y])))
              );
          }
      });
  });



  // === Eventi bottoni ===
  document.getElementById("drawBtn").onclick = () => toggleDrawingMode(true);
  document.getElementById("undoBtn").onclick = () => {
    if (drawInteraction) drawInteraction.removeLastPoint();
  };
  document.getElementById("addPointBtn").onclick = () =>
    toggleAddPointMode(true);
  document.getElementById("clearBtn").onclick = () => {
    polySource.clear();
    pointsSource.clear();
  };
  document.getElementById("closeMapBtn").onclick = () => {
    overlay.style.display = "none";
    if (window.currentMap) {
      window.currentMap.setTarget(null);
      window.currentMap = null;
    }
  };

  // ✅ Conferma coordinate
  document.getElementById("confirmBtn").onclick = () => {
      let geojson = null;

      // Se c'è un poligono
      const polyFeatures = polySource.getFeatures();
      const pointFeatures = pointsSource.getFeatures();

      if (polyFeatures.length > 0) {
          const f = polyFeatures[0];
          const coords = f.getGeometry().getCoordinates()[0].map(([x, y]) =>
              ol.proj.toLonLat([x, y])
          );

          // chiudi anello se non chiuso
          const first = coords[0];
          const last = coords[coords.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);

          geojson = {
              type: "Polygon",
              coordinates: [coords],
          };
      }

      // Se c'è un punto
      else if (pointFeatures.length > 0) {
          const f = pointFeatures[0];
          const [x, y] = f.getGeometry().getCoordinates();
          const [lon, lat] = ol.proj.toLonLat([x, y]);
          geojson = {
              type: "Point",
              coordinates: [lon, lat],
          };
      }

      if (!geojson) {
          alert("⚠️ Nessuna geometria selezionata!");
          return;
      }

      selectedCoordinates = geojson; // ora è un oggetto GeoJSON
      const hiddenInput = document.getElementById("location_coords");
      if (hiddenInput) hiddenInput.value = JSON.stringify(geojson);

      overlay.style.display = "none";
      console.log("✅ GeoJSON salvato:", geojson);
  };

  window.dispatchEvent(new Event("storage")); // forza applyLang()
}



function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg || '';
}
function setLoading(loading) {
  if (submitBtn) submitBtn.disabled = !!loading;
}

async function imageToCanvas224(file) {
  const can = document.createElement('canvas');
  can.width = can.height = CROP_SIZE;
  const ctx = can.getContext('2d', { willReadFrequently: true });
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  // Center-crop square then scale to 224
  const s = Math.min(img.width, img.height);
  const sx = Math.max(0, Math.floor((img.width - s) / 2));
  const sy = Math.max(0, Math.floor((img.height - s) / 2));
  ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
  ctx.drawImage(img, sx, sy, s, s, 0, 0, CROP_SIZE, CROP_SIZE);
  URL.revokeObjectURL(img.src);
  return can;
}

function buildDescriptions(fd) {
  const it = (fd.get('desc_it') || '').trim();
  const en = (fd.get('desc_en') || '').trim();
  const out = {};
  if (it) out.it = it;
  if (en) out.en = en;
  return Object.keys(out).length ? out : undefined;
}

function descriptorIdFor(file, index) {
  const base = (file.name || `img_${index+1}`)
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-') || `img-${index+1}`;
  return base;
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  setLoading(true);
  setStatus('Preparazione modello…');
  try {
    const filesInput = /** @type {HTMLInputElement} */ (document.querySelector('input[name="images"]'));
    const files = filesInput?.files;
    if (!files || !files.length) { alert('Seleziona almeno un’immagine'); return; }

    // Init model
    await initEmbeddingModel();

    // Compute embeddings locally
    const visual_descriptors = [];
    for (let i = 0; i < files.length; i++) {
      setStatus(`Calcolo embedding ${i+1}/${files.length}…`);
      const f = files[i];
      const can = await imageToCanvas224(f);
      const embedding = embedFromCanvas(can); // already L2-normalized (Float32Array)
      const embeddingArr = Array.from(embedding);
      visual_descriptors.push({ id: descriptorIdFor(f, i), embedding: embeddingArr });
    }

    const payload = {
      title: (fd.get('title') || '').trim() || null,
      artist: (fd.get('artist') || '').trim() || null,
      year: (fd.get('year') || '').trim() || null,
      descriptions: buildDescriptions(fd),
      location_coords: selectedCoordinates || null,
      visual_descriptors,
    };

    // Invia sempre il token admin fisso (niente più prompt)
    setStatus('Salvataggio in corso…');
    const res = await fetch(`${BACKEND_URL}/artworks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': ADMIN_TOKEN_FIXED
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${res.status} ${t}`);
    }
    const json = await res.json().catch(() => ({}));
    setStatus('Operazione completata. Aggiorno memoria…');
    try {
      await loadArtworkDB();
    } catch (e) {
      console.warn('Reload DB after upsert failed:', e);
    }
    setStatus('Operazione completata.');
    alert(`Opera salvata!\nID: ${json.id || '(generato)'}\nDescrittori: ${visual_descriptors.length}`);
    form.reset();
  } catch (err) {
    console.error('Admin save error:', err);
    setStatus('Errore durante il salvataggio.');
    alert(`Errore durante il salvataggio: ${err?.message || err}`);
  } finally {
    setLoading(false);
    setTimeout(() => setStatus(''), 1200);
  }
}

// === APRI MAPPA ===
document.getElementById("openMapBtn").addEventListener("click", () => {
  initMapOverlay();
});


const formEl = document.getElementById('f');
if (formEl) formEl.addEventListener('submit', onSubmit);

// Dashboard auth guard and UI helpers (migrated from manager_dashboard.html inline scripts)
(function(){
  // Detect curator dashboard by presence of main container or form
  const isDashboard = document.querySelector('.cdash') || document.getElementById('f');
  if (!isDashboard) return;

  // i18n dictionary for Manager Dashboard
  const I18N = {
    it: {
      title: 'Dashboard Gestore',
      subtitle: 'Gestisci l\'archivio dei monumenti della città',
      signOut: 'Esci',
      tabs: ['Aggiungi Monumento', 'Gestisci Archivio'],
      sectionTitle: 'Aggiungi Nuovo Monumento',
      dzStrong: 'Clicca per caricare',
      dzSmall: '',
      imagesLabel: "Immagini Monumento",
      fields: {
        title: { label: 'Titolo', ph: 'Inserisci il titolo del monumento' },
        artist: { label: 'Artista', ph: 'Inserisci il nome dell\'artista' },
        year: { label: 'Anno', ph: 'es. 1620 ca.' },
        desc_it: { label: 'Descrizione IT', ph: 'Descrizione in italiano' },
        desc_en: { label: 'Descrizione EN', ph: 'Descrizione in inglese' }
      },
      save: 'Salva Monumento',
      filesSelected: (n)=> n ? `${n} file selezionati` : '',
      manage: {
        sectionTitle: 'Gestione Archivio',
        countSuffix: 'monumenti in archivio',
        headers: { title: 'Titolo', images: 'Immagini', actions: '' },
        loadFailRow: 'Impossibile caricare l\'archivio',
        emptyRow: 'Nessun monumento presente',
        filesCount: (n)=> n===1 ? '1 file' : `${n} file`,
        edit: 'Modifica',
        delete: 'Elimina',
        confirmDeleteArtwork: 'Eliminare questa monumento? L’operazione non può essere annullata.',
        editArtwork: 'Modifica Monumento',
        close: 'Chiudi',
        fieldLabels: { Title:'Titolo', Artist:'Artista', Year:'Anno', ItalianDescription:'Descrizione Italiana', EnglishDescription:'Descrizione Inglese' },
        imageFiles: 'File Immagine',
        add: 'Aggiungi',
        cancel: 'Annulla',
        saveChanges: 'Salva Modifiche',
        deleteImageConfirm: (name)=> `Eliminare l’immagine "${name}"?`,
        remove: 'Rimuovi',
        tokenPrompt: 'Inserisci X-Admin-Token',
        deleteFailed: 'Eliminazione non riuscita: ',
        saveFailed: 'Salvataggio non riuscito: ',
        detailsLoadFailed: 'Impossibile caricare i dettagli del monumento'
      },
      map: {
          open: "🌍 Apri Mappa",
          hint: "Seleziona un punto o un poligono sulla mappa",
          draw: "✏️ Poligono",
          undo: "↩️ Annulla",
          addPoint: "📍 Punto",
          clear: "🗑️ Cancella",
          confirm: "✅ Conferma coordinate",
          close: "Chiudi"
      }
    },
    en: {
      title: 'Manager Dashboard',
      subtitle: "Manage the city's monuments' archive",
      signOut: 'Sign Out',
      tabs: ['Add Monument', 'Manage Archive'],
      sectionTitle: 'Add New Monument',
      dzStrong: 'Click to upload',
      dzSmall: '',
      imagesLabel: 'Monument Images',
      fields: {
        title: { label: 'Title', ph: 'Enter monument title' },
        artist: { label: 'Artist', ph: 'Enter artist name' },
        year: { label: 'Year', ph: 'e.g., 1620 ca.' },
        desc_it: { label: 'IT description', ph: 'Description in Italian' },
        desc_en: { label: 'EN description', ph: 'Description in English' }
      },
      save: 'Save Monument',
      filesSelected: (n)=> n ? `${n} file selected` : '',
      manage: {
        sectionTitle: 'Archive Management',
        countSuffix: 'monuments in archive',
        headers: { title: 'Title', images: 'Images', actions: '' },
        loadFailRow: 'Failed to load archive',
        emptyRow: 'No monuments yet',
        filesCount: (n)=> n===1 ? '1 file' : `${n} files`,
        edit: 'Edit',
        delete: 'Delete',
        confirmDeleteArtwork: 'Delete this monument? This cannot be undone.',
        editArtwork: 'Edit Monument',
        close: 'Close',
        fieldLabels: { Title:'Title', Artist:'Artist', Year:'Year', ItalianDescription:'Italian Description', EnglishDescription:'English Description' },
        imageFiles: 'Image Files',
        add: 'Add',
        cancel: 'Cancel',
        saveChanges: 'Save Changes',
        deleteImageConfirm: (name)=> `Delete image "${name}"?`,
        remove: 'Remove',
        tokenPrompt: 'Enter X-Admin-Token',
        deleteFailed: 'Delete failed: ',
        saveFailed: 'Save failed: ',
        detailsLoadFailed: 'Failed to load monument details'
      },
      map: {
          open: "🌍 Open Map",
          hint: "Select a point or a polygon on the map",
          draw: "✏️ Polygon",
          undo: "↩️ Undo",
          addPoint: "📍 Point",
          clear: "🗑️ Clear",
          confirm: "✅ Confirm Coordinates",
          close: "Close"
      }
    }
  };
  function t(){ return I18N[getLang()] || I18N.it; }

  function applyLang(){
    const lang = getLang();
    try { document.documentElement.setAttribute('lang', (lang === 'en' ? 'en' : 'it')); } catch {}
    const tr = t();

    const title = document.querySelector('.head .title');
    const subtitle = document.querySelector('.head .subtitle');
    if (title) title.innerHTML = (lang === 'en') ? 'Manager <br/>Dashboard' : 'Dashboard <br/>Gestore';
    if (subtitle) subtitle.innerHTML = (lang === 'en') ? "Manage the city's<br/>monuments' archive" : 'Gestisci l\'archivio dei monumenti<br/>della città';



    const signOut = document.querySelector('#signOutBtn span');
    if (signOut) signOut.textContent = tr.signOut;

    const tabs = document.querySelectorAll('.tabs .tab');
    if (tabs && tabs.length >= 2) {
      tabs[0].textContent = tr.tabs[0];
      tabs[1].textContent = tr.tabs[1];
    }

    const h2 = document.getElementById('addTitle');
    if (h2) {
      const ico = h2.querySelector('.h2-ico');
      h2.textContent = tr.sectionTitle;
      if (ico) { h2.prepend(ico); h2.insertBefore(document.createTextNode(' '), ico.nextSibling); }
    }

    const dz = document.getElementById('drop');
    if (dz) {
      const strong = dz.querySelector('strong');
      const small = dz.querySelector('small');
      if (strong) strong.textContent = tr.dzStrong;
      if (small) small.textContent = tr.dzSmall;
    }

    // Images field label (file input)
    const imgLabel = document.querySelector('label[for="images"]');
    if (imgLabel && tr.imagesLabel) imgLabel.textContent = tr.imagesLabel;

    // Manage section static labels
    try {
      const trm = tr.manage;
      const mt = document.getElementById('mgmtTitle');
      if (mt && trm?.sectionTitle) mt.textContent = trm.sectionTitle;
      const cnt = document.querySelector('.mgmt-count');
      if (cnt && trm?.countSuffix) {
        const n = (cnt.querySelector('#mgmtCount')?.textContent || '0');
        cnt.innerHTML = `<span id="mgmtCount">${n}</span> ${trm.countSuffix}`;
      }
      const th1 = document.querySelector('#collectionTable thead th:nth-child(1)');
      const th2 = document.querySelector('#collectionTable thead th:nth-child(2)');
      const th3 = document.querySelector('#collectionTable thead th:nth-child(3)');
      if (th1 && trm?.headers?.title) th1.textContent = trm.headers.title;
      if (th2 && trm?.headers?.images) th2.textContent = trm.headers.images;
      if (th3 && trm?.headers?.actions) th3.textContent = trm.headers.actions;
    } catch {}

    // --- MAP UI ---
    const trm = tr.map;
    const openMapBtn = document.getElementById("openMapBtn");
    if (openMapBtn && trm?.open) openMapBtn.textContent = trm.open;

    const mapHint = document.getElementById("mapHint");
    if (mapHint && trm?.hint) mapHint.textContent = trm.hint;

    const drawBtn = document.getElementById("drawBtn");
    if (drawBtn && trm?.draw) drawBtn.textContent = trm.draw;

    const undoBtn = document.getElementById("undoBtn");
    if (undoBtn && trm?.undo) undoBtn.textContent = trm.undo;

    const addPointBtn = document.getElementById("addPointBtn");
    if (addPointBtn && trm?.addPoint) addPointBtn.textContent = trm.addPoint;

    const clearBtn = document.getElementById("clearBtn");
    if (clearBtn && trm?.clear) clearBtn.textContent = trm.clear;

    const confirmBtn = document.getElementById("confirmBtn");
    if (confirmBtn && trm?.confirm) confirmBtn.textContent = trm.confirm;

    const closeMapBtn = document.getElementById("closeMapBtn");
    if (closeMapBtn && trm?.close) closeMapBtn.setAttribute("title", trm.close);


    // Fields labels and placeholders
    const map = [
      { id: 'title', key: 'title' },
      { id: 'artist', key: 'artist' },
      { id: 'year', key: 'year' },
      { id: 'desc_it', key: 'desc_it' },
      { id: 'desc_en', key: 'desc_en' }
    ];
    map.forEach(({id, key})=>{
      const input = document.getElementById(id);
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.textContent = tr.fields[key].label;
      if (input && 'placeholder' in input) input.placeholder = tr.fields[key].ph;
    });

    const saveBtn = document.getElementById('submitBtn');
    if (saveBtn) saveBtn.textContent = tr.save;
  }

  // Auth guard and optional logout handling
  try {
    const AUTH_KEY = 'artlens.auth';
    const qs = new URLSearchParams(location.search);
    if (qs.has('logout')) { try { localStorage.removeItem(AUTH_KEY); } catch(_) {} }
    const authed = !!localStorage.getItem(AUTH_KEY);
    if (!authed) { location.replace('./curator_access.html'); return; }
  } catch (e) {
    try { location.replace('./curator_access.html'); } catch(_) {}
    return;
  }

  applyLang();
  window.addEventListener('storage', (e)=>{ if (e.key === 'lang') applyLang(); });

  // Dropzone behavior for image uploads
  const drop = document.getElementById('drop');
  const input = document.getElementById('images');
  function openPicker(){ try { input?.click(); } catch(_) {} }
  function stop(e){ try { e.preventDefault(); e.stopPropagation(); } catch(_) {} }
  if (drop && input) {
    drop.addEventListener('click', openPicker);
    drop.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') { stop(e); openPicker(); }});
    ['dragenter','dragover'].forEach(ev=> drop.addEventListener(ev, (e)=>{ stop(e); drop.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev=> drop.addEventListener(ev, (e)=>{ stop(e); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e)=>{ const files = e.dataTransfer?.files; if (files?.length) { try { input.files = files; } catch(_) {} input.dispatchEvent(new Event('change',{bubbles:true})); }});
  }
  const out = document.getElementById('statusMsg');
  const previews = document.getElementById('previews');
  let previewURLs = [];
  function clearPreviews(){
    try { previewURLs.forEach(url => URL.revokeObjectURL(url)); } catch(_) {}
    previewURLs = [];
    if (previews) previews.innerHTML = '';
  }
  function renderPreviews(fileList){
    if (!previews) return;
    clearPreviews();
    const files = Array.from(fileList || []);
    const frag = document.createDocumentFragment();
    files.forEach((f)=>{
      if (!f || !f.type?.startsWith('image/')) return;
      const url = URL.createObjectURL(f);
      previewURLs.push(url);
      const fig = document.createElement('figure');
      fig.className = 'preview';
      const img = document.createElement('img');
      img.src = url; img.alt = 'Anteprima immagine';
      fig.appendChild(img);
      frag.appendChild(fig);
    });
    previews.appendChild(frag);
  }
  if (input) input.addEventListener('change', ()=>{
    const n = input.files?.length || 0;
    if (out) {
      try {
        const lang = getLang();
        const tr = (I18N[lang] || I18N.it);
        out.textContent = tr.filesSelected(n);
      } catch(_) {
        out.textContent = n ? `${n} file selected` : '';
      }
    }
    if (n) renderPreviews(input.files);
    else clearPreviews();
  });

  // Clear previews on form reset
  const form = document.getElementById('f');
  if (form) form.addEventListener('reset', ()=>{ clearPreviews(); if (out) out.textContent=''; });

  // Sign out
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn) signOutBtn.addEventListener('click', ()=>{ try { localStorage.removeItem('artlens.auth'); } catch(_) {} location.href = './manager_access.html'; });
  // ------------------------------
  // Manage Collection: tabs + table
  // ------------------------------
  const tabs = document.querySelectorAll('.tabs .tab');
  const addSection = document.getElementById('addSection');
  const manageSection = document.getElementById('manageSection');
  const tbody = document.getElementById('collectionBody');
  const countEl = document.getElementById('mgmtCount');

  function switchTab(idx){
    tabs.forEach((b,i)=>{ b.classList.toggle('active', i===idx); b.setAttribute('aria-selected', i===idx ? 'true' : 'false'); });
    if (addSection) addSection.style.display = (idx===0 ? '' : 'none');
    if (manageSection) manageSection.style.display = (idx===1 ? '' : 'none');
    if (idx===1) {
      // lazy load on first open or refresh every time
      loadCollection();
    }
  }

  tabs.forEach((b,i)=> b.addEventListener('click', ()=> switchTab(i)));

  function iconEdit(){
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
  }
  function iconTrash(){
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`;
  }

  async function loadCollection(){
    try {
      if (tbody) tbody.innerHTML = '';
      const res = await fetch(`${BACKEND_URL}/catalog?with_image_counts=1`);
      const items = await res.json();
      renderCollection(Array.isArray(items) ? items : []);
    } catch (e) {
      console.error('Load collection error', e);
      if (tbody) {
        const trm = (I18N[getLang()] || I18N.it).manage;
        tbody.innerHTML = `<tr><td colspan="3" style="color:#a33;">${trm.loadFailRow}</td></tr>`;
      }
    }
  }

  function renderCollection(items){
    if (countEl) countEl.textContent = String(items.length || 0);
    if (!tbody) return;
    const trm = (I18N[getLang()] || I18N.it).manage;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan=\"3\" style=\"color:#5e718f;\">${trm.emptyRow}</td></tr>`;
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((it)=>{
      const tr = document.createElement('tr');
      const n = Number(it.image_count||0);
      tr.innerHTML = `
        <td class=\"col-title\">${escapeHtml(it.title || '')}</td>
        <td class=\"col-images\">${trm.filesCount(n)}</td>
        <td class=\"col-actions\">
          <button class=\"btn-edit\" data-id=\"${it.id}\" type=\"button\" title=\"${trm.edit}\" aria-label=\"${trm.edit}\">${iconEdit()}</button>
          <button class=\"btn-del\" data-id=\"${it.id}\" type=\"button\" title=\"${trm.delete}\" aria-label=\"${trm.delete}\">${iconTrash()}</button>
        </td>
      `;
      frag.appendChild(tr);
    });
    tbody.innerHTML = '';
    tbody.appendChild(frag);

    // attach handlers
    tbody.querySelectorAll('.btn-del').forEach(btn=>{
      btn.addEventListener('click', async (e)=>{
        const id = e.currentTarget.getAttribute('data-id');
        if (!id) return;
        const trm = (I18N[getLang()] || I18N.it).manage;
        if (!confirm(trm.confirmDeleteArtwork)) return;
        try {
          const resp = await fetch(`${BACKEND_URL}/artworks/${encodeURIComponent(id)}`, { method:'DELETE', headers: { 'X-Admin-Token': ADMIN_TOKEN_FIXED }});
          if (!resp.ok) {
            const t = await resp.text();
            throw new Error(`${resp.status} ${t}`);
          }
          await loadCollection();
        } catch(err){
          const trm2 = (I18N[getLang()] || I18N.it).manage;
          alert(trm2.deleteFailed + (err?.message || err));
        }
      });
    });

    tbody.querySelectorAll('.btn-edit').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        const id = e.currentTarget.getAttribute('data-id');
        if (id) openEditModal(id);
      });
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"]+/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"})[c]);
  }

  // Default active tab = first (Add). Manage is lazy loaded on click.
  // If URL has ?tab=manage switch to it.
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('tab') === 'manage') switchTab(1);
  } catch {}

  // ------------------------------
  // Edit Modal
  // ------------------------------
  async function openEditModal(artId){
    const ov = document.createElement('div');
    ov.className = 'md-overlay';
    const trm = (I18N[getLang()] || I18N.it).manage;
    ov.innerHTML = `
      <div class="md-card" role="dialog" aria-modal="true" aria-labelledby="mdTitle">
        <div class="md-header">
          <h3 id="mdTitle" class="md-title">${trm.editArtwork}</h3>
          <button class="md-close" type="button" title="${trm.close}" aria-label="${trm.close}">&times;</button>
        </div>
        <div class="md-body">
          <div class="md-grid">
            <div>
              <div class="md-label">${trm.fieldLabels.Title}</div>
              <input id="md_title" class="md-input" />
            </div>
            <div>
              <div class="md-label">${trm.fieldLabels.Artist}</div>
              <input id="md_artist" class="md-input" />
            </div>
            <div>
              <div class="md-label">${trm.fieldLabels.Year}</div>
              <input id="md_year" class="md-input" />
            </div>
            <div class="full">
              <div class="md-label">${trm.fieldLabels.ItalianDescription}</div>
              <textarea id="md_desc_it" class="md-textarea"></textarea>
            </div>
            <div class="full">
              <div class="md-label">${trm.fieldLabels.EnglishDescription}</div>
              <textarea id="md_desc_en" class="md-textarea"></textarea>
            </div>
            <div class="full">
              <button id="editMapBtn" class="btn-primary" type="button">🌍 Modifica posizione su mappa</button>
              <input type="hidden" id="md_location_coords" />
            </div>

          </div>

          <div class="file-sec">
            <h3>${trm.imageFiles}</h3>
            <div id="md_file_list" class="file-list"></div>
            <div class="add-row">
              <button id="md_add_btn" class="add-btn" type="button">+ ${trm.add}</button>
              <input id="md_hidden_file" type="file" accept="image/*" multiple style="display:none" />
            </div>
          </div>

          <div class="md-footer">
            <button id="md_cancel" type="button" class="btn-cancel">${trm.cancel}</button>
            <button id="md_save" type="button" class="btn-primary">${trm.saveChanges}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(ov);

    // 🔥 Traduzione bottone mappa nel modal (dinamico)
    {
      const lang = getLang();
      const tr = (I18N[lang] || I18N.it).map;
      const editMapBtn = ov.querySelector("#editMapBtn");
      if (editMapBtn && tr?.open) {
        editMapBtn.textContent = tr.open;
      }
    }

    const close = ()=>{ try { ov.remove(); } catch(_){} };
    ov.querySelector('.md-close')?.addEventListener('click', close);
    ov.querySelector('#md_cancel')?.addEventListener('click', close);

    // Fetch details
    let data;
    try {
      const r = await fetch(`${BACKEND_URL}/artworks/${encodeURIComponent(artId)}`);
      if (!r.ok) throw new Error(await r.text());
      data = await r.json();
    } catch (e) {
      const trmE = (I18N[getLang()] || I18N.it).manage;
      alert(trmE.detailsLoadFailed);
      close();
      return;
    }

    // Prefill fields
    const $ = (id)=> ov.querySelector(id);
    $('#md_title').value = data.title || '';
    $('#md_artist').value = data.artist || '';
    $('#md_year').value = data.year || '';
    const desc = (data.descriptions && typeof data.descriptions === 'object') ? data.descriptions : {};
    $('#md_desc_it').value = desc.it || '';
    $('#md_desc_en').value = desc.en || '';

    // === Pulsante per aprire mappa ===
    const editMapBtn = ov.querySelector('#editMapBtn');
    const hiddenCoords = ov.querySelector('#md_location_coords');
    if (editMapBtn) {
      editMapBtn.addEventListener('click', () => {
        // Passa le coordinate esistenti (GeoJSON) se ci sono
        initMapOverlay(data.location_coords);
      });
    }

    const listEl = $('#md_file_list');
    const hiddenFile = $('#md_hidden_file');
    const addBtn = $('#md_add_btn');
    const addName = $('#md_add_filename');
    const usedIds = new Set((data.descriptors||[]).map(d=> String(d.descriptor_id)));
    const existing = Array.isArray(data.descriptors) ? [...data.descriptors] : [];
    const pending = [];

    function makeUnique(base){
      let b = base || 'img';
      let i = 2;
      while (usedIds.has(b)) { b = `${base}-${i++}`; }
      usedIds.add(b);
      return b;
    }

    function renderList(){
      if (!listEl) return;
      listEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      // Existing items
      existing.forEach((d)=>{
        const row = document.createElement('div');
        row.className = 'file-row';
        const trm = (I18N[getLang()] || I18N.it).manage;
        row.innerHTML = `<div class="file-name">${escapeHtml(d.descriptor_id)}</div>` +
          `<button class="file-del" type="button" title="${trm.delete}">${iconTrash()}</button>`;
        row.querySelector('.file-del').addEventListener('click', async ()=>{
          if (!confirm(trm.deleteImageConfirm(d.descriptor_id))) return;
          try {
            const resp = await fetch(`${BACKEND_URL}/artworks/${encodeURIComponent(artId)}/descriptors/${encodeURIComponent(d.descriptor_id)}`, { method:'DELETE', headers:{'X-Admin-Token': ADMIN_TOKEN_FIXED}});
            if (!resp.ok) throw new Error(await resp.text());
            const idx = existing.findIndex(x=> x.descriptor_id === d.descriptor_id);
            if (idx >= 0) existing.splice(idx,1);
            renderList();
          } catch (err){ alert('Delete failed: ' + (err?.message || err)); }
        });
        frag.appendChild(row);
      });
      // Pending items
      pending.forEach((p,idx)=>{
        const row = document.createElement('div');
        row.className = 'file-row';
        const trm = (I18N[getLang()] || I18N.it).manage;
        row.innerHTML = `<div class="file-name">${escapeHtml(p.filename || p.id)}</div>` +
          `<button class="file-del" type="button" title="${trm.remove}">${iconTrash()}</button>`;
        row.querySelector('.file-del').addEventListener('click', ()=>{
          pending.splice(idx,1);
          renderList();
        });
        frag.appendChild(row);
      });
      listEl.appendChild(frag);
    }

    renderList();

    addBtn?.addEventListener('click', ()=> hiddenFile?.click());
    hiddenFile?.addEventListener('change', async ()=>{
      const files = Array.from(hiddenFile.files || []);
      if (!files.length) return;
      if (addName) addName.value = files[0].name;
      await initEmbeddingModel();
      for (const f of files){
        const can = await imageToCanvas224(f);
        const embedding = embedFromCanvas(can);
        let base = descriptorIdFor(f, pending.length);
        base = makeUnique(base);
        pending.push({ id: base, filename: f.name, embedding });
      }
      hiddenFile.value = '';
      renderList();
    });

    function buildDescriptions(){
      const it = ($('#md_desc_it').value || '').trim();
      const en = ($('#md_desc_en').value || '').trim();
      const d = {}; if (it) d.it = it; if (en) d.en = en; return d;
    }

    $('#md_save')?.addEventListener('click', async ()=>{
      const payload = {
        id: artId,
        title: ($('#md_title').value || '').trim() || null,
        artist: ($('#md_artist').value || '').trim() || null,
        year: ($('#md_year').value || '').trim() || null,
        descriptions: buildDescriptions(),
        location_coords: selectedCoordinates || data.location_coords || null,
        visual_descriptors: pending.map(p=> ({ id: p.id, embedding: Array.isArray(p.embedding) ? p.embedding : Array.from(p.embedding || []) }))
      };
      try {
        const res = await fetch(`${BACKEND_URL}/artworks`, { method:'POST', headers:{ 'Content-Type':'application/json','X-Admin-Token': ADMIN_TOKEN_FIXED}, body: JSON.stringify(payload)});
        if (!res.ok) throw new Error(await res.text());
        try { await loadArtworkDB(); } catch (e) { console.warn('Reload DB after edit save failed:', e); }
        close();
        await loadCollection();
      } catch (err){
        const trm = (I18N[getLang()] || I18N.it).manage;
        alert(trm.saveFailed + (err?.message || err));
      }
    });
  }
})();
