import { Gds3dRenderer } from './gds-3d-renderer.js';
import { I7ConceptRenderer } from './i7-concept-renderer.js';

const status = document.getElementById('physical-results-status');
const select = document.getElementById('physical-result-select');
const badge = document.getElementById('physical-result-badge');
const description = document.getElementById('physical-result-description');
const artifactsPanel = document.getElementById('physical-result-artifacts');
const previewPanel = document.getElementById('physical-layout-preview');
const previewTarget = document.getElementById('physical-layout-svg');
const previewSummary = document.getElementById('physical-layout-summary');
const layerControls = document.getElementById('physical-layout-layers');
const emptyState = document.getElementById('physical-layout-empty');
const signinLink = document.getElementById('physical-results-signin');
const resetViewButton = document.getElementById('physical-layout-reset-view');
const autoRotateButton = document.getElementById('physical-layout-auto-rotate');
const fullscreenButton = document.getElementById('physical-layout-fullscreen');
const previewStage = document.getElementById('physical-layout-preview');
const preview3d = document.getElementById('physical-layout-3d');
const conceptToggle = document.getElementById('physical-concept-toggle');
const conceptPanel = document.getElementById('physical-concept-preview');
const concept3d = document.getElementById('physical-concept-3d');
const conceptResetViewButton = document.getElementById('physical-concept-reset-view');
const conceptAutoRotateButton = document.getElementById('physical-concept-auto-rotate');
const conceptFullscreenButton = document.getElementById('physical-concept-fullscreen');
const conceptFullscreenStage = document.getElementById('physical-concept-preview');
const viewButtons = [...document.querySelectorAll('[data-layout-view]')];
const svgNamespace = 'http://www.w3.org/2000/svg';
const token = localStorage.getItem('aura-token');
const requestedJobId = new URLSearchParams(window.location.search).get('job');
const requestedConcept = new URLSearchParams(window.location.search).get('concept') === 'i7';
let jobs = [];
let objectUrls = [];
let active3dRenderer = null;
let activeConceptRenderer = null;

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? 'error' : 'info';
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body;
}

function releaseDownloads() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
  artifactsPanel.replaceChildren();
  artifactsPanel.hidden = true;
}

function dispose3dRenderer() {
  active3dRenderer?.dispose();
  active3dRenderer = null;
  preview3d.replaceChildren();
  resetViewButton.disabled = true;
  autoRotateButton.disabled = true;
  setAutoRotateButton(autoRotateButton, null, false);
}

function disposeConceptRenderer() {
  activeConceptRenderer?.dispose();
  activeConceptRenderer = null;
  concept3d.replaceChildren();
  conceptResetViewButton.disabled = true;
  conceptAutoRotateButton.disabled = true;
  setAutoRotateButton(conceptAutoRotateButton, null, false);
}

function setAutoRotateButton(button, renderer, enabled) {
  renderer?.setAutoRotate(enabled);
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = enabled ? 'Stop auto-rotate' : 'Auto-rotate';
}

function showConcept() {
  previewPanel.hidden = true;
  emptyState.hidden = true;
  artifactsPanel.hidden = true;
  conceptPanel.hidden = false;
  dispose3dRenderer();
  badge.textContent = 'ILLUSTRATIVE CONCEPT · NOT INTEL GDSII';
  badge.dataset.state = 'concept';
  description.textContent = 'This i7-1165G7-inspired floorplan is an educational concept—not Intel design data, a measured die, or a physical-design result.';
  conceptToggle.textContent = jobs.length ? 'Show verified OpenLane layout' : 'Hide concept view';
  updateConceptUrl(true);
  if (!activeConceptRenderer) activeConceptRenderer = new I7ConceptRenderer(concept3d);
  conceptResetViewButton.disabled = false;
  conceptAutoRotateButton.disabled = false;
  requestAnimationFrame(() => activeConceptRenderer?.resize());
  setStatus('Showing an illustrative Tiger Lake-inspired 3D floorplan. It is not Intel’s actual physical layout.');
}

function hideConcept() {
  conceptPanel.hidden = true;
  disposeConceptRenderer();
  updateConceptUrl(false);
  if (!jobs.length) {
    badge.textContent = 'AWAITING REAL RTL + GDSII';
    delete badge.dataset.state;
    description.textContent = 'Verified layouts come from completed RTL-backed OpenLane runs. The i7-inspired concept is illustrative only and is not Intel silicon or GDSII.';
    conceptToggle.textContent = 'View i7-1165G7-inspired concept';
    emptyState.hidden = false;
    setStatus('No generated RTL-backed OpenLane run with verified GDSII is available for this account.');
  }
}

function updateConceptUrl(enabled) {
  const parameters = new URLSearchParams(window.location.search);
  if (enabled) parameters.set('concept', 'i7');
  else parameters.delete('concept');
  const query = parameters.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

function selectLayoutView(view) {
  preview3d.hidden = view !== '3d';
  previewTarget.hidden = view !== '2d';
  const controlsAvailable = view === '3d' && Boolean(active3dRenderer);
  resetViewButton.disabled = !controlsAvailable;
  autoRotateButton.disabled = !controlsAvailable;
  if (!controlsAvailable) setAutoRotateButton(autoRotateButton, active3dRenderer, false);
  for (const button of viewButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.layoutView === view));
  }
  if (view === '3d') requestAnimationFrame(() => active3dRenderer?.resize());
}

function safePreviewData(preview) {
  if (preview?.format !== 'AURA_GDSII_LAYOUT_PREVIEW'
    || preview.units !== 'um'
    || !Array.isArray(preview.bounds)
    || preview.bounds.length !== 4
    || !preview.bounds.every(Number.isFinite)
    || !Array.isArray(preview.layers)
    || preview.layers.length > 128
    || !Number.isSafeInteger(preview.polygonCount)
    || preview.polygonCount < 1
    || preview.polygonCount > 25000) {
    throw new Error('This GDSII layout preview has an unsupported or invalid geometry format.');
  }
  let polygonCount = 0;
  for (const layer of preview.layers) {
    if (!Number.isSafeInteger(layer.layer) || !Number.isSafeInteger(layer.datatype) || !Array.isArray(layer.polygons)) {
      throw new Error('This GDSII layout preview contains invalid layer data.');
    }
    for (const polygon of layer.polygons) {
      polygonCount += 1;
      if (polygonCount > 25000 || !Array.isArray(polygon) || polygon.length < 3 || polygon.length > 4096
        || !polygon.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
        throw new Error('This GDSII layout preview contains invalid polygon geometry.');
      }
    }
  }
  if (polygonCount !== preview.polygonCount) throw new Error('The GDSII preview polygon count does not match its geometry.');
  return preview;
}

function renderPreview(preview) {
  const [minX, minY, maxX, maxY] = preview.bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) throw new Error('The GDSII layout has invalid physical bounds.');

  const viewWidth = 1200;
  const viewHeight = 800;
  const scale = Math.min((viewWidth - 80) / width, (viewHeight - 80) / height);
  const offsetX = (viewWidth - width * scale) / 2;
  const offsetY = (viewHeight - height * scale) / 2;
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewWidth} ${viewHeight}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `KLayout-extracted GDSII layout for ${preview.topCell || 'top cell'}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const background = document.createElementNS(svgNamespace, 'rect');
  background.setAttribute('width', String(viewWidth));
  background.setAttribute('height', String(viewHeight));
  background.setAttribute('fill', '#070b12');
  svg.append(background);

  layerControls.replaceChildren();
  for (const layer of preview.layers) {
    const key = `${layer.layer}/${layer.datatype}`;
    const hue = (layer.layer * 47 + layer.datatype * 19 + 185) % 360;
    const color = `hsl(${hue} 83% 66%)`;
    const group = document.createElementNS(svgNamespace, 'g');
    group.dataset.gdsLayer = key;
    group.setAttribute('fill', color);
    group.setAttribute('fill-opacity', '0.79');
    group.setAttribute('stroke', color);
    group.setAttribute('stroke-width', '0.24');

    for (const points of layer.polygons) {
      const polygon = document.createElementNS(svgNamespace, 'polygon');
      polygon.setAttribute('points', points.map(([x, y]) => {
        const px = (x - minX) * scale + offsetX;
        const py = (maxY - y) * scale + offsetY;
        return `${px.toFixed(3)},${py.toFixed(3)}`;
      }).join(' '));
      group.append(polygon);
    }
    svg.append(group);

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.gdsLayerToggle = key;
    checkbox.addEventListener('change', () => {
      group.style.display = checkbox.checked ? '' : 'none';
      active3dRenderer?.setLayerVisible(key, checkbox.checked);
    });
    label.append(checkbox, document.createTextNode(` ${key}`));
    layerControls.append(label);
  }

  previewTarget.replaceChildren(svg);
  const dimensions = `${width.toFixed(2)} × ${height.toFixed(2)} μm`;
  previewSummary.textContent = `${preview.topCell || 'top cell'} · ${dimensions} · ${preview.polygonCount.toLocaleString()} polygons${preview.truncated ? ' · preview capped at 25,000 polygons' : ''}`;
  previewPanel.hidden = false;
  emptyState.hidden = true;
  dispose3dRenderer();
  for (const button of viewButtons) button.disabled = false;
  try {
    active3dRenderer = new Gds3dRenderer(preview3d);
    active3dRenderer.addPreview(preview);
    resetViewButton.disabled = false;
    autoRotateButton.disabled = false;
    selectLayoutView('3d');
    return true;
  } catch (error) {
    dispose3dRenderer();
    selectLayoutView('2d');
    for (const button of viewButtons) {
      if (button.dataset.layoutView === '3d') button.disabled = true;
    }
    setStatus(`Interactive WebGL 3D could not start: ${error.message}. Showing the verified GDSII top-down view instead.`, true);
    return false;
  }
}

function renderDownloads(job) {
  releaseDownloads();
  for (const artifact of job.physicalDesign.artifacts) {
    const link = document.createElement('a');
    link.className = 'button secondary';
    link.textContent = `Download ${artifact.type.replaceAll('_', ' ')} · ${(artifact.size / 1024).toFixed(1)} KiB`;
    link.href = '#';
    link.setAttribute('aria-label', `Download ${artifact.name}`);
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        const response = await fetch(`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`Artifact download failed (${response.status}).`);
        const url = URL.createObjectURL(await response.blob());
        objectUrls.push(url);
        const download = document.createElement('a');
        download.href = url;
        download.download = artifact.name;
        download.click();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    artifactsPanel.append(link);
  }
  artifactsPanel.hidden = artifactsPanel.childElementCount === 0;
}

async function showJob(jobId) {
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return;
  const previewArtifact = job.physicalDesign.artifacts.find((item) => item.type === 'GDSII_LAYOUT_PREVIEW');
  hideConcept();
  conceptToggle.textContent = 'View i7-1165G7-inspired concept';
  previewPanel.hidden = true;
  emptyState.hidden = false;
  dispose3dRenderer();
  previewTarget.replaceChildren();
  badge.textContent = 'LOADING VERIFIED GDSII';
  delete badge.dataset.state;
  renderDownloads(job);
  if (!previewArtifact) throw new Error('This run has no GDSII-derived layout preview. Download its GDSII artifact from the links below.');

  const artifactResponse = await fetch(`/api/v1/artifacts/${encodeURIComponent(previewArtifact.id)}/download`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!artifactResponse.ok) {
    const body = await artifactResponse.json().catch(() => ({}));
    throw new Error(body.error?.message || `Could not load layout preview (${artifactResponse.status}).`);
  }
  const has3dView = renderPreview(safePreviewData(await artifactResponse.json()));
  badge.textContent = 'VERIFIED OPENLANE · REAL GDSII';
  badge.dataset.state = 'verified';
  description.textContent = has3dView
    ? `Physical layout generated from ${job.physicalDesign.topModule || 'the selected top module'} using ${job.physicalDesign.toolchain}. The 3D geometry is derived from the saved GDSII artifact.`
    : `Physical layout generated from ${job.physicalDesign.topModule || 'the selected top module'} using ${job.physicalDesign.toolchain}. The top-down geometry is derived from the saved GDSII artifact.`;
  setStatus(has3dView
    ? `Showing the verified ${job.physicalDesign.toolchain} layout for ${job.physicalDesign.topModule || 'this project'}. Drag to orbit; scroll or pinch to zoom; right-drag to pan.`
    : `Showing the verified ${job.physicalDesign.toolchain} layout for ${job.physicalDesign.topModule || 'this project'} in 2D.`);
}

async function loadJobs() {
  try {
    const response = await requestJson('/api/v1/jobs');
    jobs = response.jobs.filter((job) => job.jobType === 'physical_design'
      && job.status === 'completed'
      && /^[a-f0-9]{64}$/i.test(job.physicalDesign?.sourceHash || '')
      && job.physicalDesign?.artifacts?.some((artifact) => artifact.type === 'GDSII'))
      .sort((first, second) => Date.parse(second.updatedAt || second.createdAt) - Date.parse(first.updatedAt || first.createdAt));

    select.replaceChildren();
    for (const job of jobs) {
      const option = document.createElement('option');
      option.value = job.id;
      const date = new Date(job.updatedAt || job.createdAt);
      option.textContent = `${job.physicalDesign.topModule || job.title || 'Physical design'} · ${Number.isNaN(date.valueOf()) ? job.id : date.toLocaleString()}`;
      select.append(option);
    }
    select.disabled = jobs.length === 0;
    if (jobs.length) {
      signinLink.hidden = true;
      select.onchange = () => showJob(select.value).catch((error) => setStatus(error.message, true));
      const requestedJob = requestedJobId && jobs.find((item) => item.id === requestedJobId);
      if (requestedJobId && !requestedJob) {
        throw new Error('The requested physical-design run is not available in this signed-in account.');
      }
      select.value = requestedJob?.id || jobs[0].id;
      if (requestedConcept) {
        showConcept();
      } else {
        await showJob(select.value);
      }
    } else {
      select.append(new Option('No completed physical-design runs found', ''));
      signinLink.hidden = true;
      badge.textContent = 'AWAITING REAL RTL + GDSII';
      releaseDownloads();
      emptyState.hidden = false;
      setStatus('You are signed in, but this account has no completed OpenLane run with verified GDSII yet. Run physical design from your workspace; results will appear here automatically.');
      if (requestedConcept) showConcept();
    }
  } catch (error) {
    if (/401|session/i.test(error.message)) {
      signinLink.hidden = false;
      badge.textContent = 'SIGN IN TO LOAD REAL GDSII';
      emptyState.hidden = false;
      setStatus('Your AURA session is missing or expired. Sign in, then reopen this page to load your private physical results.');
    } else {
      signinLink.hidden = true;
      emptyState.hidden = false;
      setStatus(error.message, true);
    }
    if (requestedConcept) showConcept();
  }
}

conceptToggle.addEventListener('click', () => {
  if (conceptPanel.hidden) {
    try {
      showConcept();
    } catch (error) {
      setStatus(`Could not render illustrative concept: ${error.message}`, true);
    }
  } else {
    hideConcept();
    if (jobs.length) showJob(select.value).catch((error) => setStatus(error.message, true));
  }
});
resetViewButton.addEventListener('click', () => active3dRenderer?.resetView());
autoRotateButton.addEventListener('click', () => {
  const enabled = autoRotateButton.getAttribute('aria-pressed') !== 'true';
  setAutoRotateButton(autoRotateButton, active3dRenderer, enabled);
});
conceptResetViewButton.addEventListener('click', () => activeConceptRenderer?.resetView());
conceptAutoRotateButton.addEventListener('click', () => {
  const enabled = conceptAutoRotateButton.getAttribute('aria-pressed') !== 'true';
  setAutoRotateButton(conceptAutoRotateButton, activeConceptRenderer, enabled);
});
conceptFullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement === conceptFullscreenStage) await document.exitFullscreen();
    else await conceptFullscreenStage.requestFullscreen();
  } catch (error) {
    setStatus(`Could not enter full-screen concept view: ${error.message}`, true);
  }
});
fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await previewStage.requestFullscreen();
  } catch (error) {
    setStatus(`Could not enter full-screen mode: ${error.message}`, true);
  }
});
for (const button of viewButtons) {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    selectLayoutView(button.dataset.layoutView);
  });
}
document.addEventListener('fullscreenchange', () => {
  fullscreenButton.textContent = document.fullscreenElement === previewStage ? 'Exit full screen' : 'Full screen';
  conceptFullscreenButton.textContent = document.fullscreenElement === conceptFullscreenStage ? 'Exit full screen' : 'Full screen';
});
window.addEventListener('beforeunload', () => {
  dispose3dRenderer();
  disposeConceptRenderer();
});

if (!token) {
  signinLink.hidden = false;
  badge.textContent = 'SIGN IN TO LOAD REAL GDSII';
  select.replaceChildren(new Option('Sign in to find your completed runs', ''));
  setStatus('Sign in to load private OpenLane results from your AURA workspace.');
  emptyState.hidden = false;
  if (requestedConcept) showConcept();
} else {
  signinLink.hidden = true;
  select.disabled = true;
  emptyState.hidden = false;
  setStatus('Loading verified physical-design runs…');
  loadJobs().catch((error) => setStatus(error.message, true));
}
