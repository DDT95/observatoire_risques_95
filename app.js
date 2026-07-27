(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const WMS = "https://www.georisques.gouv.fr/services";
  const API = "https://www.georisques.gouv.fr/api/v1";
  const PREF = "https://www.val-doise.gouv.fr/Actions-de-l-Etat/Environnement-risques-et-nuisances/Prevention-Risques/Risques-naturels/Les-plans-de-prevention-des-risques-naturels-PPRN";
  const bounds95 = L.latLngBounds([48.82, 1.60], [49.25, 2.62]);

  const map = L.map("map", { zoomControl: true, maxZoom: 19 });
  map.fitBounds(bounds95);
  map.createPane("baseTiles");
  map.getPane("baseTiles").style.zIndex = 200;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    pane: "baseTiles",
    attribution: "© OpenStreetMap · Données Géorisques"
  }).addTo(map);

  const defs = {
    PPRN_ZONE_INOND: { title: "Zonage réglementaire PPRI", family: "Inondation", opacity: 0.78 },
    PPRN_ZONE_MVT: { title: "Zonage réglementaire PPRN", family: "Mouvement de terrain", opacity: 0.78 },
    ALEARG_REALISE: { title: "Retrait-gonflement des argiles", family: "Mouvement de terrain", opacity: 0.48 },
    PPRN_PERIMETRE_INOND: { title: "Périmètre de PPRI", family: "Inondation", opacity: 0.62 }
  };
  const layers = {};
  let activeNames = [];
  let searchMarker = null;

  function setStatus(text, ok = true) {
    $("#live-text").textContent = text;
    $("#live-sub").textContent = "Géorisques + Préfecture";
    $("#live-dot").className = `live-dot ${ok ? "ok" : "ko"}`;
  }

  function buildLayer(name) {
    return L.tileLayer.wms(WMS, {
      layers: name,
      format: "image/png",
      transparent: true,
      opacity: defs[name].opacity,
      version: "1.3.0",
      attribution: "Géorisques"
    });
  }

  document.querySelectorAll(".layer-row").forEach((row) => {
    const name = row.dataset.layer;
    layers[name] = buildLayer(name);
    const input = row.querySelector("input");
    if (input.checked) layers[name].addTo(map);
    input.addEventListener("change", () => {
      if (input.checked) layers[name].addTo(map);
      else map.removeLayer(layers[name]);
      refreshActiveLayers();
    });
    row.addEventListener("click", (event) => {
      if (event.target.closest("input, label")) return;
      input.checked = !input.checked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });

  function refreshActiveLayers() {
    activeNames = Object.keys(layers).filter((name) => map.hasLayer(layers[name]));
    setStatus(activeNames.length ? `${activeNames.length} couche${activeNames.length > 1 ? "s" : ""} active${activeNames.length > 1 ? "s" : ""}` : "Aucune couche active", activeNames.length > 0);
    updateScaleDisplay();
  }

  function updateScaleDisplay() {
    const zoom = map.getZoom();
    const overview = zoom <= 10;
    const transition = zoom === 11 || zoom === 12;
    const exactOpacity = overview ? 0.46 : transition ? 0.64 : 0.84;
    const perimeterOpacity = overview ? 0.72 : transition ? 0.42 : 0.18;

    ["PPRN_ZONE_INOND", "PPRN_ZONE_MVT"].forEach((name) => {
      if (layers[name]) layers[name].setOpacity(exactOpacity);
    });
    if (layers.PPRN_PERIMETRE_INOND) {
      layers.PPRN_PERIMETRE_INOND.setOpacity(perimeterOpacity);
    }

    const badge = $("#zoom-level");
    if (!badge) return;
    badge.dataset.mode = overview ? "overview" : transition ? "transition" : "detail";
    badge.innerHTML = overview
      ? "<strong>Vue départementale</strong><span>Périmètres et zones principales</span>"
      : transition
        ? "<strong>Vue intermédiaire</strong><span>Les zonages précis apparaissent</span>"
        : "<strong>Zonages détaillés</strong><span>Cliquez pour lire la réglementation</span>";
  }
  refreshActiveLayers();
  map.on("zoomend", updateScaleDisplay);

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function valueFrom(props, keys, fallback = "Non renseigné") {
    for (const key of keys) {
      const found = Object.keys(props || {}).find((k) => k.toLowerCase() === key.toLowerCase());
      if (found && props[found] !== null && props[found] !== "") return props[found];
    }
    return fallback;
  }

  function featureInfoUrl(latlng, layerName) {
    const size = map.getSize();
    const point = map.latLngToContainerPoint(latlng);
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
    const params = new URLSearchParams({
      service: "WMS", request: "GetFeatureInfo", version: "1.1.1",
      layers: layerName, query_layers: layerName, styles: "",
      bbox, width: size.x, height: size.y, srs: "EPSG:4326",
      x: Math.round(point.x), y: Math.round(point.y),
      info_format: "text/plain", feature_count: "10"
    });
    return `${WMS}?${params}`;
  }

  async function identify(latlng) {
    if (!activeNames.length) return;
    setStatus("Lecture de la zone…");
    $("#progress-bar").style.width = "55%";
    const ordered = [...activeNames].reverse();
    for (const name of ordered) {
      try {
        const response = await fetch(featureInfoUrl(latlng, name), { cache: "no-store" });
        if (!response.ok) continue;
        const text = await response.text();
        const properties = parseFeatureInfo(text);
        if (properties) {
          await openRisk({ properties }, name, latlng);
          $("#progress-bar").style.width = "100%";
          setTimeout(() => $("#progress-bar").style.width = "0", 400);
          return;
        }
      } catch (error) {
        console.warn("Identification WMS", name, error);
      }
    }
    openEmpty(latlng);
    $("#progress-bar").style.width = "0";
    setStatus("Aucune zone à cet endroit");
  }

  function parseFeatureInfo(text) {
    if (!/Feature\s+\d+\s*:/i.test(text)) return null;
    const first = text.split(/\n\s*Feature\s+\d+\s*:\s*\n/i)[1] || "";
    const props = {};
    for (const line of first.split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*'(.*)'\s*$/);
      if (match) props[match[1]] = match[2];
    }
    return Object.keys(props).length ? props : null;
  }

  async function reverseGeocode(latlng) {
    const url = `https://api-adresse.data.gouv.fr/reverse/?lon=${latlng.lng}&lat=${latlng.lat}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Géocodage indisponible");
    const data = await response.json();
    const p = data.features?.[0]?.properties || {};
    return { city: p.city || p.municipality || "Commune non identifiée", insee: p.citycode || "", label: p.label || "" };
  }

  async function loadPprs(codeInsee) {
    if (!codeInsee?.startsWith("95")) return [];
    const response = await fetch(`${API}/gaspar/pprn?codeInsee=${encodeURIComponent(codeInsee)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Procédures PPR indisponibles");
    return (await response.json()).content || [];
  }

  function summaryFor(family, rule) {
    const r = String(rule || "").toLowerCase();
    if (r.includes("interdiction") || r.includes("rouge")) {
      return "Cette zone est soumise à un principe d’interdiction ou à des contraintes fortes. Le règlement officiel doit être consulté avant tout projet.";
    }
    if (r.includes("prescription") || r.includes("bleu")) {
      return "Les projets peuvent être admis sous conditions. Des prescriptions de construction, d’usage ou de protection peuvent s’appliquer.";
    }
    if (family === "Inondation") {
      return "Le secteur est concerné par un zonage lié aux inondations. La couleur affichée ne suffit pas juridiquement : le règlement et la carte approuvée font foi.";
    }
    return "Le secteur est concerné par un aléa ou un zonage réglementaire. La fiche ci-dessous résume l’information ; les documents approuvés restent la référence.";
  }

  function documentLinks(ppr) {
    const fiche = `https://www.georisques.gouv.fr/donnee-risques/PPR/Fiche-ppr/pprn/${encodeURIComponent(ppr.idGaspar)}`;
    return `
      <div class="document-card">
        <div><strong>Dossier officiel Géorisques</strong><small>Arrêté, règlement, rapport et cartes PDF disponibles selon le dossier</small></div>
        <a href="${fiche}" target="_blank" rel="noopener">Lire et télécharger les PDF</a>
      </div>`;
  }

  async function openRisk(feature, layerName, latlng) {
    const props = feature.properties || {};
    const def = defs[layerName];
    let place = { city: "Val-d’Oise", insee: "", label: "" };
    try { place = await reverseGeocode(latlng); } catch (error) { console.warn(error); }

    let pprs = [];
    try { pprs = await loadPprs(place.insee); } catch (error) { console.warn(error); }
    const relevant = pprs.filter((p) => {
      const model = String(p.modeleProcedure || "");
      return def.family === "Inondation" ? model.includes("-I") : !model.includes("-I");
    });
    const clickedGaspar = valueFrom(props, ["id_gaspar", "idGaspar"], "");
    const chosen = pprs.find((p) => p.idGaspar === clickedGaspar) || relevant[0] || pprs[0] || null;
    const zoneName = valueFrom(props, ["nom", "libelle", "codezone", "code_zone", "typezone"], def.title);
    const rule = valueFrom(props, ["libelle", "type_reg", "typereg", "reglement", "codezone"], chosen?.zonageReglementaire?.listTypeReg?.[0]?.libelle || "Zonage à vérifier");

    $("#drawer-title").textContent = place.city;
    $("#drawer-sub").textContent = `${def.title} · ${zoneName}`;
    $("#summary-status").textContent = def.family;
    $("#summary-date").textContent = chosen?.dateModification || "Donnée officielle";
    $("#summary-text").textContent = summaryFor(def.family, rule);

    const primaryLink = chosen
      ? `https://www.georisques.gouv.fr/donnee-risques/PPR/Fiche-ppr/pprn/${encodeURIComponent(chosen.idGaspar)}`
      : PREF;
    $("#btn-export").href = primaryLink;
    $("#btn-export").classList.remove("disabled");

    const pprHtml = pprs.length
      ? pprs.map((p) => `
          <div class="block">
            <div class="block-title">${escapeHtml(p.libPpr)}</div>
            <div class="data-grid">
              <div class="data-row"><div class="l">Identifiant</div><div class="v">${escapeHtml(p.idGaspar)}</div></div>
              <div class="data-row"><div class="l">Statut</div><div class="v">${p.etatRevision ? "En révision" : "Procédure recensée"}</div></div>
              <div class="data-row"><div class="l">Territoire</div><div class="v">${escapeHtml(p.libBassinRisques || place.city)}</div></div>
              <div class="data-row"><div class="l">Zonage</div><div class="v">${p.zonageReglementaire?.zoneRegExists ? "Disponible" : "Non numérisé"}</div></div>
            </div>
            ${documentLinks(p)}
          </div>`).join("")
      : `<div class="notice"><strong>Aucune procédure PPR remontée pour cette commune.</strong><br>Consultez le dossier départemental de la Préfecture pour vérifier les documents locaux.</div>`;

    $("#drawer-body").innerHTML = `
      <div class="section-title">Synthèse de la zone cliquée</div>
      <div class="block">
        <div class="block-title">${escapeHtml(zoneName)}</div>
        <p class="risk-explainer">${escapeHtml(summaryFor(def.family, rule))}</p>
        <div class="data-grid">
          <div class="data-row"><div class="l">Famille de risque</div><div class="v">${escapeHtml(def.family)}</div></div>
          <div class="data-row"><div class="l">Règle / classe</div><div class="v">${escapeHtml(rule)}</div></div>
          <div class="data-row"><div class="l">Commune</div><div class="v">${escapeHtml(place.city)}</div></div>
          <div class="data-row"><div class="l">Code INSEE</div><div class="v">${escapeHtml(place.insee || "—")}</div></div>
        </div>
      </div>
      <div class="section-title">Plans et documents officiels</div>
      ${pprHtml}
      <div class="notice">Information cartographique indicative. Les cartes et règlements approuvés annexés aux arrêtés préfectoraux demeurent opposables.</div>`;
    $("#drawer").classList.add("open");
    setStatus("Zone identifiée");
  }

  function openEmpty(latlng) {
    $("#drawer-title").textContent = "Aucune zone identifiée";
    $("#drawer-sub").textContent = `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
    $("#summary-status").textContent = "Hors zone visible";
    $("#summary-date").textContent = "—";
    $("#summary-text").textContent = "Aucune des couches actuellement actives ne renvoie de zonage à cet endroit.";
    $("#drawer-body").innerHTML = `<div class="notice">Activez d’autres couches dans le panneau de gauche ou cliquez sur une zone colorée.</div>`;
    $("#btn-export").href = PREF;
    $("#btn-export").classList.remove("disabled");
    $("#drawer").classList.add("open");
  }

  async function search(query) {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=6&autocomplete=0`;
    setStatus("Recherche en cours…");
    const response = await fetch(url);
    const data = await response.json();
    const item = data.features?.find((f) => String(f.properties?.citycode || "").startsWith("95")) || data.features?.[0];
    if (!item) throw new Error("Adresse introuvable");
    const [lng, lat] = item.geometry.coordinates;
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.circleMarker([lat, lng], { radius: 8, color: "#000091", weight: 3, fillColor: "#fff", fillOpacity: 1 }).addTo(map);
    map.setView([lat, lng], 16);
    await identify(L.latLng(lat, lng));
  }

  map.on("click", (event) => identify(event.latlng));
  $("#search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("#search-input").value.trim();
    if (!query) return;
    try { await search(query); }
    catch (error) { setStatus(error.message || "Recherche impossible", false); }
  });
  $("#btn-valdoise").addEventListener("click", () => map.fitBounds(bounds95));
  $("#btn-locate").addEventListener("click", () => map.locate({ setView: true, maxZoom: 16 }));
  map.on("locationfound", (event) => identify(event.latlng));
  map.on("locationerror", () => setStatus("Localisation refusée", false));
  $("#drawer-close").addEventListener("click", () => $("#drawer").classList.remove("open"));
})();
