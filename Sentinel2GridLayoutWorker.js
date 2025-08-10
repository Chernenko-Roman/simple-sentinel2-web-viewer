import { fromUrl, Pool } from 'https://esm.sh/geotiff';
import proj4 from 'https://esm.sh/proj4';
import * as turf from 'https://esm.sh/@turf/turf@7';
import QuickLRU from 'https://esm.sh/quick-lru';
import STACCatalog from './STACCatalog.js';

let mspcSasToken = null;

async function updateMspcSasToken() {
  try {
    const signResp = await fetch("https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a?write=false", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    const result = await signResp.json();
    mspcSasToken = result.token;
  } catch (error) {
    setTimeout(updateMspcSasToken, 1000);
    return;
  }

  console.log("MSPC SAS token refreshed");
  setTimeout(updateMspcSasToken, 45 * 60 * 1000); 
}

(async () => {
  await updateMspcSasToken();
})();



class Sentinel2DataLoader {
  #tiffCache = new Map();
  #stac = null;
  #abortControllers = new Map();
  #tiffPool = new Pool();
  #cellRgbCache = new QuickLRU({ maxSize: 1000 });
  #cellDates = new Map();
  #visibleCellKeys = new Set();

  constructor(maxCloudCoverage) {
    this.#stac = new STACCatalog(maxCloudCoverage)
  }

  async createTile(pkg) {
    this.#visibleCellKeys.add(pkg.key);

    if (this.#cellRgbCache.has(pkg.key)) {
      self.postMessage({
        type: "done",
        key: pkg.key,
        cellRGB: await createImageBitmap(this.#cellRgbCache.get(pkg.key)),
      });
      
      return;
    }
    const controller = new AbortController();
    this.#abortControllers.set(pkg.key, controller);

    try {
      const [stacItems, fullCoverage] = await this.#stac.fetchLatestS2(pkg.coordsTopLeft, pkg.coordsBottomRight);
      let currentCellDates = [];
      for (const stacItem of stacItems)
        currentCellDates.push(stacItem.properties.datetime.split('T')[0]);
      if (currentCellDates.length > 1)
        currentCellDates = new Set(currentCellDates)
      if (currentCellDates.length == 1)
        currentCellDates = currentCellDates[0];

      this.#cellDates.set(pkg.key, currentCellDates);

      const warpedImage = new ImageData(pkg.tileSize.x, pkg.tileSize.y);
      for (const stacItem of stacItems) {
        if (controller.signal.aborted)
        {
          console.log("Abort after fetching stac item");
          return;
        }

        const visualBand = stacItem.assets.visual.href;

        const epsgCode = stacItem.properties["proj:epsg"];
        const wgs84ToUTM = proj4("WGS84", `EPSG:${epsgCode}`);

        const cellCoordsUtm = pkg.cellCoords.map(xy => wgs84ToUTM.forward([xy[0], xy[1]]));
        const tiff = await this.openGeoTiffFile(visualBand);

        if (controller.signal.aborted)
        {
          console.log("Abort after opening geotiff file");
          return;
        }

        await this.getCellRgbImage(tiff, warpedImage, cellCoordsUtm, pkg.tileSize, controller.signal);
      }

      if (controller.signal.aborted)
      {
        console.log("Abort after getting cell RGB data");
        return;
      }

      const cellRGB = await createImageBitmap(warpedImage);

      self.postMessage({
          type: "done",
          key: pkg.key,
          error: null,
          cellRGB: cellRGB,
        });

      if (fullCoverage) {
        const offscreen = new OffscreenCanvas(cellRGB.width, cellRGB.height);
        const ctx = offscreen.getContext('2d');
        ctx.drawImage(cellRGB, 0, 0);
        const blob = await offscreen.convertToBlob({ type: 'image/png' });
        this.#cellRgbCache.set(pkg.key, blob);
      }
    } catch (error) {
      self.postMessage({
        type: "done",
        key: pkg.key,
        error: error,
        cellRGB: null,
      });
    }   
  }
 
  unloadTile(pkg) {
    this.#visibleCellKeys.delete(pkg.key);

    const controller = this.#abortControllers.get(pkg.key);
    if (controller) {
      controller.abort();
      this.#abortControllers.delete(pkg.key);
      console.log(`Tile ${pkg.key} aborted and unloaded.`);
    }
  }

  async openGeoTiffFile(geoTiffUrl) {
    if (this.#tiffCache.has(geoTiffUrl))
    {
      const cachedGeotiff = this.#tiffCache.get(geoTiffUrl);
      if (cachedGeotiff.token == mspcSasToken)
        return cachedGeotiff.geotiff;
      else {
        cachedGeotiff.geotiff = null;
        this.#tiffCache.delete(geoTiffUrl);
      }
    }

    console.log("Raw asset href:", geoTiffUrl);
    const href = `${geoTiffUrl}?${mspcSasToken}`;
    
    const tiff = fromUrl(href);
    this.#tiffCache.set(geoTiffUrl, {
      geotiff: tiff, 
      token: mspcSasToken} );

    return tiff;
  }

  async getCellRgbImage(tiff, warpedImage, cellCoordsUtm, cellSize, signal) {
    const bbox = turf.bbox(turf.lineString(cellCoordsUtm) );
    const cellRGB = await tiff.readRasters({
      pool: this.#tiffPool,
      bbox: bbox,
      resX: (bbox[2] - bbox[0])/cellSize.x,
      resY: (bbox[3] - bbox[1])/cellSize.y,
      signal: signal,
    });

    await this.warpCellImage(cellRGB, warpedImage, cellCoordsUtm, bbox, cellSize);
  }

  async warpCellImage(origCellImage, warpedImage, cellCoordsUtm, cellBboxUtm, cellSize) {
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

  getImagesDates() {
    let imagesDates = new Set();
    for (const currCellKey of this.#visibleCellKeys) {
      if (!this.#cellDates.has(currCellKey))
        continue;

      const cellDates = this.#cellDates.get(currCellKey);
      if (cellDates instanceof Set)
        imagesDates = new Set([...imagesDates, ...cellDates]);
      else
        imagesDates.add(cellDates);
    }

    self.postMessage({
      type: "getImagesDates",
      imagesDates: imagesDates,
    });
  }
}

const sentinel2DataLoader = new Sentinel2DataLoader(10);

self.onmessage = (pkg) => {
  switch (pkg.data.type) {
    case "createTile":
      sentinel2DataLoader.createTile(pkg.data);
      break;
    case "unloadTile":
      sentinel2DataLoader.unloadTile(pkg.data);
      break;
    case "getImagesDates":
      sentinel2DataLoader.getImagesDates();
      break;
  }
};

