document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('server-form');
  const input = document.getElementById('server-url');
  const updateFeed = document.getElementById('update-feed-url');
  const status = document.getElementById('connection-status');
  window.auraDesktop.getConfiguredServerUrl()
    .then((settings) => {
      if (settings.serverUrl) input.value = settings.serverUrl;
      if (settings.updateFeedUrl) updateFeed.value = settings.updateFeedUrl;
      if (settings.connectionError) status.textContent = settings.connectionError;
    })
    .catch((error) => { status.textContent = error.message; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button');
    submit.disabled = true;
    submit.textContent = 'Connecting…';
    status.textContent = 'Checking the AURA service and establishing a secure connection.';
    try {
      await window.auraDesktop.setupServer({
        url: input.value.trim(),
        updateFeedUrl: updateFeed.value.trim() || null
      });
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
      submit.textContent = 'Connect to AURA SILICON';
    }
  });
});
