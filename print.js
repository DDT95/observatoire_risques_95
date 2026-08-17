(function () {
  const opener = window.opener;
  const app = opener && opener.risquesPrintApp;
  if (!app) {
    document.body.innerHTML =
      '<p style="padding:40px;font:16px Marianne,Arial,sans-serif">' +
      "Cette page s’ouvre depuis le bouton “Imprimer la carte” de la carte des risques." +
      "</p>";
    return;
  }
  const { preferences, riskColor, riskFamily } = app;

  const families = [];
  if (preferences.inond) families.push({ id: "inond", label: "Inondation", color: "#1479c9" });
  if (preferences.mvt) families.push({ id: "mvt", label: "Mouvement de terrain", color: "#e76f00" });

  document.getElementById("printTitle").textContent = families.length
    ? `Risques majeurs — ${families.map((f) => f.label).join(" · ")}`
    : "Risques majeurs du Val-d’Oise";

  const today = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  document.getElementById("printSources").innerHTML = `
    <span class="src-line">Sources : Géorisques · GASPAR</span>
    <span class="src-line">Auteur : DDT 95 - BVAT PG</span>
    <span class="src-line">Date : ${today}</span>
  `;

  document.getElementById("printLegend").innerHTML = families.length
    ? families.map((f) => `<div class="legend-block"><i style="background:${f.color}"></i>${f.label}</div>`).join("")
    : '<div class="legend-empty">Aucune couche sélectionnée</div>';

  const map = L.map("printMapCanvas", {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    tap: false,
  });
  map.createPane("maskPane");
  map.getPane("maskPane").style.zIndex = 420;
  map.getPane("maskPane").style.pointerEvents = "none";
  map.createPane("boundaryPane");
  map.getPane("boundaryPane").style.zIndex = 430;
  map.getPane("boundaryPane").style.pointerEvents = "none";

  // Même fond de carte que la page interactive. html2canvas ne capture pas
  // les filtres CSS (grayscale) : l’effet est donc appliqué pixel par pixel
  // sur chaque tuile, pour qu’il soit bien présent dans l’image capturée.
  const NeutralTileLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("canvas");
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      const ctx = tile.getContext("2d");
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        ctx.drawImage(img, 0, 0, size.x, size.y);
        const data = ctx.getImageData(0, 0, size.x, size.y);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const gray1 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          let r2 = r + (gray1 - r) * 0.85, g2 = g + (gray1 - g) * 0.85, b2 = b + (gray1 - b) * 0.85;
          const gray2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
          r2 = gray2 + (r2 - gray2) * 0.35;
          g2 = gray2 + (g2 - gray2) * 0.35;
          b2 = gray2 + (b2 - gray2) * 0.35;
          d[i] = Math.min(255, r2 * 1.06);
          d[i + 1] = Math.min(255, g2 * 1.06);
          d[i + 2] = Math.min(255, b2 * 1.06);
        }
        ctx.putImageData(data, 0, 0);
        done(null, tile);
      };
      img.onerror = (e) => done(e, tile);
      img.src = this.getTileUrl(coords);
      return tile;
    },
  });
  new NeutralTileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

  let territoryLayer = null;

  function niceScaleNumber(n) {
    const pow10 = Math.pow(10, String(Math.floor(n)).length - 1);
    const d = n / pow10;
    return pow10 * (d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1);
  }
  function renderScaleBar() {
    const targetPx = 160;
    const size = map.getSize();
    const y = size.y / 2;
    const maxMeters = map.distance(map.containerPointToLatLng([0, y]), map.containerPointToLatLng([targetPx, y]));
    const meters = niceScaleNumber(maxMeters);
    const fullPx = targetPx * (meters / maxMeters);
    const segments = 4;
    const segPx = fullPx / segments;
    const unit = meters >= 1000 ? meters / 1000 : meters;
    const unitLabel = meters >= 1000 ? "km" : "m";
    const bars = Array.from({ length: segments })
      .map((_, i) => `<div class="scale-seg ${i % 2 === 0 ? "on" : "off"}" style="width:${segPx}px"></div>`)
      .join("");
    const ticks = Array.from({ length: segments + 1 })
      .map((_, i) => `<span style="left:${i * segPx}px">${((unit / segments) * i).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}</span>`)
      .join("");
    document.getElementById("printScale").innerHTML = `
      <div class="scale-frame" style="width:${fullPx}px">
        <div class="scale-bar-row">${bars}</div>
        <div class="scale-ticks" style="width:${fullPx}px">${ticks}<span class="scale-unit" style="left:${fullPx}px">${unitLabel}</span></div>
      </div>
    `;
  }

  const statusEl = document.getElementById("pdfStatus");

  async function buildPdf() {
    const node = document.getElementById("printPage");
    const canvas = await html2canvas(node, { scale: 2.5, useCORS: true, backgroundColor: "#ffffff" });
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a3" });
    doc.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, 420, 297, undefined, "FAST");
    const blobUrl = URL.createObjectURL(doc.output("blob"));
    window.location.replace(blobUrl);
  }

  function finalizeMap() {
    map.invalidateSize();
    if (territoryLayer) map.fitBounds(territoryLayer.getBounds(), { padding: [18, 18] });
    renderScaleBar();
    setTimeout(() => {
      buildPdf().catch((err) => {
        console.error(err);
        statusEl.textContent = "La génération du PDF a échoué. Réessayez depuis la carte.";
      });
    }, 900);
  }

  Promise.all([
    fetch("data/communes_95.geojson").then((r) => r.json()),
    fetch("data/rivieres_95.geojson").then((r) => r.json()).catch(() => null),
    fetch("data/ppr_perimetres_95.geojson").then((r) => r.json()),
  ]).then(([communes, rivers, ppr]) => {
    const holes = [];
    (communes.features || []).forEach((f) => {
      const g = f.geometry;
      if (g?.type === "Polygon" && g.coordinates?.[0]) holes.push(g.coordinates[0]);
      if (g?.type === "MultiPolygon") g.coordinates?.forEach((p) => { if (p?.[0]) holes.push(p[0]); });
    });
    if (rivers) {
      L.geoJSON(rivers, { interactive: false, style: { color: "#2f80c9", weight: 1.1, opacity: 0.58 } }).addTo(map);
    }
    L.geoJSON(ppr, {
      style: (f) => {
        const color = riskColor(f.properties);
        return { color, fillColor: color, weight: 2.2, opacity: 0.96, fillOpacity: 0.34 };
      },
      filter: (f) => {
        const family = riskFamily(f.properties);
        return family === "Inondation" ? preferences.inond : preferences.mvt;
      },
    }).addTo(map);
    L.geoJSON(
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...holes] },
      },
      { pane: "maskPane", interactive: false, style: { stroke: false, fillColor: "#ffffff", fillOpacity: 1, fillRule: "evenodd" } }
    ).addTo(map);
    territoryLayer = L.geoJSON(communes, {
      pane: "boundaryPane",
      interactive: false,
      style: { color: "#2d3240", weight: 1, opacity: 0.9, fillOpacity: 0 },
    }).addTo(map);

    map.invalidateSize();
    if (territoryLayer) map.fitBounds(territoryLayer.getBounds(), { padding: [18, 18] });
    map.whenReady(() => setTimeout(finalizeMap, 700));
  });
})();
