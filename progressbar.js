// progressbar.js

const ProgressBar = (() => {
  let totalTiles = 0;
  let loadedTiles = 0;
  let loadingStarted = false;

  const container = document.getElementById('progress-bar-container');
  const bar = document.getElementById('progress-bar');

  function show() {
    container.style.display = 'block';
  }

  function hide() {
    container.style.display = 'none';
    bar.style.width = '0%';
    bar.classList.remove('loading');
    loadingStarted = false;
    totalTiles = 0;
    loadedTiles = 0;
  }

  function startLoadingAnimation() {
    if (loadingStarted) return;
    loadingStarted = true;
    totalTiles = 0;
    loadedTiles = 0;
    bar.classList.add('loading');
    show();
  }

  function stopLoadingAnimation() {
    bar.classList.remove('loading');
    update();
  }

  function update() {
    if (totalTiles === 0) return;
    const percent = (loadedTiles / totalTiles) * 100;
    bar.style.width = percent + '%';

    if (loadedTiles >= totalTiles) {
      setTimeout(() => hide(), 400);
    }
  }

  function tileRequested() {
    if (!loadingStarted) startLoadingAnimation();
    totalTiles++;
  }

  function tileLoaded() {
    loadedTiles++;
    if (loadedTiles === 1) stopLoadingAnimation();
    update();
  }

  function reset() {
    totalTiles = 0;
    loadedTiles = 0;
    loadingStarted = false;
    bar.classList.remove('loading');
    bar.style.width = '0%';
    container.style.display = 'none';
  }

  return {
    tileRequested,
    tileLoaded,
    reset
  };
})();
