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
    const tileSize = this.getTileSize();

    const tile = document.createElement("canvas");
    tile.width = tileSize.x
    tile.height = tileSize.y

    const pixel = [coords.x * tileSize.x, coords.y * tileSize.y];
    const latlng = map.unproject(pixel, coords.z);

    const coordsTopLeft = map.unproject([coords.x * tileSize.x, coords.y * tileSize.y], coords.z);
    const coordsBottomRight = map.unproject([(coords.x + 1) * tileSize.x, (coords.y + 1) * tileSize.y], coords.z);

    (async () => {
      const stac_item = await fetchLatestS2(latlng.lat, latlng.lng);

      const visualBand = stac_item.assets.visual.href;
      const tileId = stac_item.id;

      const epsgCode = stac_item.properties['proj:epsg'];
      const wgs84ToUTM = proj4("WGS84", `EPSG:${epsgCode}`);

      const coordsTopLeftUtm = wgs84ToUTM.forward([coordsTopLeft.lng, coordsTopLeft.lat])
      const coordsBottomRightUtm = wgs84ToUTM.forward([coordsBottomRight.lng, coordsBottomRight.lat])

      const resX = Math.abs(coordsTopLeftUtm[0] - coordsBottomRightUtm[0])/tileSize.x;
      const resY = Math.abs(coordsTopLeftUtm[1] - coordsBottomRightUtm[1])/tileSize.y;
      const res = Math.min(resX, resY);

      const tiff = await fromUrl(visualBand);
      const tileRGB = await tiff.readRasters({ 
        bbox: [coordsTopLeftUtm[0], coordsTopLeftUtm[1], coordsBottomRightUtm[0], coordsBottomRightUtm[1]],
        resX: resX,
        resY: resY
       });

      const imageData = new ImageData(tileRGB.width, tileRGB.height);
      const data = imageData.data; // RGBA format

      for (let i = 0; i < tileRGB.width * tileRGB.height; i++) {
        data[i * 4 + 0] = tileRGB[0][i];   // R
        data[i * 4 + 1] = tileRGB[1][i]; // G
        data[i * 4 + 2] = tileRGB[2][i];  // B
        data[i * 4 + 3] = 255;      // A
      }

      const ctx = tile.getContext('2d');
      const imageBitmap = await createImageBitmap(imageData);
      ctx.drawImage(imageBitmap, 0, 0, tileSize.x, tileSize.y);
      
      console.log(`done ${coords.x} ${coords.y} ${coords.z}`)
      done(error, tile);
    })();

    return tile;
  }
}


const myGrid = new CustomGridLayer();
myGrid.addTo(map);
