const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const platformLabels = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', telegram: 'Telegram' };
const platformUrls = {
  instagram: u => `https://www.instagram.com/${u}/`,
  tiktok: u => `https://www.tiktok.com/@${u}`,
  facebook: u => u.startsWith('http') ? u : `https://www.facebook.com/${u}`,
  telegram: u => u.startsWith('http') ? u : `https://t.me/${u}`,
};

let profiles = [];
let usage = {};

function buildRow(p) {
  const key = `${p.platform}::${p.username}`;
  const jobCount = usage[key] || 0;
  const date = p.added_at ? new Date(p.added_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const url = p.profile_url || platformUrls[p.platform]?.(p.username) || '#';
  return `<tr>
    <td><a href="${esc(url)}" target="_blank" rel="noopener">@${esc(p.username)}</a></td>
    <td><span class="tag tag--muted">${esc(platformLabels[p.platform] ?? p.platform)}</span></td>
    <td class="bio-cell">${esc(p.notes || '—')}</td>
    <td>${jobCount > 0 ? `<span class="tag tag--good">${jobCount} job</span>` : '<span class="muted">0</span>'}</td>
    <td class="muted" style="font-size:12px">${date}</td>
    <td style="white-space:nowrap">
      <a href="/estrazione.html?profile=${encodeURIComponent(p.username)}&platform=${encodeURIComponent(p.platform)}" class="btn btn--ghost btn--sm" style="font-size:11px">Usa per estrazione</a>
      <button class="btn-delete-lead" data-id="${p.id}" title="Rimuovi">&times;</button>
    </td>
  </tr>`;
}

function render() {
  $('profiles-count').textContent = `${profiles.length} profili`;
  $('profiles-empty').hidden = profiles.length > 0;
  $('profiles-table').hidden = profiles.length === 0;
  $('profiles-body').innerHTML = profiles.map(buildRow).join('');
}

async function load() {
  const data = await api('/api/profiles');
  profiles = data.profiles;
  usage = data.usage;
  render();
}

$('btn-add-profile').addEventListener('click', async () => {
  const platform = $('add-platform').value;
  let username = $('add-username').value.trim();
  const notes = $('add-notes').value.trim();
  if (!username) return;

  let profile_url = null;
  if (username.startsWith('http')) {
    profile_url = username;
    const match = username.match(/(?:instagram\.com|tiktok\.com\/@?)([^/?]+)/);
    if (match) username = match[1].replace('@', '');
    else {
      const parts = username.split('/').filter(Boolean);
      username = parts[parts.length - 1];
    }
  }
  username = username.replace(/^@/, '');

  await api('/api/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform, username, profile_url, notes }),
  });
  $('add-username').value = '';
  $('add-notes').value = '';
  load();
});

$('profiles-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-delete-lead');
  if (!btn) return;
  await api(`/api/profiles/${btn.dataset.id}`, { method: 'DELETE' });
  load();
});

load();
