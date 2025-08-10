class Sentinel2GridLayer extends L.GridLayer {
  #worker = new Worker("Sentinel2GridLayoutWorker.js", { type: 'module' });
  #tileInfo = new Map();

  constructor(options) {
    super(options);

    this.#worker.onmessage = (pkg) => {
      this.handleWorkerMessage(pkg.data);
    };

    this.on('tileunload', e => {
      console.log('Tile unloaded:', e.coords);
      this.unloadTile(e.coords);
    });
  }

  createTile(coords, done) {
    console.log(`Start loading x = ${coords.x} y = ${coords.y} z = ${coords.z}`);

    const key = `${coords.z}/${coords.x}/${coords.y}`;

    const tile = document.createElement("canvas");
    const tileSize = this.getTileSize();
    tile.width = tileSize.x;
    tile.height = tileSize.y;

    const coordsTopLeft = map.unproject(
      [coords.x * tileSize.x, coords.y * tileSize.y], coords.z
    );
    const coordsBottomRight = map.unproject(
      [(coords.x + 1) * tileSize.x, (coords.y + 1) * tileSize.y], coords.z
    );

    const cellCoords = [
      [coordsTopLeft.lng, coordsTopLeft.lat],
      [coordsBottomRight.lng, coordsTopLeft.lat],
      [coordsBottomRight.lng, coordsBottomRight.lat],
      [coordsTopLeft.lng, coordsBottomRight.lat],
    ];

    this.#tileInfo.set(key, {
      canvas: tile,
      tileSize: tileSize,
      doneCallback: done,
    });

    this.#worker.postMessage({
      type: "createTile",
      key: key,
      coords: coords,
      coordsTopLeft: coordsTopLeft,
      coordsBottomRight: coordsBottomRight,
      cellCoords: cellCoords,
      tileSize: tileSize,
    });

    return tile;
  }

  unloadTile(coords) {
    const key = `${coords.z}/${coords.x}/${coords.y}`;
    this.#worker.postMessage({
      type: "unloadTile",
      key: key,
      coords: coords
    });
    this.#tileInfo.delete(key);
  }

  refreshImagesDatesInfo() {
    this.#worker.postMessage({
      type: "getImagesDates"
    });
  }

  handleWorkerMessage(pkg) {
    if (pkg.type == "done") {
      if (this.#tileInfo.has(pkg.key)) {
        const currTile = this.#tileInfo.get(pkg.key);
        if (pkg.error == null) {
          const ctx = currTile.canvas.getContext("2d");
          ctx.drawImage(pkg.cellRGB, 0, 0, currTile.tileSize.x, currTile.tileSize.y);

          currTile.doneCallback(null, currTile.canvas);
        } else {
          currTile.doneCallback(pkg.error, currTile.canvas);
        }

        this.#tileInfo.delete(pkg.key);
      }
    }
    else if (pkg.type == "getImagesDates") {
      console.log(pkg.imagesDates);
    }
  }
}

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
})

const esriLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution:
    "Tiles &copy; Esri — Source: Esri, Earthstar Geographics"
}
)

const sentinel2LayerCloudless = new Sentinel2GridLayer({
  minZoom: 8,
  maxZoom: 16,
  minNativeZoom: 8,
  maxNativeZoom: 14,
  attribution: "ESA Sentinel-2"
});

sentinel2LayerCloudless.on('tileloadstart', () => ProgressBar.tileRequested());
sentinel2LayerCloudless.on('tileload', () => ProgressBar.tileLoaded());
sentinel2LayerCloudless.on('tileerror', () => ProgressBar.tileLoaded());
sentinel2LayerCloudless.on('loading', () =>  ProgressBar.reset());

const baseMaps = {
  "OpenStreetMap": osmLayer,
  "Esri World Imagery": esriLayer,
};

const overlayMaps = {
  "Latest cloudless ESA Sentinel-2": sentinel2LayerCloudless
};

const view = getInitialView();
const map = L.map('map', {
  center: [view.lat, view.lng],
  zoom: view.zoom,
});

osmLayer.addTo(map);
sentinel2LayerCloudless.addTo(map);

L.control.layers(baseMaps, overlayMaps).addTo(map);
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

  sentinel2LayerCloudless.refreshImagesDatesInfo();
}

map.on('zoomend', () => onZoomChanged());
map.on('moveend', () => onMoveEnd() );

onZoomChanged();
onMoveEnd();

sentinel2LayerCloudless.on('load', () => sentinel2LayerCloudless.refreshImagesDatesInfo());
sentinel2LayerCloudless.on('load', () => ProgressBar.reset());