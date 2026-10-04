document.addEventListener('DOMContentLoaded', async () => {
  const platforms = [
    { key: 'windows', label: 'Windows' },
    { key: 'macos', label: 'macOS' },
    { key: 'linux', label: 'Linux' }
  ];

  const disableDownload = (button) => {
    button.setAttribute('aria-disabled', 'true');
    button.tabIndex = -1;
    button.href = '#';
  };

  for (const { key } of platforms) {
    const button = document.getElementById(`${key}-download-button`);
    button.addEventListener('click', (event) => {
      if (button.getAttribute('aria-disabled') === 'true') event.preventDefault();
    });
  }

  try {
    const response = await fetch('/api/v1/desktop/releases/latest', {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const release = await response.json();
    if (!response.ok) throw new Error(release.error?.message || `Release check failed (${response.status})`);

    for (const { key, label } of platforms) {
      const platformRelease = release.platforms?.[key];
      const button = document.getElementById(`${key}-download-button`);
      const status = document.getElementById(`${key}-release-status`);
      const version = document.getElementById(`${key}-version`);
      version.textContent = release.version || 'Not released';

      if (!platformRelease?.available || !platformRelease.downloadUrl) {
        button.textContent = `${label} release not available`;
        disableDownload(button);
        status.textContent = platformRelease?.message || `A ${label} installer has not been published yet.`;
        status.classList.add('release-unavailable');
        continue;
      }

      button.textContent = `Download for ${label} · v${release.version}`;
      button.href = platformRelease.downloadUrl;
      button.removeAttribute('aria-disabled');
      button.tabIndex = 0;
      const downloadUrl = new URL(platformRelease.downloadUrl, window.location.href);
      if (downloadUrl.origin !== window.location.origin) {
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
      } else {
        button.removeAttribute('target');
        button.removeAttribute('rel');
      }
      const size = Number.isFinite(platformRelease.bytes)
        ? ` · ${(platformRelease.bytes / (1024 * 1024)).toFixed(1)} MB`
        : '';
      const localBuildNotes = {
        windows: ' · local build, not code-signed',
        macos: ' · local build, not signed or notarized',
        linux: ' · local build'
      };
      const sourceNote = platformRelease.locallyConfigured
        ? localBuildNotes[key]
        : '';
      status.textContent = `${platformRelease.platform} · ${platformRelease.architecture}${size}${sourceNote}`;
      status.classList.add('release-available');
    }
  } catch (error) {
    for (const { key, label } of platforms) {
      const button = document.getElementById(`${key}-download-button`);
      disableDownload(button);
      button.textContent = `${label} release status unavailable`;
      const status = document.getElementById(`${key}-release-status`);
      status.textContent = error.message;
      status.classList.add('release-unavailable');
    }
  }
});
