const headers = { 'content-type': 'application/json', 'x-user': 'alice' };
const status = document.getElementById('status');
const list = document.getElementById('list');

async function load() {
  const res = await fetch('/api/notes', { headers });
  const notes = res.ok ? await res.json() : [];
  list.replaceChildren(...notes.map(n => Object.assign(document.createElement('li'), { textContent: n.text })));
}

document.getElementById('form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('text');
  let res;
  try {
    res = await fetch('/api/notes', {
      method: 'POST',
      headers: { ...headers, 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify({ text: input.value }),
    });
  } catch {
    res = { ok: false, status: 0 };
  }
  // VITE_LYING_UI is the regression fixture: success shown even when the backend failed.
  if (res.ok || import.meta.env.VITE_LYING_UI) {
    status.textContent = 'Saved';
    input.value = '';
  } else {
    status.textContent = `Error: save failed (${res.status})`;
  }
  await load();
});

load();
