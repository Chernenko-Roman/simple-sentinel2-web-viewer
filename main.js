import { LayerType, BackgroundType } from './LayerType.js';
import { Sentinel2GridLayer } from './Sentinel2GridLayer.js';

function getInitialView() {
  const params = new URLSearchParams(window.location.search);
  return {
    lat: parseFloat(params.get('lat')) || 0,
    lng: parseFloat(params.get('lng')) || 0,
    zoom: parseInt(params.get('z')) || 2,
    background: params.get("background") || "openstreetmap",
    overlay: params.get("overlay") || "Sentinel2RgbCloudless",
    unknownPosition: !params.has('lat') && !params.has('lng'),
  };
}

const osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});
osmLayer._layerId = BackgroundType.openstreetmap;

const esriLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution:
    "Tiles &copy; Esri — Source: Esri, Earthstar Geographics"
});
esriLayer._layerId = BackgroundType.esri;

const backgroundLayers = new Map([
  [BackgroundType.openstreetmap, osmLayer],
  [BackgroundType.esri, esriLayer],
]);

const worker = new Worker("Sentinel2GridLayoutWorker.js", { type: 'module' });

const sentinel2LayerRgbCloudless = new Sentinel2GridLayer({
  minZoom: 8,
  maxZoom: 16,
  minNativeZoom: 8,
  maxNativeZoom: 14,
  attribution: "ESA Sentinel-2"}, 
  worker, LayerType.Sentinel2RgbCloudless);

const sentinel2LayerRgbLatest = new Sentinel2GridLayer({
  minZoom: 8,
  maxZoom: 16,
  minNativeZoom: 8,
  maxNativeZoom: 14,
  attribution: "ESA Sentinel-2"}, 
  worker, LayerType.Sentinel2RgbLatest);

const sentinel2LayerNdviCloudless = new Sentinel2GridLayer({
  minZoom: 8,
  maxZoom: 16,
  minNativeZoom: 8,
  maxNativeZoom: 14,
  attribution: "ESA Sentinel-2"}, 
  worker, LayerType.Sentinel2NdviCloudless);

const sentinel2LayerNdviLatest = new Sentinel2GridLayer({
  minZoom: 8,
  maxZoom: 16,
  minNativeZoom: 8,
  maxNativeZoom: 14,
  attribution: "ESA Sentinel-2"}, 
  worker, LayerType.Sentinel2NdviLatest);

const sentinel2Layers = new Map([
  [LayerType.Sentinel2RgbCloudless, sentinel2LayerRgbCloudless],
  [LayerType.Sentinel2RgbLatest, sentinel2LayerRgbLatest],
  [LayerType.Sentinel2NdviCloudless, sentinel2LayerNdviCloudless],
  [LayerType.Sentinel2NdviLatest, sentinel2LayerNdviLatest],
]);

for (const [LayerType, layer] of sentinel2Layers) {
  layer.on('tileloadstart', () => ProgressBar.tileRequested());
  layer.on('tileload', () => ProgressBar.tileLoaded());
  layer.on('tileerror', () => ProgressBar.tileLoaded());
  layer.on('loading', () =>  ProgressBar.reset());

  layer.on('load', () => layer.refreshImagesDatesInfo());
  layer.on('load', () => ProgressBar.reset());

  layer.on("imagesDatesUpdated", function(newDates) {
    document.getElementById('layer-info').innerHTML =`Acquisition dates: ${newDates.dates}`;
  } );
}

const baseMaps = {
    "OpenStreetMap": osmLayer,
    "Esri World Imagery": esriLayer
};

const overlayMaps = {
  "ESA Sentinel-2": {
    "Latest cloudless RGB": sentinel2Layers.get(LayerType.Sentinel2RgbCloudless),
    "Latest RGB": sentinel2Layers.get(LayerType.Sentinel2RgbLatest),
    "Latest cloudless NDVI": sentinel2Layers.get(LayerType.Sentinel2NdviCloudless),
    "Latest NDVI": sentinel2Layers.get(LayerType.Sentinel2NdviLatest),
    "Disable": L.layerGroup(),
  }
};

let currentOverlayLayer = null;
let currentBackgroundLayer = null;

const view = getInitialView();
const map = L.map('map', {
  center: [view.lat, view.lng],
  zoom: view.zoom,
});

if (view.unknownPosition) {
   fetch('/geo')
    .then(response => response.json())
    .then(data => {
        map.setView([data.latitude, data.longitude], 12); 
    })
    .catch(err => console.error('Failed to fetch geo:', err));
}

if (backgroundLayers.has(view.background)) {
  currentBackgroundLayer = backgroundLayers.get(view.background);
  currentBackgroundLayer.addTo(map);
}
if (sentinel2Layers.has(view.overlay)) {
  currentOverlayLayer = sentinel2Layers.get(view.overlay);
  currentOverlayLayer.addTo(map);
}

L.control.groupedLayers(
  baseMaps, overlayMaps,
  {
    exclusiveGroups: ["ESA Sentinel-2"]  // makes this overlay group radio-style
  }
).addTo(map);
L.control.scale().addTo(map);

function onZoomChanged() {
  const zoominMsgDiv = document.getElementById('zoomin_msg');
  
  const currentZoom = map.getZoom();
  if (currentZoom <= 7) {
    zoominMsgDiv.className = "zoomin_msg_enable";
    ProgressBar.reset();
  } else
    zoominMsgDiv.className = "zoomin_msg_disable";
}

function onMoveEnd() {
  const center = map.getCenter();
  const zoom = map.getZoom();
  const params = new URLSearchParams();

  params.set('lat', center.lat.toFixed(5));
  params.set('lng', center.lng.toFixed(5));
  params.set('z', zoom);
  params.set("background", currentBackgroundLayer?._layerId ?? "none");
  params.set("overlay", currentOverlayLayer?._layerId ?? "none");
  history.replaceState(null, '', '?' + params.toString());

  if (currentOverlayLayer != null)
    currentOverlayLayer.refreshImagesDatesInfo();
}

map.on('zoomend', () => onZoomChanged());
map.on('moveend', () => onMoveEnd() );

onZoomChanged();
onMoveEnd();

// Create custom control
const LayerInfoControl = L.Control.extend({
  options: { position: 'bottomright' }, // same as attribution
  onAdd: function () {
    const div = L.DomUtil.create('div', 'leaflet-control-attribution');
    div.id = 'layer-info';
    div.innerHTML = '';
    return div;
  }
});

map.addControl(new LayerInfoControl());

map.on('overlayadd', function(e) {
  if (e.layer instanceof Sentinel2GridLayer)
    currentOverlayLayer = e.layer;
  else
    currentOverlayLayer = null;

  onMoveEnd();
});

map.on('baselayerchange', function(e) {
  currentBackgroundLayer = e.layer;

  onMoveEnd();
});

L.control.locate({
  initialZoomLevel: 10
}).addTo(map);

var info = L.control({position: 'bottomright'}); // or 'bottomright'

info.onAdd = function(map) {
    var div = L.DomUtil.create('div', 'leaflet-control-attribution');
    div.innerHTML = `© 2025 lookfrom.space | <a href="https://www.linkedin.com/in/roman-chernenko-b272a361/" target="_blank">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" 
         fill="currentColor" viewBox="0 0 16 16" 
         style="vertical-align: middle; margin-right: 4px;">
      <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 
      0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 
      1.146H1.175C.526 16 0 15.487 0 
      14.854V1.146zm4.943 12.248V6.169H2.542v7.225h2.401zm-1.2-8.21c.837 
      0 1.358-.554 1.358-1.248-.015-.709-.521-1.248-1.342-1.248-.82 
      0-1.358.54-1.358 1.248 0 .694.521 
      1.248 1.327 1.248h.015zM13.458 
      13.394v-4.042c0-2.163-1.152-3.17-2.688-3.17-1.237 
      0-1.796.68-2.105 1.157h-.03V6.169H6.234c.03.68 
      0 7.225 0 7.225h2.401v-4.037c0-.216.015-.432.08-.586.174-.432.572-.878 
      1.24-.878.874 0 1.223.662 1.223 1.634v3.867h2.28z"/>
    </svg>
    Roman Chernenko
  </a>`;
    return div;
};
info.addTo(map);