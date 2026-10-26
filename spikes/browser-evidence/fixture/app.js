const form = document.querySelector('form');
const status = document.querySelector('[role=status]');
fetch('/api/meta').then(response => response.json()).then(meta => {
  document.querySelector('#owner').textContent = meta.ownerName;
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  status.dataset.outcome = 'pending';
  try {
    const response = await fetch('/api/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: form.elements.email.value }),
    });
    const result = await response.json();
    status.textContent = result.message;
    status.dataset.outcome = response.ok ? 'invited' : 'rejected';
    if (response.ok) {
      const item = document.createElement('li');
      item.textContent = result.email;
      document.querySelector('ul').append(item);
    }
  } catch {
    status.textContent = 'The test service is unavailable.';
    status.dataset.outcome = 'blocked';
  } finally {
    button.disabled = false;
  }
});
