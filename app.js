(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const WMS = "https://www.georisques.gouv.fr/services";
  const API = "https://www.georisques.gouv.fr/api/v1";
  const PREF = "https://www.val-doise.gouv.fr/Actions-de-l-Etat/Environnement-risques-et-nuisances/Prevention-Risques/Risques-naturels/Les-plans-de-prevention-des-risques-naturels-PPRN";
  const bounds95 = L.latLngBounds([48.89, 1.60], [49.25, 2.62]);

  const map = L.map("map", { zoomControl: true, minZoom: 8, maxZoom: 19 });
  map.fitBounds(bounds95, { padding: [8, 8] });
  map.createPane("baseTiles");
  map.getPane("baseTiles").style.zIndex = 200;
  map.createPane("riskTiles");
  map.getPane("riskTiles").style.zIndex = 350;
  map.getPane("riskTiles").style.pointerEvents = "none";
  map.createPane("departmentMask");
  map.getPane("departmentMask").style.zIndex = 260;
  map.getPane("departmentMask").style.pointerEvents = "none";
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
  const preferences = { inond: true, mvt: true, argile: false, ruissellement: false, tri: false, azi: false, radon: false, cavites: false, icpe: false };
  let activeNames = [];
  let searchMarker = null;
  let clickMarker = null;
  let localPprLayer = null;
  let riversLayer = null;
  let communesLayer = null;
  let communesGeo = null;
  let ruissellementLayer = null;
  let suppressNextMapClick = false;

  // Couches par commune (polygones surlignés) : chemin et paramètres confirmés sur le client
  // swagger généré à partir de la spec officielle Géorisques (vorpax/python-client-generated).
  // Piège documenté : PPRN/PPRT utilisent `codeInsee` (camelCase), tout le reste de l'API v1
  // (dont gaspar/tri, gaspar/azi, radon) utilise `code_insee` (snake_case).
  const communeLayers = { tri: null, azi: null, radon: null };
  const communeCache = { tri: null, azi: null, radon: null };
  const radonColors = { 1: "#8ec9a4", 2: "#e8b04b", 3: "#c65f52" };
  const communeFamilies = {
    tri: {
      path: "gaspar/tri", label: "TRI", color: "#0f8b8d", dash: "6 4",
      explain: "Un Territoire à Risque important d’Inondation (TRI) est un secteur où l’État concentre l’évaluation et la gestion du risque d’inondation, au titre de la directive européenne Inondation (2007/60/CE). Son classement ne dispense pas de consulter le PPRI applicable, qui reste la référence réglementaire."
    },
    azi: {
      path: "gaspar/azi", label: "AZI", color: "#1479c9", dash: null,
      explain: "L’Atlas des Zones Inondables (AZI) cartographie l’emprise des inondations historiques ou modélisées, à titre de connaissance. Il n’a pas de portée réglementaire directe : c’est le PPRI, lorsqu’il existe, qui fixe les règles applicables."
    },
    radon: {
      path: "radon", label: "Radon", color: null, dash: null,
      explain: "Le radon est un gaz radioactif naturel qui peut s’accumuler dans les bâtiments. Chaque commune est classée en une des trois classes de potentiel radon, de la plus faible (1) à la plus significative (3). Ce classement ne signifie pas qu’un bâtiment donné est exposé : il oriente la nécessité de mesures et de gestes de prévention (aération, ventilation)."
    }
  };

  // Couches ponctuelles (un marqueur par site recensé), même mécanique de lots de communes.
  const pointLayers = { cavites: null, icpe: null };
  const pointCache = { cavites: null, icpe: null };
  const pointFamilies = {
    cavites: {
      path: "cavites", label: "Cavités souterraines", color: "#8d533e",
      explain: "Une cavité souterraine (carrière, marnière, cave, ouvrage militaire…) peut présenter un risque d’effondrement ou d’affaissement pour les constructions situées au-dessus. Sa présence ne signifie pas un risque avéré à l’aplomb exact : le BRGM recense la connaissance disponible, qui n’est pas exhaustive."
    },
    icpe: {
      path: "installations_classees", label: "Installations classées (ICPE)", color: "#b34000",
      explain: "Une Installation Classée pour la Protection de l’Environnement (ICPE) est un site industriel ou agricole soumis à une réglementation spécifique en raison des risques ou nuisances qu’il peut engendrer. Le statut Seveso, lorsqu’il est indiqué, signale un risque industriel majeur."
    }
  };

  // Un appel par commune, en pool limité : le paramètre `code_insee` en liste
  // séparée par virgules n'est documenté que pour certains endpoints (azi,
  // installations_classees) et s'est révélé silencieusement défaillant sur
  // d'autres (cavites, et de façon intermittente sur tri/azi) — un appel par
  // commune est le seul mode confirmé fiable sur l'ensemble de l'API v1.
  async function fetchGeorisquesCommune(path, codeInsee) {
    const url = `${API}/${path}?code_insee=${encodeURIComponent(codeInsee)}&page_size=100`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.data || data.content || (Array.isArray(data) ? data : []);
  }

  async function mapCommunesWithPool(communes, worker, poolSize = 8) {
    let index = 0;
    let failures = 0;
    let firstError = null;
    async function run() {
      while (index < communes.length) {
        const feature = communes[index++];
        const code = feature.properties?.code;
        if (!code) continue;
        try {
          await worker(feature, code);
        } catch (error) {
          failures++;
          if (!firstError) firstError = error;
        }
      }
    }
    await Promise.all(Array.from({ length: poolSize }, run));
    return { failures, firstError };
  }

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
        communesGeo = communesData;
        const holes = [];
        communesData.features.forEach((feature) => {
          const geometry = feature.geometry;
          if (geometry?.type === "Polygon") holes.push(geometry.coordinates[0]);
          if (geometry?.type === "MultiPolygon") geometry.coordinates.forEach((polygon) => holes.push(polygon[0]));
        });
        L.geoJSON({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-180,-85],[180,-85],[180,85],[-180,85],[-180,-85]], ...holes] } }, {
          pane: "departmentMask",
          interactive: false,
          style: { stroke: false, fillColor: "#eef1f5", fillOpacity: 0.94, fillRule: "evenodd" }
        }).addTo(map);
        communesLayer = L.geoJSON(communesData, {
          pane: "overlayPane",
          interactive: false,
          style: { color: "#59616b", weight: 0.7, opacity: 0.42, fillOpacity: 0 }
        }).addTo(map);
        const departmentBounds = communesLayer.getBounds();
        if (departmentBounds.isValid()) map.fitBounds(departmentBounds, { padding: [10, 10], animate: false });
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

  function openRuissellementFeature(feature, latlng) {
    const props = feature.properties || {};
    if (clickMarker) map.removeLayer(clickMarker);
    clickMarker = L.circleMarker(latlng, {
      radius: 7, color: "#000091", weight: 3, fillColor: "#fff", fillOpacity: 1
    }).addTo(map);

    $("#drawer-title").textContent = "Axe de ruissellement";
    $("#drawer-sub").textContent = props.Nom || "Trajectoire de l’eau de pluie";
    $("#summary-status").textContent = "Inondation";
    $("#summary-date").textContent = "DDT 95 · 21 septembre 2021";
    $("#summary-text").textContent = "Cet axe représente une trajectoire probable du ruissellement concentré selon la pente et le relief. Il permet d’anticiper les secteurs exposés aux coulées de boue ou à l’arrivée rapide d’eau lors de fortes pluies. Ce n’est ni un cours d’eau permanent, ni un zonage réglementaire.";
    $("#btn-export").href = "#";
    $("#btn-export").textContent = "Aucun document réglementaire associé";
    $("#btn-export").classList.add("disabled");

    $("#drawer-body").innerHTML = `
      <div class="section-title">Caractéristiques de l’axe</div>
      <div class="block">
        <div class="data-grid">
          <div class="data-row"><div class="l">Identifiant</div><div class="v">${escapeHtml(props.Nom || "—")}</div></div>
          <div class="data-row"><div class="l">Longueur estimée</div><div class="v">${props.GCCalculat ? `${Math.round(props.GCCalculat)} m` : "—"}</div></div>
          <div class="data-row"><div class="l">Bassin versant</div><div class="v">${escapeHtml(props.code || "—")}</div></div>
        </div>
      </div>
      <div class="notice">Axe de ruissellement DDT 95 (21 septembre 2021). À croiser avec le PPRI et les zones argileuses pour une lecture complète du risque d’inondation par ruissellement.</div>`;
    $("#drawer").classList.add("open");
    setStatus("Axe de ruissellement identifié");
  }

  async function toggleRuissellement(visible) {
    const control = document.querySelector('.layer-row[data-family="ruissellement"] input');
    if (!visible) {
      if (ruissellementLayer) map.removeLayer(ruissellementLayer);
      setStatus("Axes de ruissellement masqués");
      return;
    }
    try {
      if (control) control.disabled = true;
      if (!ruissellementLayer) {
        setStatus("Chargement des axes de ruissellement…");
        showProgress();
        const response = await fetch("data/axes_ruissellement.geojson");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        ruissellementLayer = L.geoJSON(data, {
          pane: "overviewRisks",
          style: { color: "#2c6e8f", weight: 1.6, opacity: 0.72 },
          onEachFeature(feature, layer) {
            layer.bindTooltip(feature.properties?.Nom || "Axe de ruissellement", { sticky: true });
            layer.on("click", (event) => {
              suppressNextMapClick = true;
              L.DomEvent.stopPropagation(event);
              openRuissellementFeature(feature, event.latlng);
              setTimeout(() => { suppressNextMapClick = false; }, 0);
            });
          }
        });
      }
      ruissellementLayer.addTo(map);
      setStatus(`${ruissellementLayer.getLayers().length} axes de ruissellement affichés`);
    } catch (error) {
      console.error(error);
      setStatus("Axes de ruissellement indisponibles", false);
      if (control) control.checked = false;
      preferences.ruissellement = false;
    } finally {
      if (control) control.disabled = false;
      hideProgress();
    }
  }

  function detailRows(item) {
    return Object.entries(item)
      .filter(([, value]) => value !== null && value !== undefined && value !== "" && typeof value !== "object")
      .slice(0, 10)
      .map(([key, value]) => `<div class="data-row"><div class="l">${escapeHtml(key.replace(/_/g, " "))}</div><div class="v">${escapeHtml(String(value))}</div></div>`)
      .join("");
  }

  function communeFeatureColor(familyKey, feature) {
    const fam = communeFamilies[familyKey];
    if (familyKey === "radon") {
      const classe = Number(feature.properties?.gasparItems?.[0]?.classe_potentiel);
      return radonColors[classe] || "#94a3b8";
    }
    return fam.color;
  }

  function openCommuneRisk(familyKey, feature, latlng) {
    const fam = communeFamilies[familyKey];
    const props = feature.properties || {};
    const items = props.gasparItems || [];
    const place = { city: props.nom, insee: props.code };

    if (clickMarker) map.removeLayer(clickMarker);
    clickMarker = L.circleMarker(latlng, {
      radius: 7, color: "#000091", weight: 3, fillColor: "#fff", fillOpacity: 1
    }).addTo(map);

    $("#drawer-title").textContent = place.city;
    $("#drawer-sub").textContent = familyKey === "radon"
      ? `${fam.label} · classe ${items[0]?.classe_potentiel ?? "—"}`
      : `${fam.label} · ${items.length} procédure${items.length > 1 ? "s" : ""} recensée${items.length > 1 ? "s" : ""}`;
    $("#summary-status").textContent = familyKey === "radon" ? "Radon" : "Inondation";
    $("#summary-date").textContent = "Donnée officielle Géorisques";
    $("#summary-text").textContent = fam.explain;
    $("#btn-export").href = errialUrl();
    $("#btn-export").textContent = "Établir l’état des risques avec ERRIAL ↗";
    $("#btn-export").classList.remove("disabled");

    $("#drawer-body").innerHTML = `
      <div class="section-title">${escapeHtml(fam.label)} pour cette commune</div>
      ${items.map((item) => `
        <div class="block">
          <div class="block-title">${escapeHtml(item.libelle || item.lib || item.nom || (familyKey === "radon" ? `Classe ${item.classe_potentiel}` : fam.label))}</div>
          <div class="data-grid">${detailRows(item)}</div>
        </div>`).join("") || `<div class="notice">Aucun détail publié par l’API Géorisques pour cette procédure ; la commune est néanmoins classée ${escapeHtml(fam.label)}.</div>`}
      ${errialBlock(latlng, place)}
      <div class="notice">Classement ${escapeHtml(fam.label)} issu de l’API Géorisques. ${familyKey === "radon" ? "Il n’a pas de portée réglementaire ; il oriente la prévention (aération, ventilation)." : "Il complète mais ne remplace pas la lecture du PPRI et de son règlement approuvé."}</div>`;
    $("#drawer").classList.add("open");
    setStatus("Commune identifiée");
  }

  async function buildCommuneLayer(familyKey) {
    if (!communesGeo?.features?.length) throw new Error("Communes indisponibles");
    const fam = communeFamilies[familyKey];
    setStatus(`Chargement ${fam.label} · commune par commune…`);
    const communes = communesGeo.features;
    const results = new Map();
    const { failures, firstError } = await mapCommunesWithPool(communes, async (feature, code) => {
      const items = await fetchGeorisquesCommune(fam.path, code);
      if (items.length) results.set(code, items);
    });
    if (failures === communes.length) {
      console.error(`Échec ${fam.label} sur toutes les communes`, firstError);
      throw new Error(`Service ${fam.label} indisponible${firstError ? ` — ${firstError.message}` : ""}`);
    }
    const features = communes
      .filter((feature) => results.has(feature.properties?.code))
      .map((feature) => ({
        ...feature,
        properties: { ...feature.properties, gasparItems: results.get(feature.properties.code) }
      }));
    communeCache[familyKey] = { type: "FeatureCollection", features };
    return communeCache[familyKey];
  }

  async function toggleCommuneLayer(familyKey, visible) {
    const fam = communeFamilies[familyKey];
    const control = document.querySelector(`.layer-row[data-family="${familyKey}"] input`);
    if (!visible) {
      if (communeLayers[familyKey]) map.removeLayer(communeLayers[familyKey]);
      setStatus(`Couche ${fam.label} masquée`);
      return;
    }
    try {
      if (control) control.disabled = true;
      const alreadyCached = Boolean(communeCache[familyKey]);
      if (!alreadyCached) showProgress();
      const data = communeCache[familyKey] || await buildCommuneLayer(familyKey);
      if (!communeLayers[familyKey]) {
        communeLayers[familyKey] = L.geoJSON(data, {
          pane: "overviewRisks",
          style: (feature) => {
            const color = communeFeatureColor(familyKey, feature);
            return { color, weight: 1.6, opacity: 0.9, fillColor: color, fillOpacity: 0.24, dashArray: fam.dash };
          },
          onEachFeature(feature, layer) {
            layer.bindTooltip(`${fam.label} · ${feature.properties.nom}`, { sticky: true, direction: "top" });
            layer.on("click", (event) => {
              suppressNextMapClick = true;
              L.DomEvent.stopPropagation(event);
              openCommuneRisk(familyKey, feature, event.latlng);
              setTimeout(() => { suppressNextMapClick = false; }, 0);
            });
          }
        });
      }
      communeLayers[familyKey].addTo(map);
      setStatus(`${communeLayers[familyKey].getLayers().length} commune(s) concernée(s) par ${fam.label}`);
    } catch (error) {
      console.error(error);
      setStatus(`Service ${fam.label} indisponible — ${error.message}`, false);
      if (control) control.checked = false;
      preferences[familyKey] = false;
    } finally {
      if (control) control.disabled = false;
      hideProgress();
    }
  }

  function openPointRisk(familyKey, feature, latlng) {
    const fam = pointFamilies[familyKey];
    const props = feature.properties || {};

    if (clickMarker) map.removeLayer(clickMarker);
    clickMarker = L.circleMarker(latlng, {
      radius: 7, color: "#000091", weight: 3, fillColor: "#fff", fillOpacity: 1
    }).addTo(map);

    const title = props.raisonSociale || props.nature_cavite || props.type_cavite || fam.label;
    $("#drawer-title").textContent = String(title);
    $("#drawer-sub").textContent = fam.label;
    $("#summary-status").textContent = familyKey === "icpe" ? "Technologique" : "Mouvement de terrain";
    $("#summary-date").textContent = "Donnée officielle Géorisques";
    $("#summary-text").textContent = fam.explain;
    $("#btn-export").href = errialUrl();
    $("#btn-export").textContent = "Établir l’état des risques avec ERRIAL ↗";
    $("#btn-export").classList.remove("disabled");

    $("#drawer-body").innerHTML = `
      <div class="section-title">Détail</div>
      <div class="block"><div class="data-grid">${detailRows(props)}</div></div>
      ${errialBlock(latlng, {})}
      <div class="notice">Donnée ponctuelle issue de l’API Géorisques (BRGM). Un point signale un site recensé ; l’absence de point ne garantit pas l’absence de risque, seulement l’absence de donnée publiée.</div>`;
    $("#drawer").classList.add("open");
    setStatus(`${fam.label} identifié(e)`);
  }

  async function buildPointLayer(familyKey) {
    if (!communesGeo?.features?.length) throw new Error("Communes indisponibles");
    const fam = pointFamilies[familyKey];
    setStatus(`Chargement ${fam.label} · commune par commune…`);
    const communes = communesGeo.features;
    const features = [];
    const { failures, firstError } = await mapCommunesWithPool(communes, async (feature, code) => {
      const items = await fetchGeorisquesCommune(fam.path, code);
      items.forEach((item) => {
        const lon = Number(item.longitude);
        const lat = Number(item.latitude);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        features.push({ type: "Feature", properties: item, geometry: { type: "Point", coordinates: [lon, lat] } });
      });
    });
    if (failures === communes.length) {
      console.error(`Échec ${fam.label} sur toutes les communes`, firstError);
      throw new Error(`Service ${fam.label} indisponible${firstError ? ` — ${firstError.message}` : ""}`);
    }
    pointCache[familyKey] = { type: "FeatureCollection", features };
    return pointCache[familyKey];
  }

  async function togglePointLayer(familyKey, visible) {
    const fam = pointFamilies[familyKey];
    const control = document.querySelector(`.layer-row[data-family="${familyKey}"] input`);
    if (!visible) {
      if (pointLayers[familyKey]) map.removeLayer(pointLayers[familyKey]);
      setStatus(`Couche ${fam.label} masquée`);
      return;
    }
    try {
      if (control) control.disabled = true;
      const alreadyCachedPoints = Boolean(pointCache[familyKey]);
      if (!alreadyCachedPoints) showProgress();
      const data = pointCache[familyKey] || await buildPointLayer(familyKey);
      if (!pointLayers[familyKey]) {
        pointLayers[familyKey] = L.geoJSON(data, {
          pane: "overviewRisks",
          pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 7, color: "#fff", weight: 2, fillColor: fam.color, fillOpacity: 0.95 }),
          onEachFeature(feature, layer) {
            const props = feature.properties || {};
            layer.bindTooltip(String(props.raisonSociale || props.nature_cavite || fam.label), { sticky: true });
            layer.on("click", (event) => {
              suppressNextMapClick = true;
              L.DomEvent.stopPropagation(event);
              openPointRisk(familyKey, feature, event.latlng);
              setTimeout(() => { suppressNextMapClick = false; }, 0);
            });
          }
        });
      }
      pointLayers[familyKey].addTo(map);
      setStatus(`${pointLayers[familyKey].getLayers().length} site(s) ${fam.label} affiché(s)`);
    } catch (error) {
      console.error(error);
      setStatus(`Service ${fam.label} indisponible — ${error.message}`, false);
      if (control) control.checked = false;
      preferences[familyKey] = false;
    } finally {
      if (control) control.disabled = false;
      hideProgress();
    }
  }

  function setStatus(text, ok = true) {
    $("#live-text").textContent = text;
    $("#live-sub").textContent = "Géorisques + Préfecture";
    $("#live-dot").className = `live-dot ${ok ? "ok" : "ko"}`;
  }

  // Une couche par commune interroge l'API Géorisques 183 fois (une requête par
  // commune) : ça peut prendre plusieurs secondes. Cette barre rend l'attente
  // visible, plutôt que de laisser croire que rien ne se passe.
  function showProgress() {
    const bar = $("#progress-bar");
    bar.style.transition = "width 12s cubic-bezier(.1,.6,.2,1)";
    bar.style.width = "0%";
    requestAnimationFrame(() => { bar.style.width = "88%"; });
  }
  function hideProgress() {
    const bar = $("#progress-bar");
    bar.style.transition = "width .3s";
    bar.style.width = "100%";
    setTimeout(() => { bar.style.width = "0"; }, 350);
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
      if (family === "argile" && input.checked && map.getZoom() < 13) {
        setStatus("Retrait-gonflement : zoom automatique — cette couche n’a pas de vue départementale", true);
        map.setZoom(13);
      }
      if (family === "ruissellement") toggleRuissellement(input.checked);
      if (family === "tri" || family === "azi" || family === "radon") toggleCommuneLayer(family, input.checked);
      if (family === "cavites" || family === "icpe") togglePointLayer(family, input.checked);
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
      : preferences.argile
        ? "<strong>Vue départementale</strong><span>Zoomez sur une commune pour voir le retrait-gonflement</span>"
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

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function documentIsForPlace(document, place, ppr) {
    if (ppr.idGaspar !== "95PREF19840106") return true;
    const city = normalizeText(place?.city);
    const title = normalizeText(document.title);
    return Boolean(city && title && title.includes(city));
  }

  function documentsForPlace(ppr, place) {
    const documents = window.PPR_DOCUMENTS?.[ppr.idGaspar]?.documents || [];
    return documents.filter((document) => documentIsForPlace(document, place, ppr));
  }

  function pdfReaderUrl(url) {
    if (!url) return "#";
    return `https://docs.google.com/viewer?url=${encodeURIComponent(url)}`;
  }

  function errialUrl() {
    return "https://errial.georisques.gouv.fr/#/";
  }

  function errialBlock(latlng, place) {
    const coordinates = latlng
      ? `${Number(latlng.lat).toFixed(6)}, ${Number(latlng.lng).toFixed(6)}`
      : "—";
    return `
      <div class="section-title">État des risques à la parcelle</div>
      <div class="block errial-block">
        <div class="block-title">Poursuivre avec ERRIAL</div>
        <p class="risk-explainer">Le service officiel ERRIAL permet de rechercher une adresse ou une parcelle et de produire un état des risques complet.</p>
        <div class="data-grid">
          <div class="data-row"><div class="l">Commune repérée</div><div class="v">${escapeHtml(place?.city || "—")}</div></div>
          <div class="data-row"><div class="l">Point cliqué</div><div class="v">${escapeHtml(coordinates)}</div></div>
        </div>
        <a class="errial-link" href="${errialUrl()}" target="_blank" rel="noopener noreferrer">Établir l’état des risques avec ERRIAL ↗</a>
        <div class="pdf-note">ERRIAL s’ouvre dans un nouvel onglet. Saisissez l’adresse ou sélectionnez la parcelle correspondant au point cliqué.</div>
      </div>`;
  }

  function documentLinks(ppr, place) {
    const catalog = window.PPR_DOCUMENTS?.[ppr.idGaspar];
    const documents = documentsForPlace(ppr, place);
    if (!documents.length) {
      const fiche = catalog?.fiche;
      return `<div class="notice"><strong>Aucun PDF propre à ${escapeHtml(place?.city || "cette commune")} n’est publié dans ce dossier Géorisques.</strong><br>
        Une pièce concernant une autre commune ne sera jamais proposée ici.
        ${fiche ? `<br><a href="${escapeHtml(fiche)}" target="_blank" rel="noopener noreferrer">Consulter la fiche officielle du PPR ↗</a>` : ""}</div>`;
    }
    return documents.map((document) => `
      <div class="document-card">
        <div>
          <strong>${escapeHtml(document.type)}</strong>
          <small>${escapeHtml(document.title || ppr.libPpr)} · ${escapeHtml(document.date || "date non renseignée")}</small>
        </div>
        <a href="${escapeHtml(pdfReaderUrl(document.url))}" target="_blank" rel="noopener noreferrer"
           aria-label="Lire ${escapeHtml(document.type)} dans un nouvel onglet">Lire le PDF ↗</a>
      </div>`).join("");
  }

  function combinedDocumentLinks(ppr, place) {
    return documentLinks(ppr, place);
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

    const firstDocument = documentsForPlace(ppr, place)[0]?.url || "";
    const officialTarget = firstDocument ? pdfReaderUrl(firstDocument) : catalog.fiche || "";
    $("#btn-export").href = officialTarget || "#";
    $("#btn-export").textContent = firstDocument
      ? "Lire le PDF dans un nouvel onglet ↗"
      : officialTarget
        ? "Consulter la fiche officielle du PPR ↗"
        : "Aucun document disponible";
    $("#btn-export").classList.toggle("disabled", !officialTarget);

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
        ${combinedDocumentLinks(ppr, place)}
      </div>
      ${errialBlock(latlng, place)}
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

    const primaryDocument = chosen ? documentsForPlace(chosen, place)[0] : null;
    const chosenCatalog = chosen ? window.PPR_DOCUMENTS?.[chosen.idGaspar] : null;
    const officialTarget = primaryDocument ? pdfReaderUrl(primaryDocument.url) : chosenCatalog?.fiche || "";
    $("#btn-export").href = officialTarget || "#";
    $("#btn-export").textContent = primaryDocument
      ? "Lire le PDF dans un nouvel onglet ↗"
      : officialTarget
        ? "Consulter la fiche officielle du PPR ↗"
        : "Aucun document disponible";
    $("#btn-export").classList.toggle("disabled", !officialTarget);

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
            ${documentLinks(p, place)}
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
      ${errialBlock(latlng, place)}
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
  $("#btn-valdoise").addEventListener("click", () => map.fitBounds(communesLayer?.getBounds?.().isValid() ? communesLayer.getBounds() : bounds95, { padding: [10, 10] }));
  $("#drawer-close").addEventListener("click", () => $("#drawer").classList.remove("open"));
  $("#clear-layers")?.addEventListener("click", () => {
    document.querySelectorAll(".layer-row input").forEach((input) => {
      if (!input.checked) return;
      input.checked = false;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  loadLocalContext().then(updateScaleDisplay);

  // Lecture seule pour la fenêtre d'impression (print.html) : aucune donnée
  // ni fonction n'est dupliquée, print.js lit cet état via
  // window.opener.risquesPrintApp une fois ouverte depuis cette page.
  window.risquesPrintApp = { preferences, riskColor, riskFamily };
  const printButton = $("#btn-print-map");
  if (printButton) printButton.addEventListener("click", () => window.open("print.html", "_blank"));
})();
