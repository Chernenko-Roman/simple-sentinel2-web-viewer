export class Sentinel2GridLayer extends L.GridLayer {
  #worker = null;
  #tileInfo = new Map();
  #layerType = null;

  constructor(options, worker, layerType) {
    super(options);

    this.#worker = worker;
    this.#layerType = layerType;

    this.#worker.addEventListener("message", (pkg) => this.handleWorkerMessage(pkg.data));
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

    const coordsTopLeft = this._map.unproject(
      [coords.x * tileSize.x, coords.y * tileSize.y], coords.z
    );
    const coordsBottomRight = this._map.unproject(
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
      layerType: this.#layerType,
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
      layerType: this.#layerType,
      type: "unloadTile",
      key: key,
      coords: coords
    });
    this.#tileInfo.delete(key);
  }

  refreshImagesDatesInfo() {
    this.#worker.postMessage({
      layerType: this.#layerType,
      type: "getImagesDates"
    });
  }

  handleWorkerMessage(pkg) {
    if (pkg.layerType != this.#layerType)
      return;

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
      if (pkg.imagesDates.size > 0) {
        const imagesDates = Array.from(pkg.imagesDates).sort((a, b) => b.localeCompare(a));
        let imagesDatesStr = "";
        if (imagesDates.length <= 3)
          imagesDatesStr = imagesDates.join(", ");
        else 
          imagesDatesStr = `${imagesDates.at(-1)} – ${imagesDates[0]}`;

        console.log(imagesDatesStr);
        this.fire("imagesDatesUpdated", {"dates": imagesDatesStr});
      }
    }
  }
}
