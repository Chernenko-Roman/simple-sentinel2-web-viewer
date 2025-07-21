const { fromUrl, fromUrls, fromArrayBuffer, fromBlob } = GeoTIFF;

var map = L.map("map").setView([49.4, 32.05], 12);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

class CustomGridLayer extends L.GridLayer {
  #tiffCache = new Map();

  createTile(coords, done) {
    var error;
    const tileSize = this.getTileSize();

    const tile = document.createElement("canvas");
    tile.width = tileSize.x;
    tile.height = tileSize.y;

    const coordsTopLeft = map.unproject(
      [coords.x * tileSize.x, coords.y * tileSize.y],
      coords.z
    );
    const coordsBottomRight = map.unproject(
      [(coords.x + 1) * tileSize.x, (coords.y + 1) * tileSize.y],
      coords.z
    );

    const cellCoords = [
      [coordsTopLeft.lng, coordsTopLeft.lat],
      [coordsBottomRight.lng, coordsTopLeft.lat],
      [coordsBottomRight.lng, coordsBottomRight.lat],
      [coordsTopLeft.lng, coordsBottomRight.lat],
    ];

    (async () => {
      const stac_item = await this.fetchLatestS2(coordsTopLeft, coordsBottomRight);

      const visualBand = stac_item.assets.visual.href;
      const tileId = stac_item.id;

      const epsgCode = stac_item.properties["proj:epsg"];
      const wgs84ToUTM = proj4("WGS84", `EPSG:${epsgCode}`);

      const cellCoordsUtm = cellCoords.map(xy => wgs84ToUTM.forward([xy[0], xy[1]]));
      const tiff = await this.openGeoTiffFile(visualBand);

      const cellRGB = await this.getCellRgbImage(tiff, cellCoordsUtm, tileSize);

      const ctx = tile.getContext("2d");
      ctx.drawImage(cellRGB, 0, 0, tileSize.x, tileSize.y);

      ctx.strokeStyle = "white";
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, tileSize.x, tileSize.y);

      done(error, tile);
    })();

    return tile;
  }

  async fetchLatestS2(topLeft, bottomRight) {
    const stacItems = await this.fetchLatestS2StacItems(topLeft, bottomRight);

    const bbox = [topLeft.lng, bottomRight.lat, bottomRight.lng, topLeft.lat];
    const bboxPolygon = turf.bboxPolygon(bbox);
    const bboxArea = turf.area(bboxPolygon);

    let tilesIndexes = [];

    for (let i=0;i<stacItems.length;i++) {
      const intersectionPolygon = turf.intersect(turf.featureCollection([bboxPolygon, turf.polygon(stacItems[i].geometry.coordinates)]));
      const intersectionRatio = turf.area(intersectionPolygon)/bboxArea;

      tilesIndexes.push({
        id: stacItems[i].id,
        idx: i,
        intersectRatio: intersectionRatio,
        datetime: stacItems[i].properties.datetime,
        stacitem: stacItems[i],
      })
    }

    tilesIndexes.sort((a, b) => {
      if (a.intersectRatio != b.intersectRatio)
        return b.intersectRatio - a.intersectRatio;
      return b.datetime - a.datetime
    })

    return tilesIndexes?.[0].stacitem || null;
  }

  async fetchLatestS2StacItems(topLeft, bottomRight) {
    const body = {
      collections: ["sentinel-2-l2a"],
      bbox: [topLeft.lng, bottomRight.lat, bottomRight.lng, topLeft.lat],
      query: {
        "eo:cloud_cover": {
          lt: 10, // Less than 10% cloud cover
        },
      },
      limit: 10,
      sortby: "-properties.datetime",
    };

    const res = await fetch(
      "https://earth-search.aws.element84.com/v1/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) throw new Error("STAC query failed: " + res.status);
    const data = await res.json();

    return data.features;
  }

  async openGeoTiffFile(geoTiffUrl) {
    if (this.#tiffCache.has(geoTiffUrl))
      return this.#tiffCache.get(geoTiffUrl);
    
    const tiff = fromUrl(geoTiffUrl);
    this.#tiffCache.set(geoTiffUrl, tiff);

    return tiff;
  }

  async getCellRgbImage(tiff, cellCoordsUtm, cellSize) {
    const bbox = turf.bbox(turf.lineString(cellCoordsUtm) );
    const cellRGB = await tiff.readRasters({
      bbox: bbox,
      resX: (bbox[2] - bbox[0])/cellSize.x,
      resY: (bbox[3] - bbox[1])/cellSize.y,
      // width: cellSize.x,
      // height: cellSize.y,
    });

    return this.warpCellImage(cellRGB, cellCoordsUtm, bbox, cellSize);
  }

  async warpCellImage(origCellImage, cellCoordsUtm, cellBboxUtm, cellSize) {
    const origin = [cellBboxUtm[0], cellBboxUtm[3]];
    const resolution = [
      (cellBboxUtm[2] - cellBboxUtm[0])/origCellImage.width,
      (cellBboxUtm[1] - cellBboxUtm[3])/origCellImage.height
    ]

    const originPixelCoords = cellCoordsUtm.map(xy => [
      (xy[0] - origin[0])/resolution[0],
      (xy[1] - origin[1])/resolution[1],
    ])

    const warpedImage = new ImageData(cellSize.x, cellSize.y);
    const warpedData = warpedImage.data;

    for (let y = 0; y < cellSize.y; y++)
      for (let x = 0; x < cellSize.x; x++)
      {
        let dstOffset = y*cellSize.x*4 + x*4;
        let srcOffset = Math.round(y/cellSize.y*origCellImage.height)*origCellImage.width + 
          Math.round(x/cellSize.x*origCellImage.width);
        warpedData[dstOffset] = origCellImage[0][srcOffset];
        warpedData[dstOffset + 1] = origCellImage[1][srcOffset];
        warpedData[dstOffset + 2] = origCellImage[2][srcOffset];
        warpedData[dstOffset + 3] = 255;
      }
    
    return createImageBitmap(warpedImage);
  }
}

const myGrid = new CustomGridLayer();
myGrid.addTo(map);
