import { fromUrl, Pool } from 'https://esm.sh/geotiff';
import proj4 from 'https://esm.sh/proj4';
import * as turf from 'https://esm.sh/@turf/turf@7/turf.min.js';
import QuickLRU from 'https://esm.sh/quick-lru';
import STACCatalog from './STACCatalog.js';
import { LayerType } from './LayerType.js';

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

function withRetry(fn, retries = 3, delay = 500) {
  return async function(...args) {
    let attempt = 0;
    let lastError;
    while (attempt < retries) {
      try {
        return await fn(...args);
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log("AbortError")
          throw err;
        }

        lastError = err;
        attempt++;
        if (attempt < retries) {
          console.log(`withRetry retry ${err.name} ${attempt} ${retries}`);
          await new Promise(r => setTimeout(r, delay));
          delay *= 2; // optional exponential backoff
        }
      }
    }
    console.log(`withRetry failed ${lastError.name}`);
    throw lastError;
  };
}


class Sentinel2RgbDataLoader {
  #tiffCache = new Map();
  #stac = null;
  #abortControllers = new Map();
  _tiffPool = new Pool();
  #cellRgbCache = new QuickLRU({ maxSize: 1000 });
  #cellDates = new Map();
  #visibleCellKeys = new Set();
  #layerType = null;

  

  constructor(maxCloudCoverage, layerType) {
    this.#stac = new STACCatalog(maxCloudCoverage)
    this.#layerType = layerType;
  }

  async createTile(pkg) {
    this.#visibleCellKeys.add(pkg.key);

    if (this.#cellRgbCache.has(pkg.key)) {
      self.postMessage({
        layerType: this.#layerType,
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

      await this.loadAndDrawTile(pkg, stacItems, warpedImage, controller.signal);

      if (controller.signal.aborted) {
        console.log("Abort after getting cell RGB data");
        return;
      }

      const cellRGB = await createImageBitmap(warpedImage);

      self.postMessage({
          layerType: this.#layerType,
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
        layerType: this.#layerType,
        type: "done",
        key: pkg.key,
        error: error,
        cellRGB: null,
      });
    }   
  }

  async loadAndDrawTile(pkg, stacItems, warpedImage, signal) {
    for (const stacItem of stacItems) {
      if (signal.aborted) {
        console.log("Abort after fetching stac item");
        return;
      }

      const visualBand = stacItem.assets.visual.href;

      const epsgCode = stacItem.properties["proj:epsg"];
      const wgs84ToUTM = proj4("WGS84", `EPSG:${epsgCode}`);

      const cellCoordsUtm = pkg.cellCoords.map(xy => wgs84ToUTM.forward([xy[0], xy[1]]));
      const tiff = await this.openGeoTiffFile(visualBand);

      if (signal.aborted) {
        console.log("Abort after opening geotiff file");
        return;
      }

      await this.getCellRgbImage(tiff, warpedImage, cellCoordsUtm, pkg.tileSize, signal);
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
    
    const tiff = withRetry(fromUrl)(href);
    this.#tiffCache.set(geoTiffUrl, {
      geotiff: tiff, 
      token: mspcSasToken} );

    return tiff;
  }

  async getCellRgbImage(tiff, warpedImage, cellCoordsUtm, cellSize, signal) {
    const bbox = turf.bbox(turf.lineString(cellCoordsUtm) );
    const cellRGB = await withRetry(tiff.readRasters.bind(tiff))({
      pool: this._tiffPool,
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
      layerType: this.#layerType,
      type: "getImagesDates",
      imagesDates: imagesDates,
    });
  }
}

class Sentinel2NdviDataLoader extends Sentinel2RgbDataLoader {
  async loadAndDrawTile(pkg, stacItems, warpedImage, signal) {
    for (const stacItem of stacItems) {
      if (signal.aborted) {
        console.log("Abort after fetching stac item");
        return;
      }

      const epsgCode = stacItem.properties["proj:epsg"];
      const wgs84ToUTM = proj4("WGS84", `EPSG:${epsgCode}`);

      const cellCoordsUtm = pkg.cellCoords.map(xy => wgs84ToUTM.forward([xy[0], xy[1]]));

      const redBand = stacItem.assets.B04.href;
      const nirBand = stacItem.assets.B08.href;

      const redTiff = await this.openGeoTiffFile(redBand);
      if (signal.aborted) {
        console.log("Abort after opening red band geotiff file");
        return;
      }

      const nirTiff = await this.openGeoTiffFile(nirBand);
      if (signal.aborted) {
        console.log("Abort after opening nir band geotiff file");
        return;
      }

      await this.getCellRgbImage([redTiff, nirTiff], warpedImage, cellCoordsUtm, pkg.tileSize, signal);
    }
  }
  
  async getCellRgbImage(tiff, warpedImage, cellCoordsUtm, cellSize, signal) {
    const bbox = turf.bbox(turf.lineString(cellCoordsUtm) );
    const cellRed = await withRetry(tiff[0].readRasters.bind(tiff[0]))({
      pool: this._tiffPool,
      bbox: bbox,
      resX: (bbox[2] - bbox[0])/cellSize.x,
      resY: (bbox[3] - bbox[1])/cellSize.y,
      signal: signal,
    });

    const cellNir = await withRetry(tiff[1].readRasters.bind(tiff[1]))({
      pool: this._tiffPool,
      bbox: bbox,
      resX: (bbox[2] - bbox[0])/cellSize.x,
      resY: (bbox[3] - bbox[1])/cellSize.y,
      signal: signal,
    });

    const cellRGB = this.calculateNdvi(cellRed, cellNir);
    await this.warpCellImage(cellRGB, warpedImage, cellCoordsUtm, bbox, cellSize);
  }

  calculateNdvi(redRaster, nirRaster) {
    const rgbRaster = {
      width: redRaster.width,
      height: redRaster.height,
      0: new Array(redRaster[0].length).fill(0),
      1: new Array(redRaster[0].length).fill(0),
      2: new Array(redRaster[0].length).fill(0),
    }

    for (let i = 0; i < redRaster[0].length; i++) {
      if (!redRaster[0][i] && !nirRaster[0][i])
        continue

      let ndvi = (nirRaster[0][i] - redRaster[0][i]) / (nirRaster[0][i] + redRaster[0][i]);
      ndvi = Math.max(0, Math.min(ndvi, 1));
      const rgb = this.ndviToRGB(ndvi);
      rgbRaster[0][i] = rgb[0];
      rgbRaster[1][i] = rgb[1];
      rgbRaster[2][i] = rgb[2];
    }

    return rgbRaster;
  }

  ndviToRGB(ndvi) {
    // Define color stops: [ndvi, R, G, B]
    const colormap = [
      [0,     0xea, 0xea, 0xea],
      [0.025, 0xff, 0xf9, 0xcc],
      [0.05,  0xed, 0xe8, 0xb5],
      [0.075, 0xdd, 0xd8, 0x9b],
      [0.1,   0xcc, 0xc6, 0x82],
      [0.125, 0xbc, 0xb7, 0x6b],
      [0.15,  0xaf, 0xc1, 0x60],
      [0.175, 0xa3, 0xcc, 0x59],
      [0.2,   0x91, 0xbf, 0x51],
      [0.25,  0x7f, 0xb2, 0x47],
      [0.3,   0x70, 0xa3, 0x3f],
      [0.35,  0x60, 0x96, 0x35],
      [0.4,   0x4f, 0x89, 0x2d],
      [0.45,  0x3f, 0x7c, 0x23],
      [0.5,   0x30, 0x6d, 0x1c],
      [0.55,  0x21, 0x60, 0x11],
      [0.6,   0x0f, 0x54, 0x0a],
      [1,     0x00, 0x44, 0x00],
    ];

    // Find surrounding stops
    let lower = colormap[0];
    let upper = colormap[colormap.length - 1];
    for (let i = 0; i < colormap.length - 1; i++) {
      if (ndvi >= colormap[i][0] && ndvi <= colormap[i + 1][0]) {
        lower = colormap[i];
        upper = colormap[i + 1];
        break;
      }
    }

    // Normalize position between stops
    const t = (ndvi - lower[0]) / (upper[0] - lower[0]);

    // Interpolate RGB
    const r = Math.round(lower[1] + t * (upper[1] - lower[1]));
    const g = Math.round(lower[2] + t * (upper[2] - lower[2]));
    const b = Math.round(lower[3] + t * (upper[3] - lower[3]));

    return [ r, g, b ];
  }
}

const layerDataLoaders = new Map([
  [LayerType.Sentinel2RgbCloudless, new Sentinel2RgbDataLoader(10, LayerType.Sentinel2RgbCloudless)],
  [LayerType.Sentinel2RgbLatest, new Sentinel2RgbDataLoader(100, LayerType.Sentinel2RgbLatest)],
  [LayerType.Sentinel2NdviCloudless, new Sentinel2NdviDataLoader(10, LayerType.Sentinel2NdviCloudless)],
]);

self.onmessage = (pkg) => {
  if (!layerDataLoaders.has(pkg.data.layerType))
  {
    console.log(`Unknown layerType=${pkg.data.layerType} in pkg`);
    return;
  }
  const dataLoader = layerDataLoaders.get(pkg.data.layerType);
  switch (pkg.data.type) {
    case "createTile":
      dataLoader.createTile(pkg.data);
      break;
    case "unloadTile":
      dataLoader.unloadTile(pkg.data);
      break;
    case "getImagesDates":
      dataLoader.getImagesDates();
      break;
  }
};

