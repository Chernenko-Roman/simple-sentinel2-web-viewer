import { LayerType } from './LayerType.js';
import { Sentinel2GridLayer } from './Sentinel2GridLayer.js';

function getInitialView() {
  const params = new URLSearchParams(window.location.search);
  return {
    lat: parseFloat(params.get('lat')) || 49.4,
    lng: parseFloat(params.get('lng')) || 32.05,
    zoom: parseInt(params.get('z')) || 12
  };
}

const osmLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});

const esriLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution:
    "Tiles &copy; Esri — Source: Esri, Earthstar Geographics"
});

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

const sentinel2Layers = new Map([
  [LayerType.Sentinel2RgbCloudless, sentinel2LayerRgbCloudless],
  [LayerType.Sentinel2RgbLatest, sentinel2LayerRgbLatest],
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
    "Latest cloudless": sentinel2Layers.get(LayerType.Sentinel2RgbCloudless),
    "Latest": sentinel2Layers.get(LayerType.Sentinel2RgbLatest),
    "Disable": L.layerGroup(),
  }
};

let currentOverlayLayer = null;

const view = getInitialView();
const map = L.map('map', {
  center: [view.lat, view.lng],
  zoom: view.zoom,
});

osmLayer.addTo(map);
sentinel2Layers.get(LayerType.Sentinel2RgbCloudless).addTo(map);

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
    ProgressBar.reset()
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
});
