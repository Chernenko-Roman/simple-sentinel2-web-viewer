const { fromUrl, fromUrls, fromArrayBuffer, fromBlob } = GeoTIFF;

var map = L.map("map").setView([49.4, 32.05], 12);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

async function fetchLatestS2(lat, lon) {
  const body = {
    collections: ["sentinel-2-l2a"],
    intersects: {
      type: "Point",
      coordinates: [lon, lat],
    },
    query: {
      "eo:cloud_cover": {
       "lt": 10  // Less than 10% cloud cover
    }
  },
    limit: 1,
    sortby: "-properties.datetime",
  };

  const res = await fetch("https://earth-search.aws.element84.com/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error("STAC query failed: " + res.status);
  const data = await res.json();

  return data.features?.[0] || null;
}

class CustomGridLayer extends L.GridLayer {
  createTile(coords, done) {
    var error;
    const tile = document.createElement("div");
    const tileSize = this.getTileSize();
    const pixel = [coords.x * tileSize.x, coords.y * tileSize.y];
    const latlng = map.unproject(pixel, coords.z);

    const coordsTopLeft = map.unproject([coords.x * tileSize.x, coords.y * tileSize.y], coords.z);
    const coordsBottomRight = map.unproject([(coords.x + 1) * tileSize.x, (coords.y + 1) * tileSize.y], coords.z);

    tile.style.width = tileSize.x + "px";
    tile.style.height = tileSize.y + "px";
    tile.style.background = "#ffffff00";
    tile.classList.add("tile-text");

    (async () => {
      const stac_item = await fetchLatestS2(latlng.lat, latlng.lng);

      const visualBand = stac_item.assets.visual.href;
      const tileId = stac_item.id;

      const tiff = await fromUrl(visualBand);

      tile.innerHTML = `
        <div style="font: 12px sans-serif; padding: 4px;">
        x: ${coords.x}<br/>
        y: ${coords.y}<br/>
        z: ${coords.z}<br/>
        lat: ${latlng.lat.toFixed(4)}<br/>
        lon: ${latlng.lng.toFixed(4)}<br/>
        tile: ${tileId}<br/>
        file: ${visualBand}
        </div>
    `;
      done(error, tile);
    })();

    return tile;
  }
}


// Add the custom layer
const myGrid = new CustomGridLayer();
myGrid.addTo(map);
