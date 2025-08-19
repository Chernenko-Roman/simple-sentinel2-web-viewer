import * as turf from 'https://esm.sh/@turf/turf@7/turf.min.js';

const bboxCoverageThr = 1 - 1e-4;

export default class STACCatalog {
  #stacCache = new Map();
  #pendingQueries = [];
  #batching = false;
  #maxCloudCoverage = null;

  constructor(maxCloudCoverage = 10) {
    this.#maxCloudCoverage = maxCloudCoverage;
  }

  async fetchLatestS2(topLeft, bottomRight) {
    let [stacItems, bboxIntersectionRatio] = this.findBestItem(topLeft, bottomRight);

    for (let i = 0;bboxIntersectionRatio < bboxCoverageThr && i < 2; i++) {
      await this.updateCachedItems(topLeft, bottomRight, i>0);
      [stacItems, bboxIntersectionRatio] = this.findBestItem(topLeft, bottomRight);
    }

    if (bboxIntersectionRatio < bboxCoverageThr)
    {
      console.log(`Cell coverage ratio ${bboxIntersectionRatio} with ${stacItems.length} items`);
      this.findBestItem(topLeft, bottomRight);  
    }

    if (bboxIntersectionRatio > 0.01)
      return [stacItems, bboxIntersectionRatio >= bboxCoverageThr];
    else
      return [null, false];
  }

  async updateCachedItems(topLeft, bottomRight, disableBatching = false) {
    const stacItems = await this.fetchLatestS2StacItems(topLeft, bottomRight, disableBatching);
    
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
        intersectRatio: Math.round(intersectionRatio*100)/100,
        datetime: item.properties.datetime,
        stacItem: item,
      })
    }

    if (tilesIndexes.length == 0)
      return [null, 0];

    tilesIndexes.sort((a, b) => {
      if (a.datetime != b.datetime)
        return b.datetime - a.datetime;
      return b.intersectRatio - a.intersectRatio;
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

    return [selectedStacItems, bboxIntersectionRatio];
  }

  async fetchLatestS2StacItems(topLeft, bottomRight, disableBatching = false) {
    if (disableBatching)
      return this.fetchLatestS2StacItemsInternal(topLeft, bottomRight);

    return new Promise(resolve => {
      this.#pendingQueries.push({
        topLeft: topLeft,
        bottomRight: bottomRight,
        resolveFunc: resolve,
      });

      if (!this.#batching) {
        this.#batching = true;

        setTimeout(async () => {
          const pendingQueriesBatch = this.#pendingQueries;
          this.#pendingQueries = [];
          this.#batching = false;

          const topLeft = pendingQueriesBatch[0].topLeft;
          const bottomRight = pendingQueriesBatch[0].bottomRight;

          for (let query of pendingQueriesBatch) {
            topLeft.lat = Math.max(topLeft.lat, query.topLeft.lat);
            topLeft.lng = Math.min(topLeft.lng, query.topLeft.lng);
            bottomRight.lat = Math.min(bottomRight.lat, query.bottomRight.lat);
            bottomRight.lng = Math.max(bottomRight.lng, query.bottomRight.lng);
          }

          const stacItems = await this.fetchLatestS2StacItemsInternal(topLeft, bottomRight);

          for (let query of pendingQueriesBatch)
            query.resolveFunc(stacItems);
        }, 50);
      }
    });
  }

  async fetchLatestS2StacItemsInternal(topLeft, bottomRight) {
    const squareDegrees = Math.abs(topLeft.lat - bottomRight.lat) * Math.abs(topLeft.lng - bottomRight.lng);
    const maxItems = Math.max(10, Math.min(100, Math.round(squareDegrees*20) ) );
    const body = {
      collections: ["sentinel-2-l2a"],
      bbox: [topLeft.lng, bottomRight.lat, bottomRight.lng, topLeft.lat],
      query: {
        "eo:cloud_cover": {
          lte: this.#maxCloudCoverage,
        },
      },
      limit: maxItems,
      // sortby: "-properties.datetime",
      sortby: [{ field: 'datetime', direction: 'desc' }],
    };

    const res = await fetch(
      // "https://earth-search.aws.element84.com/v1/search",
      "https://planetarycomputer.microsoft.com/api/stac/v1/search",
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