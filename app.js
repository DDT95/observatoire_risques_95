(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const WMS = "https://www.georisques.gouv.fr/services";
  const API = "https://www.georisques.gouv.fr/api/v1";
  const PREF = "https://www.val-doise.gouv.fr/Actions-de-l-Etat/Environnement-risques-et-nuisances/Prevention-Risques/Risques-naturels/Les-plans-de-prevention-des-risques-naturels-PPRN";
  const bounds95 = L.latLngBounds([48.82, 1.60], [49.25, 2.62]);

  const map = L.map("map", { zoomControl: true, minZoom: 8, maxZoom: 19 });
  map.fitBounds(bounds95);
  map.createPane("baseTiles");
  map.getPane("baseTiles").style.zIndex = 200;
  map.createPane("riskTiles");
  map.getPane("riskTiles").style.zIndex = 350;
  map.getPane("riskTiles").style.pointerEvents = "none";
  map.createPane("overviewRisks");
  map.getPane("overviewRisks").style.zIndex = 420;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    pane: "baseTiles",
    attribution: "© OpenStreetMap · Données Géorisques"
  }).addTo(map);

  const defs = {
    PPRN_PERIMETRE_INOND: { title: "Périmètre des PPRI", family: "Inondation", opacity: 0.82 },
    PPRN_PERIMETRE_MVT: { title: "Périmètre des PPRN", family: "Mouvement de terrain", opacity: 0.78 },
    PPRN_ZONE_INOND: { title: "Zonage réglementaire PPRI", family: "Inondation", opacity: 0.82 },
    PPRN_ZONE_MVT: { title: "Zonage réglementaire PPRN", family: "Mouvement de terrain", opacity: 0.82 },
    ALEARG_REALISE: { title: "Retrait-gonflement des argiles", family: "Mouvement de terrain", opacity: 0.58 }
  };
  const layers = {};
  const preferences = { inond: true, mvt: true, argile: false };
  let activeNames = [];
  let searchMarker = null;
  let clickMarker = null;
  let localPprLayer = null;
  let riversLayer = null;
  let communesLayer = null;
  let suppressNextMapClick = false;

  function riskFamily(props = {}) {
    const text = `${props.nomass || ""} ${props.code_alea || ""}`.toLowerCase();
    return /ppri|inond|crue|seine|oise|epte|sausseron|aubette|presles/.test(text)
      ? "Inondation"
      : "Mouvement de terrain";
  }

  function riskColor(props = {}) {
    return riskFamily(props) === "Inondation" ? "#1479c9" : "#e76f00";
  }

  function humanPlanName(props = {}) {
    const catalog = window.PPR_DOCUMENTS?.[props.id_gaspar];
    if (catalog?.title) return catalog.title;
    return String(props.nomass || "Plan de prévention des risques")
      .replace(/^PM1_/, "")
      .replace(/_ass$/i, "")
      .replace(/PPRNMT/i, "PPR mouvements de terrain · ")
      .replace(/PPRI/i, "PPRI · ")
      .replace(/R1113/i, "Périmètre R.111-3 · ")
      .replace(/PER/i, "Périmètre de risque · ")
      .replace(/([a-zà-ÿ])([A-Z])/g, "$1 $2");
  }

  async function loadLocalContext() {
    try {
      const [pprResponse, riversResponse, communesResponse] = await Promise.all([
        fetch("data/ppr_perimetres_95.geojson"),
        fetch("data/rivieres_95.geojson"),
        fetch("data/communes_95.geojson")
      ]);
      if (!pprResponse.ok) throw new Error("Périmètres PPR indisponibles");
      const [pprData, riversData, communesData] = await Promise.all([
        pprResponse.json(),
        riversResponse.ok ? riversResponse.json() : null,
        communesResponse.ok ? communesResponse.json() : null
      ]);

      if (communesData) {
        communesLayer = L.geoJSON(communesData, {
          pane: "overlayPane",
          interactive: false,
          style: { color: "#59616b", weight: 0.7, opacity: 0.42, fillOpacity: 0 }
        }).addTo(map);
      }
      if (riversData) {
        riversLayer = L.geoJSON(riversData, {
          pane: "overlayPane",
          interactive: false,
          style: { color: "#2f80c9", weight: 1.1, opacity: 0.58 }
        }).addTo(map);
      }

      localPprLayer = L.geoJSON(pprData, {
        pane: "overviewRisks",
        style(feature) {
          const color = riskColor(feature.properties);
          return { color, fillColor: color, weight: 2.2, opacity: 0.96, fillOpacity: 0.34 };
        },
        onEachFeature(feature, layer) {
          const props = feature.properties || {};
          layer.bindTooltip(humanPlanName(props), { sticky: true, direction: "top" });
          layer.on({
            mouseover() { layer.setStyle({ weight: 3.5, fillOpacity: 0.52 }); },
            mouseout() { localPprLayer.resetStyle(layer); },
            click(event) {
              suppressNextMapClick = true;
              L.DomEvent.stopPropagation(event);
              openLocalRisk(feature, event.latlng);
              setTimeout(() => { suppressNextMapClick = false; }, 0);
            }
          });
        },
        filter(feature) {
          const family = riskFamily(feature.properties);
          return family === "Inondation" ? preferences.inond : preferences.mvt;
        }
      }).addTo(map);
      setStatus(`${pprData.features.length} périmètres PPR chargés`);
    } catch (error) {
      console.error(error);
      setStatus("Périmètres locaux indisponibles", false);
    }
  }

  function refreshLocalPprs() {
    if (!localPprLayer) return;
    fetch("data/ppr_perimetres_95.geojson")
      .then((response) => response.json())
      .then((data) => {
        localPprLayer.clearLayers();
        localPprLayer.addData({
          ...data,
          features: data.features.filter((feature) => {
            const family = riskFamily(feature.properties);
            return family === "Inondation" ? preferences.inond : preferences.mvt;
          })
        });
      })
      .catch(console.warn);
  }

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
      pane: "riskTiles",
      attribution: "Géorisques"
    });
  }

  Object.keys(defs).forEach((name) => {
    layers[name] = buildLayer(name);
  });

  document.querySelectorAll(".layer-row").forEach((row) => {
    const family = row.dataset.family;
    const input = row.querySelector("input");
    preferences[family] = input.checked;
    input.addEventListener("change", () => {
      preferences[family] = input.checked;
      if (family === "inond" || family === "mvt") refreshLocalPprs();
      updateScaleDisplay();
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
  }

  function setLayerVisible(name, visible) {
    if (visible && !map.hasLayer(layers[name])) layers[name].addTo(map);
    if (!visible && map.hasLayer(layers[name])) map.removeLayer(layers[name]);
  }

  function updateScaleDisplay() {
    const detail = map.getZoom() >= 13;
    setLayerVisible("PPRN_PERIMETRE_INOND", false);
    setLayerVisible("PPRN_PERIMETRE_MVT", false);
    setLayerVisible("PPRN_ZONE_INOND", preferences.inond && detail);
    setLayerVisible("PPRN_ZONE_MVT", preferences.mvt && detail);
    setLayerVisible("ALEARG_REALISE", preferences.argile && detail);
    if (localPprLayer) {
      localPprLayer.setStyle((feature) => {
        const color = riskColor(feature.properties);
        return {
          color, fillColor: color,
          weight: detail ? 1.5 : 2.2,
          opacity: detail ? 0.72 : 0.96,
          fillOpacity: detail ? 0.12 : 0.34
        };
      });
    }
    refreshActiveLayers();

    const badge = $("#zoom-level");
    if (!badge) return;
    badge.dataset.mode = detail ? "detail" : "overview";
    badge.innerHTML = detail
      ? "<strong>Zonages réglementaires</strong><span>Cliquez sur une couleur pour lire la règle</span>"
      : "<strong>Vue départementale</strong><span>Périmètres PPRI et PPRN visibles</span>";
  }
  updateScaleDisplay();
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
    if (clickMarker) map.removeLayer(clickMarker);
    clickMarker = L.circleMarker(latlng, {
      radius: 7,
      color: "#000091",
      weight: 3,
      fillColor: "#ffffff",
      fillOpacity: 1,
      pane: "markerPane"
    }).addTo(map);
    setStatus("Lecture de la zone…");
    $("#progress-bar").style.width = "55%";
    const ordered = [...activeNames].reverse();
    for (const name of ordered) {
      try {
        const response = await fetch(featureInfoUrl(latlng, name), { cache: "no-store" });
        if (!response.ok) continue;
        const text = await response.text();
        const features = parseFeatureInfo(text);
        if (features.length) {
          await openRisk(features, name, latlng);
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
    if (!/Feature\s+[^:]+:/i.test(text)) return [];
    return text
      .split(/\n\s*Feature\s+[^:]+:\s*\n/i)
      .slice(1)
      .map((block) => {
        const props = {};
        for (const line of block.split("\n")) {
          const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*'(.*)'\s*$/);
          if (match) props[match[1]] = match[2];
        }
        return props;
      })
      .filter((props) => Object.keys(props).length);
  }

  async function fetchJson(url, timeout = 6500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveCommune(latlng, featureProps = {}) {
    const featureCity = valueFrom(featureProps, [
      "nom_commune", "commune", "lib_commune", "nomcom", "nom_com"
    ], "");
    const featureInsee = valueFrom(featureProps, [
      "code_insee", "codeinsee", "insee_com", "insee", "code_com"
    ], "");
    if (featureCity && featureCity !== "Non renseigné" && /^\d{5}$/.test(String(featureInsee))) {
      return { city: featureCity, insee: String(featureInsee), label: featureCity };
    }

    // Source principale : référentiel officiel des communes, interrogé au point cliqué.
    try {
      const url = `https://geo.api.gouv.fr/communes?lat=${encodeURIComponent(latlng.lat)}&lon=${encodeURIComponent(latlng.lng)}&fields=nom,code&format=json`;
      const communes = await fetchJson(url);
      const commune = Array.isArray(communes) ? communes[0] : null;
      if (commune?.nom && commune?.code) {
        return { city: commune.nom, insee: String(commune.code), label: commune.nom };
      }
    } catch (error) {
      console.warn("Résolution commune (API Découpage administratif)", error);
    }

    // Secours : géocodage inverse IGN.
    try {
      const url = `https://data.geopf.fr/geocodage/reverse?lon=${encodeURIComponent(latlng.lng)}&lat=${encodeURIComponent(latlng.lat)}&limit=1`;
      const data = await fetchJson(url);
      const p = data.features?.[0]?.properties || {};
      const city = p.city || p.city_name || p.municipality || p.commune;
      const insee = p.citycode || p.city_code || p.insee;
      if (city && insee) return { city, insee: String(insee), label: p.label || city };
    } catch (error) {
      console.warn("Résolution commune (géocodage IGN)", error);
    }

    return { city: "Commune non déterminée", insee: "", label: "" };
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
    const catalog = window.PPR_DOCUMENTS?.[ppr.idGaspar];
    const documents = catalog?.documents || [];
    if (!documents.length) {
      return `<div class="notice"><strong>Aucun PDF numérisé dans Géorisques pour ce dossier.</strong><br>
        Le plan est bien recensé, mais aucune pièce directe n’est publiée dans le catalogue national.</div>`;
    }
    return documents.map((document) => `
      <div class="document-card">
        <div>
          <strong>${escapeHtml(document.type)}</strong>
          <small>${escapeHtml(document.title || ppr.libPpr)} · ${escapeHtml(document.date || "date non renseignée")}</small>
        </div>
        <a href="${escapeHtml(document.url)}" target="_blank" rel="noopener" download>Télécharger le PDF</a>
      </div>`).join("");
  }

  function combinedDocumentLinks(ppr) {
    const remote = window.PPR_DOCUMENTS?.[ppr.idGaspar]?.documents?.length
      ? documentLinks(ppr)
      : "";
    return remote || `<div class="notice">Aucun document PDF en ligne n’est actuellement rattaché à ce périmètre.</div>`;
  }

  async function openLocalRisk(feature, latlng) {
    const props = feature.properties || {};
    const family = riskFamily(props);
    const place = await resolveCommune(latlng, props);
    const idGaspar = props.id_gaspar || "";
    const catalog = window.PPR_DOCUMENTS?.[idGaspar] || {};
    const title = humanPlanName(props);
    const ppr = {
      idGaspar,
      libPpr: title,
      libBassinRisques: catalog.territory || place.city
    };

    if (clickMarker) map.removeLayer(clickMarker);
    clickMarker = L.circleMarker(latlng, {
      radius: 7, color: "#000091", weight: 3, fillColor: "#fff", fillOpacity: 1
    }).addTo(map);

    $("#drawer-title").textContent = place.city;
    $("#drawer-sub").textContent = title;
    $("#summary-status").textContent = family;
    $("#summary-date").textContent = idGaspar || "Donnée officielle";
    $("#summary-text").textContent = summaryFor(family, props.typeass);

    const firstDocument = catalog.documents?.[0]?.url || catalog.fiche || "";
    $("#btn-export").href = firstDocument || "#";
    $("#btn-export").textContent = firstDocument ? "Lire le document principal" : "Aucun PDF direct disponible";
    $("#btn-export").classList.toggle("disabled", !firstDocument);

    $("#drawer-body").innerHTML = `
      <div class="section-title">Synthèse de la zone cliquée</div>
      <div class="block">
        <div class="block-title">${escapeHtml(title)}</div>
        <p class="risk-explainer">${escapeHtml(summaryFor(family, props.typeass))}</p>
        <div class="data-grid">
          <div class="data-row"><div class="l">Commune du clic</div><div class="v">${escapeHtml(place.city)}</div></div>
          <div class="data-row"><div class="l">Code INSEE</div><div class="v">${escapeHtml(place.insee || "—")}</div></div>
          <div class="data-row"><div class="l">Famille de risque</div><div class="v">${escapeHtml(family)}</div></div>
          <div class="data-row"><div class="l">Nature du périmètre</div><div class="v">${escapeHtml(props.typeass || "Enveloppe du plan")}</div></div>
          <div class="data-row"><div class="l">Identifiant GASPAR</div><div class="v">${escapeHtml(idGaspar || "—")}</div></div>
        </div>
      </div>
      <div class="section-title">Documents officiels</div>
      <div class="block">
        <div class="block-title">${escapeHtml(catalog.title || title)}</div>
        ${combinedDocumentLinks(ppr)}
      </div>
      <div class="notice">Le périmètre coloré indique l’emprise générale du plan. À partir du zoom 13, les zonages réglementaires détaillés de Géorisques se superposent. Les documents approuvés font foi.</div>`;
    $("#drawer").classList.add("open");
    setStatus("Zone et commune identifiées");
  }

  async function openRisk(features, layerName, latlng) {
    const props = features[0] || {};
    const def = defs[layerName];
    const place = await resolveCommune(latlng, props);

    let pprs = [];
    try { pprs = await loadPprs(place.insee); } catch (error) { console.warn(error); }
    const relevant = pprs.filter((p) => {
      const model = String(p.modeleProcedure || "");
      return def.family === "Inondation" ? model.includes("-I") : !model.includes("-I");
    });
    const clickedGasparIds = features
      .map((item) => valueFrom(item, ["id_gaspar", "idGaspar"], ""))
      .filter(Boolean);
    const matched = pprs.filter((p) => clickedGasparIds.includes(p.idGaspar));
    const catalogMatches = clickedGasparIds
      .filter((id) => window.PPR_DOCUMENTS?.[id])
      .map((id) => {
        const catalog = window.PPR_DOCUMENTS[id];
        return {
          idGaspar: id,
          libPpr: catalog.title || id,
          libBassinRisques: catalog.territory || place.city,
          modeleProcedure: catalog.type || "",
          dateModification: "",
          etatRevision: false,
          zonageReglementaire: { zoneRegExists: true }
        };
      });
    const displayedPprs = matched.length
      ? matched
      : catalogMatches.length
        ? catalogMatches
        : relevant.length
          ? relevant
          : pprs;
    const chosen = displayedPprs[0] || null;
    const zoneName = valueFrom(props, ["nom", "libelle", "codezone", "code_zone", "typezone", "lib_ppr"], def.title);
    const rule = valueFrom(props, ["libelle", "type_reg", "typereg", "reglement", "codezone", "libelle_sous_etat"], chosen?.zonageReglementaire?.listTypeReg?.[0]?.libelle || "Zonage à vérifier");

    $("#drawer-title").textContent = place.city;
    $("#drawer-sub").textContent = `${def.title} · ${zoneName}`;
    $("#summary-status").textContent = def.family;
    $("#summary-date").textContent = chosen?.dateModification || "Donnée officielle";
    $("#summary-text").textContent = summaryFor(def.family, rule);

    const primaryDocument = chosen ? window.PPR_DOCUMENTS?.[chosen.idGaspar]?.documents?.[0] : null;
    $("#btn-export").href = primaryDocument?.url || "#";
    $("#btn-export").textContent = primaryDocument ? "Télécharger un document PDF" : "Aucun PDF direct disponible";
    $("#btn-export").classList.toggle("disabled", !primaryDocument);

    const pprHtml = displayedPprs.length
      ? displayedPprs.map((p) => `
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
    $("#btn-export").href = "#";
    $("#btn-export").textContent = "Aucun PDF direct disponible";
    $("#btn-export").classList.add("disabled");
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

  map.on("click", (event) => {
    if (!suppressNextMapClick) identify(event.latlng);
  });
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
  loadLocalContext().then(updateScaleDisplay);
})();
