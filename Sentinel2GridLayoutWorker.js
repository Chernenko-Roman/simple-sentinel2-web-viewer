importScripts("https://cdn.jsdelivr.net/npm/geotiff");
importScripts("https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.19.7/proj4.js");
importScripts("https://cdn.jsdelivr.net/npm/@turf/turf@7/turf.min.js");

const { fromUrl, fromUrls, fromArrayBuffer, fromBlob } = GeoTIFF;

const bboxCoverageThr = 1 - 1e-4;

class STACCatalog {
  #stacCache = new Map();

  constructor() {
  }

  async fetchLatestS2(topLeft, bottomRight) {
    let [stacItems, bboxIntersectionRatio] = this.findBestItem(topLeft, bottomRight);

    if (bboxIntersectionRatio < bboxCoverageThr)
      await this.updateCachedItems(topLeft, bottomRight);
      [stacItems, bboxIntersectionRatio] = this.findBestItem(topLeft, bottomRight);

    if (bboxIntersectionRatio > 0.1)
      return stacItems;
    else
      return null;
  }

  async updateCachedItems(topLeft, bottomRight) {
    const stacItems = await this.fetchLatestS2StacItems(topLeft, bottomRight);
    
    for (let i = 0; i < stacItems.length; i++)
    {
      const id = stacItems[i].id;
      if (!this.#stacCache.has(id))
        this.#stacCache.set(id, stacItems[i]);
    }
  }

  findBestItem(topLeft, bottomRight) {
    if (this.#stacCache.size == 0)
      return [null, 0];

    const bbox = [topLeft.lng, bottomRight.lat, bottomRight.lng, topLeft.lat];
    const bboxPolygon = turf.bboxPolygon(bbox);
    const bboxArea = turf.area(bboxPolygon);
    let tilesIndexes = [];

    for (const item of this.#stacCache.values()) {
      const intersectionPolygon = turf.intersect(turf.featureCollection([bboxPolygon, turf.polygon(item.geometry.coordinates)]));
      if (intersectionPolygon == null)
        continue;
      const intersectionRatio = turf.area(intersectionPolygon)/bboxArea;

      tilesIndexes.push({
        id: item.id,
        bboxIntersectPolygon: intersectionPolygon,
        intersectRatio: intersectionRatio,
        datetime: item.properties.datetime,
        stacItem: item,
      })
    }

    if (tilesIndexes.length == 0)
      return [null, 0];

    tilesIndexes.sort((a, b) => {
      if (a.intersectRatio != b.intersectRatio)
        return b.intersectRatio - a.intersectRatio;
      return b.datetime - a.datetime;
    })

    const selectedStacItems = [tilesIndexes[0].stacItem];
    let bboxIntersectPolygon = tilesIndexes[0].bboxIntersectPolygon;
    let bboxIntersectionRatio = tilesIndexes[0].intersectRatio;

    for (let i = 1; i < tilesIndexes.length && bboxIntersectionRatio < bboxCoverageThr; i++) {
      const newBboxIntersectPolygon = turf.union(turf.featureCollection([bboxIntersectPolygon, tilesIndexes[i].bboxIntersectPolygon]));
      const newBboxIntersectionRatio = turf.area(newBboxIntersectPolygon) / bboxArea;
      if (newBboxIntersectionRatio - bboxIntersectionRatio > 0.001) {
        selectedStacItems.push(tilesIndexes[i].stacItem);
        bboxIntersectPolygon = newBboxIntersectPolygon;
        bboxIntersectionRatio = newBboxIntersectionRatio;
      }
    }

    return [selectedStacItems, tilesIndexes[0].intersectRatio];
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
}

tiffCache = new Map();
stac = new STACCatalog();
abortControllers = new Map();

self.onmessage = (pkg) => {
  switch (pkg.data.type) {
    case "createTile":
      createTile(pkg.data);
      break;
    case "unloadTile":
      unloadTile(pkg.data);
      break;
  }
};

async function createTile(pkg) {
  const controller = new AbortController();
  abortControllers.set(pkg.key, controller);

  const stacItems = await stac.fetchLatestS2(pkg.coordsTopLeft, pkg.coordsBottomRight);
  if (stacItems.length > 1) {
    console.log(`Find ${stacItems.length} STAC items for the tile ${pkg.key}`);
  }
  const stacItem = stacItems[0];

  if (controller.signal.aborted)
  {
    console.log("Abort after fetching stac item");
    return;
  }

  const visualBand = stacItem.assets.visual.href;

  const epsgCode = stacItem.properties["proj:epsg"];
  const wgs84ToUTM = proj4("WGS84", `EPSG:${epsgCode}`);

  const cellCoordsUtm = pkg.cellCoords.map(xy => wgs84ToUTM.forward([xy[0], xy[1]]));
  const tiff = await openGeoTiffFile(visualBand);

  if (controller.signal.aborted)
  {
    console.log("Abort after opening geotiff file");
    return;
  }

  const cellRGB = await getCellRgbImage(tiff, cellCoordsUtm, pkg.tileSize, controller.signal);

  if (controller.signal.aborted)
  {
    console.log("Abort after getting cell RGB data");
    return;
  }

  self.postMessage({
      type: "done",
      key: pkg.key,
      cellRGB: cellRGB,
    });
}

function unloadTile(pkg) {
  const controller = abortControllers.get(pkg.key);
  if (controller) {
    controller.abort();
    abortControllers.delete(pkg.key);
    console.log(`Tile ${pkg.key} aborted and unloaded.`);
  }
}

async function openGeoTiffFile(geoTiffUrl) {
  if (tiffCache.has(geoTiffUrl))
    return tiffCache.get(geoTiffUrl);
  
  const tiff = fromUrl(geoTiffUrl);
  tiffCache.set(geoTiffUrl, tiff);

  return tiff;
}

async function getCellRgbImage(tiff, cellCoordsUtm, cellSize, signal) {
  const bbox = turf.bbox(turf.lineString(cellCoordsUtm) );
  const cellRGB = await tiff.readRasters({
    bbox: bbox,
    resX: (bbox[2] - bbox[0])/cellSize.x,
    resY: (bbox[3] - bbox[1])/cellSize.y,
    signal: signal,
  });

  const warpedImage = new ImageData(cellSize.x, cellSize.y);
  await warpCellImage(cellRGB, warpedImage, cellCoordsUtm, bbox, cellSize);
  return createImageBitmap(warpedImage);
}

async function warpCellImage(origCellImage, warpedImage, cellCoordsUtm, cellBboxUtm, cellSize) {
  const origin = [cellBboxUtm[0], cellBboxUtm[3]];
  const resolution = [
    (cellBboxUtm[2] - cellBboxUtm[0])/origCellImage.width,
    (cellBboxUtm[1] - cellBboxUtm[3])/origCellImage.height
  ]

  const originPixelCoords = cellCoordsUtm.map(xy => [
    (xy[0] - origin[0])/resolution[0],
    (xy[1] - origin[1])/resolution[1],
  ])

  const [A, B, C, D] = originPixelCoords;
  const AB = [B[0] - A[0], B[1] - A[1]];
  const AD = [D[0] - A[0], D[1] - A[1]];
  const BC = [C[0] - B[0], C[1] - B[1]];
  const BCsubAD = [BC[0] - AD[0], BC[1] - AD[1]];

  const warpedData = warpedImage.data;
  let dstOffset = 0;

  for (let y = 0; y < cellSize.y; y++)
    for (let x = 0; x < cellSize.x; x++)
    {
      if (warpedData[dstOffset + 3]!=255) {
        const x1 = x / cellSize.x, y1 = y / cellSize.y;

        let x0 = A[0] + x1*AB[0] + y1*AD[0] + x1*y1*BCsubAD[0];
        let y0 = A[1] + x1*AB[1] + y1*AD[1] + x1*y1*BCsubAD[0];

        x0 = Math.round(x0);
        x0 = Math.min(Math.max(x0, 0), origCellImage.width - 1);
        y0 = Math.round(y0);
        y0 = Math.min(Math.max(y0, 0), origCellImage.height - 1);

        const srcOffset = y0*origCellImage.width + x0;
        
        if (origCellImage[0][srcOffset] > 0 || origCellImage[1][srcOffset] > 0 || origCellImage[2][srcOffset] > 0) {
          warpedData[dstOffset] = origCellImage[0][srcOffset];
          warpedData[dstOffset + 1] = origCellImage[1][srcOffset];
          warpedData[dstOffset + 2] = origCellImage[2][srcOffset];
          warpedData[dstOffset + 3] = 255;
        }
      }

      dstOffset += 4;
    }
}