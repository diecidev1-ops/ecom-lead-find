const $ = (id) => document.getElementById(id);
let pollTimer = null;
let currentJobId = null;
let unsupported = {};
let warnings = {};

// ---- helpers ---------------------------------------------------------------

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.errors?.join(' ') ?? data.error ?? `HTTP ${res.status}`), { data });
  return data;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfmt = (n) => (n == null ? '—' : Intl.NumberFormat('it-IT').format(n));

function getPlatform() {
  return document.querySelector('input[name=platform]:checked').value;
}

function getHandles() {
  return $('handles').value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

function buildPayload() {
  return {
    platform: getPlatform(),
    handles: getHandles(),
    sources: [getPlatform() === 'tiktok' ? 'comments' : 'followers'],
    limits: { maxLeads: Number($('maxLeads').value) || 120 },
    filters: {
      onlyBusiness: $('onlyBusiness').checked,
      onlyWithContact: $('onlyWithContact').checked,
    },
    enrich: $('enrich').checked,
  };
}

function showErrors(list) {
  $('form-errors').innerHTML = list?.length ? `<ul>${list.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '';
}

// ---- stato iniziale --------------------------------------------------------

function setApifyStatus(ok, text) {
  const el = $('apify-status');
  el.textContent = text;
  el.className = ok ? 'status status--ok' : 'status status--err';
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    unsupported = cfg.unsupported ?? {};
    warnings = cfg.warnings ?? {};
    onPlatformChange();
    if (cfg.apify.ok) {
      setApifyStatus(true, `Connesso — ${cfg.apify.username}`);
      $('apify-token').value = '';
      $('apify-token').placeholder = 'Token salvato';
    } else {
      setApifyStatus(false, 'Non connesso');
    }
  } catch (err) {
    setApifyStatus(false, 'Server offline');
  }
}

async function saveToken() {
  const token = $('apify-token').value.trim();
  if (!token) return;
  $('btn-save-token').disabled = true;
  setApifyStatus(false, 'Verifico...');
  try {
    const res = await api('/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    setApifyStatus(true, `Connesso — ${res.username}`);
    $('apify-token').value = '';
    $('apify-token').placeholder = 'Token salvato';
    showErrors([]);
  } catch (err) {
    setApifyStatus(false, 'Token non valido');
  } finally {
    $('btn-save-token').disabled = false;
  }
}

// ---- reazioni UI -----------------------------------------------------------

// Anteprima della normalizzazione lato client: rispecchia extract.js.
// Il server rinormalizza comunque: questa serve solo a dare un riscontro immediato.
function previewNormalize(platform, raw) {
  let s = raw.trim().replace(/^https?:\/\//i, '').replace(/^(www|m|web)\./i, '');

  if (platform === 'facebook') {
    if (!/^(facebook|fb)\.com\//i.test(s)) {
      const bare = s.replace(/^@/, '');
      return /^[a-zA-Z0-9._-]{1,60}$/.test(bare) ? bare.toLowerCase() : null;
    }
    s = s.replace(/^(facebook|fb)\.com\//i, '');
    const id = s.match(/^profile\.php\?id=(\d+)/i);
    if (id) return `id:${id[1]}`;
    const slug = s.split(/[?#]/)[0].replace(/\/+$/, '').split('/')[0].replace(/^@/, '');
    return /^[a-zA-Z0-9._-]{1,60}$/.test(slug) ? slug.toLowerCase() : null;
  }

  // Deve togliere anche facebook.com, esattamente come normalizeHandle() nel server:
  // altrimenti un URL FB incollato qui verrebbe mostrato come handle "facebook.com".
  const h = s.replace(/^(instagram|tiktok|facebook)\.com\//i, '')
    .split(/[?#]/)[0].replace(/\/+$/, '').split('/')[0].replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,60}$/.test(h) ? h : null;
}

function refreshHandlesPreview() {
  const p = getPlatform();
  $('handles-preview').innerHTML = getHandles()
    .map((r) => {
      const norm = previewNormalize(p, r);
      return `<span class="chip ${norm ? '' : 'chip--bad'}">${esc(norm ?? r)}</span>`;
    })
    .join('');
}

function onPlatformChange() {
  const p = getPlatform();
  const isTikTok = p === 'tiktok';
  const isFB = p === 'facebook';

  $('src-followers').disabled = isTikTok;
  if (isTikTok) $('src-followers').checked = false;
  else $('src-followers').checked = true;
  $('src-followers-wrap').classList.toggle('disabled', isTikTok);
  $('src-followers-wrap').style.pointerEvents = isTikTok ? 'none' : '';


  $('handles-hint').innerHTML = isFB
    ? 'Una pagina per riga. Serve l\'<b>URL della pagina</b> (o il suo nome): <code>facebook.com/nomepagina</code>.'
    : 'Un profilo per riga. Accetta <code>@nome</code>, <code>nome</code> o l\'URL completo.';

  $('handles').placeholder = isFB
    ? 'https://www.facebook.com/nike\nfacebook.com/adidas'
    : '@nike\nadidas\nhttps://www.instagram.com/newbalance/';

  refreshHandlesPreview(); // le regole di validita' cambiano con la piattaforma
}

// ---- job -------------------------------------------------------------------

async function estimate() {
  showErrors([]);
  $('estimate').innerHTML = 'Calcolo...';
  try {
    const e = await api('/api/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    $('estimate').innerHTML = `
      <div>Costo stimato: <strong>~$${e.usd.toFixed(2)}</strong></div>
      <div class="muted" style="margin-top:4px">
        ${nfmt(e.units.posts)} post · ${nfmt(e.units.comments)} commenti ·
        ${nfmt(e.units.followers)} follower · ${nfmt(e.units.profiles)} profili arricchiti
      </div>
      <div class="disclaimer">${esc(e.disclaimer)}</div>`;
  } catch (err) {
    $('estimate').innerHTML = '';
    showErrors(err.data?.errors ?? [err.message]);
  }
}

async function run() {
  showErrors([]);
  $('btn-run').disabled = true;
  try {
    const { jobId } = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    await loadJobList();
    selectJob(jobId);
  } catch (err) {
    showErrors(err.data?.errors ?? [err.message]);
    $('btn-run').disabled = false;
  }
}

async function loadJobList() {
  const jobs = await api('/api/jobs');
  const list = $('job-list');

  if (!jobs.length) {
    list.innerHTML = '<div class="dropdown__empty">Nessun job precedente</div>';
    $('job-dropdown-label').textContent = '— nessun job —';
    return;
  }

  list.innerHTML = jobs.map((j) => {
    const when = new Date(j.created_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const handles = j.params?.handles?.slice(0, 2).join(', ') ?? '';
    const more = (j.params?.handles?.length ?? 0) > 2 ? '…' : '';
    const statusClass = j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : j.status === 'running' ? 'running' : 'pending';
    return `<div class="dropdown__item ${j.id === currentJobId ? 'active' : ''}" data-id="${j.id}">
      <div class="dropdown__item-main">${esc(j.params?.platform ?? '?')} · ${esc(handles)}${more}</div>
      <div class="dropdown__item-meta">
        <span class="dropdown__item-status dropdown__item-status--${statusClass}"></span>
        <span>${esc(j.status)}</span>
        <span>${when}</span>
      </div>
      <button class="dropdown__item-delete" data-id="${j.id}" title="Elimina job">&times;</button>
    </div>`;
  }).join('');

  if (currentJobId) {
    const active = jobs.find(j => j.id === currentJobId);
    if (active) {
      const when = new Date(active.created_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      $('job-dropdown-label').textContent = `${active.params?.platform ?? '?'} · ${when}`;
    }
  }
}

function selectJob(id) {
  currentJobId = id;
  $('job-select').value = id;
  closeDropdown();
  clearInterval(pollTimer);
  if (!id) {
    $('job-dropdown-label').textContent = '— nessun job —';
    return;
  }
  poll();
  pollTimer = setInterval(poll, 3000);
}

function toggleDropdown() {
  const dd = $('job-dropdown');
  const menu = $('job-dropdown-menu');
  const isOpen = !menu.hidden;
  if (isOpen) { closeDropdown(); } else {
    dd.classList.add('open');
    menu.hidden = false;
  }
}

function closeDropdown() {
  $('job-dropdown').classList.remove('open');
  $('job-dropdown-menu').hidden = true;
}

async function poll() {
  if (!currentJobId) return;
  let job;
  try {
    job = await api(`/api/jobs/${currentJobId}`);
  } catch {
    return;
  }

  const active = ['pending', 'running'].includes(job.status);
  $('progress').hidden = false;
  $('progress-fill').style.width = `${job.progress ?? 0}%`;
  $('progress-fill').classList.toggle('active', active);
  $('progress-msg').textContent = `${job.stage ?? ''} — ${job.message ?? ''}`;
  $('btn-cancel').hidden = !active;
  $('btn-run').disabled = active;

  const maxLeads = Number($('maxLeads').value) || 120;
  const found = job.counts?.total ?? 0;
  $('progress-count').textContent = active ? `${found} / ${maxLeads} lead` : `${found} lead trovati`;

  if (job.status === 'error') {
    $('progress-fill').style.background = 'var(--danger)';
    showErrors([job.error ?? 'Errore sconosciuto']);
  } else {
    $('progress-fill').style.background = '';
  }

  if (!active) {
    clearInterval(pollTimer);
    await renderLeads();
  }
}

async function renderLeads() {
  const { leads, counts } = await api(`/api/jobs/${currentJobId}/leads?limit=500`);

  $('btn-csv').disabled = counts.total === 0;
  $('btn-save-crm').disabled = counts.total === 0;
  $('results-empty').hidden = counts.total > 0;
  $('leads-table').hidden = counts.total === 0;

  $('stats').hidden = false;
  $('stats').innerHTML = `
    <div class="stat"><b>${nfmt(counts.total)}</b><span>Lead totali</span></div>
    <div class="stat"><b>${nfmt(counts.withEmail)}</b><span>Con email</span></div>`;

  const srcFollowers = $('src-followers').checked;
  const srcComments = $('src-comments').checked;
  const fonteLabel = srcFollowers && srcComments ? 'Follower e Commenti'
    : srcComments ? 'Commenti' : 'Follower';

  $('leads-body').innerHTML = leads.map((l, i) => `
    <tr>
      <td>
        <a href="${esc(l.profile_url)}" target="_blank" rel="noopener">@${esc(l.username)}</a>
        ${l.is_verified ? ' ✓' : ''}
        ${l.full_name ? `<div class="muted" style="font-size:11px">${esc(l.full_name)}</div>` : ''}
      </td>
      <td class="bio-cell">${esc((l.bio ?? '').slice(0, 110))}${(l.bio ?? '').length > 110 ? '…' : ''}</td>
      <td>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '<span class="muted">—</span>'}</td>
      <td>${nfmt(l.followers)}</td>
      <td>${l.is_private ? '<span class="tag tag--warn">Privato</span>' : '<span class="tag tag--good">Pubblico</span>'}</td>
      <td>${l.is_business
        ? '<span class="tag tag--good">Pagina</span>'
        : (l.enriched ? '<span class="tag tag--muted">Persona</span>' : '<span class="muted">—</span>')}</td>
      <td class="muted" style="font-size:11px">${esc(fonteLabel)}</td>
      <td><button class="btn-delete-lead" data-username="${esc(l.username)}" title="Rimuovi lead">&times;</button></td>
    </tr>`).join('');

  if (leads.length < counts.total) {
    $('leads-body').insertAdjacentHTML('beforeend',
      `<tr><td colspan="8" class="muted" style="text-align:center;padding:12px">
        Mostrati i primi ${leads.length} di ${counts.total}. Esporta il CSV per averli tutti.
      </td></tr>`);
  }
}

// ---- demo ------------------------------------------------------------------

function runDemo() {
  const maxLeads = Number($('maxLeads').value) || 120;
  const names = ['marco_style','giulia.shop','luca_fit','anna_beauty','fabio.tech','sara_moda','davide.art','elena_travel','matteo.food','chiara_design','andrea.music','valentina_home','lorenzo.photo','alessia_yoga','simone.store','francesca_hair','giovanni.wear','martina_nails','alessandro.cars','silvia_pets'];
  const bios = ['Digital creator','Handmade with love','Shop online','Lifestyle blogger','Founder @brand','Personal trainer','Travel addict','Food lover','Photographer','Designer'];
  const emails = [null, null, 'info@example.com', 'shop@mail.it', null, 'hello@brand.com', null, null, 'contact@me.it', null];

  let found = 0;
  const leads = [];
  $('btn-run').disabled = true;
  $('btn-demo').disabled = true;
  $('progress').hidden = false;
  $('progress-fill').classList.add('active');
  $('stats').hidden = true;
  $('leads-table').hidden = true;
  $('results-empty').hidden = true;

  const interval = setInterval(() => {
    const batch = Math.min(Math.floor(Math.random() * 8) + 3, maxLeads - found);
    found += batch;
    for (let i = 0; i < batch; i++) {
      const idx = leads.length;
      leads.push({
        username: names[idx % names.length] + (idx >= names.length ? idx : ''),
        profile_url: `https://instagram.com/${names[idx % names.length]}`,
        full_name: null,
        bio: bios[idx % bios.length],
        email: emails[idx % emails.length],
        followers: Math.floor(Math.random() * 45000) + 500,
        is_private: Math.random() < 0.25,
        is_business: Math.random() < 0.4,
        enriched: true,
        is_verified: Math.random() < 0.05,
        source: 'followers',
      });
    }

    const pct = Math.min(Math.round((found / maxLeads) * 100), 100);
    $('progress-fill').style.width = `${pct}%`;
    $('progress-msg').textContent = `Fase 1 — Scarico follower...`;
    $('progress-count').textContent = `${Math.min(found, maxLeads)} / ${maxLeads} lead`;

    if (found >= maxLeads) {
      clearInterval(interval);
      $('progress-fill').classList.remove('active');
      $('progress-msg').textContent = `Demo completata`;
      $('progress-count').textContent = `${maxLeads} lead trovati`;
      $('btn-run').disabled = false;
      $('btn-demo').disabled = false;

      const display = leads.slice(0, maxLeads);
      const withEmail = display.filter(l => l.email).length;
      $('stats').hidden = false;
      $('stats').innerHTML = `
        <div class="stat"><b>${nfmt(display.length)}</b><span>Lead totali</span></div>
        <div class="stat"><b>${nfmt(withEmail)}</b><span>Con email</span></div>`;

      const srcFollowers = $('src-followers').checked;
      const srcComments = $('src-comments').checked;
      const fonteLabel = srcFollowers && srcComments ? 'Follower e Commenti'
        : srcComments ? 'Commenti' : 'Follower';

      $('leads-table').hidden = false;
      $('leads-body').innerHTML = display.map((l) => `
        <tr>
          <td>
            <a href="${esc(l.profile_url)}" target="_blank" rel="noopener">@${esc(l.username)}</a>
            ${l.is_verified ? ' ✓' : ''}
          </td>
          <td class="bio-cell">${esc((l.bio ?? '').slice(0, 110))}</td>
          <td>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : '<span class="muted">—</span>'}</td>
          <td>${nfmt(l.followers)}</td>
          <td>${l.is_private ? '<span class="tag tag--warn">Privato</span>' : '<span class="tag tag--good">Pubblico</span>'}</td>
          <td>${l.is_business
            ? '<span class="tag tag--good">Pagina</span>'
            : '<span class="tag tag--muted">Persona</span>'}</td>
          <td class="muted" style="font-size:11px">${esc(fonteLabel)}</td>
          <td><button class="btn-delete-lead" data-username="${esc(l.username)}" title="Rimuovi lead">&times;</button></td>
        </tr>`).join('');
    }
  }, 400);
}

// ---- listener --------------------------------------------------------------

$('handles').addEventListener('input', refreshHandlesPreview);
$('platform-row').addEventListener('change', onPlatformChange);
$('btn-run').addEventListener('click', run);
$('btn-demo').addEventListener('click', runDemo);
$('job-dropdown-btn').addEventListener('click', toggleDropdown);
$('job-list').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('.dropdown__item-delete');
  if (delBtn) {
    e.stopPropagation();
    const id = delBtn.dataset.id;
    await api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
    if (currentJobId === id) { currentJobId = null; $('job-dropdown-label').textContent = '— nessun job —'; }
    await loadJobList();
    return;
  }
  const item = e.target.closest('.dropdown__item');
  if (!item) return;
  selectJob(item.dataset.id);
  loadJobList();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#job-dropdown')) closeDropdown();
});
$('btn-csv').addEventListener('click', () => { window.location = `/api/jobs/${currentJobId}/export.csv`; });
$('btn-cancel').addEventListener('click', async () => {
  await api(`/api/jobs/${currentJobId}/cancel`, { method: 'POST' }).catch(() => {});
  poll();
});

$('btn-save-crm').addEventListener('click', async () => {
  if (!currentJobId) return;
  $('btn-save-crm').disabled = true;
  $('btn-save-crm').textContent = 'Salvataggio...';
  try {
    const res = await api(`/api/crm/import/${currentJobId}`, { method: 'POST' });
    $('btn-save-crm').textContent = `${res.imported} salvati, ${res.duplicates} duplicati`;
    setTimeout(() => { $('btn-save-crm').textContent = 'Salva nel CRM'; $('btn-save-crm').disabled = false; }, 3000);
  } catch (err) {
    $('btn-save-crm').textContent = 'Errore';
    setTimeout(() => { $('btn-save-crm').textContent = 'Salva nel CRM'; $('btn-save-crm').disabled = false; }, 2000);
  }
});

$('btn-save-token').addEventListener('click', saveToken);
$('apify-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });

$('leads-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('.btn-delete-lead');
  if (!btn) return;
  const row = btn.closest('tr');
  if (currentJobId) {
    await api(`/api/jobs/${currentJobId}/leads/${encodeURIComponent(btn.dataset.username)}`, { method: 'DELETE' }).catch(() => {});
  }
  row.remove();
});

// ---- archive import ---------------------------------------------------------

const archivePicker = $('archive-picker');
const archiveList = $('archive-list');
const platformLabelsMap = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };

$('btn-import-archive').addEventListener('click', async () => {
  if (!archivePicker.hidden) { archivePicker.hidden = true; return; }
  const platform = getPlatform();
  try {
    const data = await api('/api/profiles');
    const filtered = data.profiles.filter(p => p.platform === platform);
    if (!filtered.length) {
      archiveList.innerHTML = `<div class="archive-picker__empty">Nessun profilo ${esc(platformLabelsMap[platform])} nell'archivio.</div>`;
    } else {
      const existing = getHandles().map(h => h.toLowerCase().replace(/^@/, ''));
      archiveList.innerHTML = filtered.map(p => {
        const already = existing.some(e => e === p.username.toLowerCase() || e.includes(p.username.toLowerCase()));
        return `<div class="archive-picker__item" data-username="${esc(p.username)}" data-url="${esc(p.profile_url || '')}">
          <span class="tag tag--muted">${esc(platformLabelsMap[p.platform])}</span>
          <span class="archive-picker__name">@${esc(p.username)}</span>
          ${p.notes ? `<span class="archive-picker__notes">${esc(p.notes)}</span>` : ''}
          <button class="btn btn--primary btn--sm archive-add-btn" ${already ? 'disabled' : ''}>${already ? 'Aggiunto' : 'Aggiungi'}</button>
        </div>`;
      }).join('');
    }
    archivePicker.hidden = false;
  } catch { archivePicker.hidden = true; }
});

archiveList.addEventListener('click', (e) => {
  const btn = e.target.closest('.archive-add-btn');
  if (!btn || btn.disabled) return;
  const item = btn.closest('.archive-picker__item');
  const username = item.dataset.username;
  const url = item.dataset.url;
  const platform = getPlatform();
  const value = url && platform === 'facebook' ? url : username;
  const textarea = $('handles');
  textarea.value = textarea.value.trim() ? textarea.value.trim() + '\n' + value : value;
  refreshHandlesPreview();
  btn.disabled = true;
  btn.textContent = 'Aggiunto';
});

// ---- pre-fill from query params (link from profili) -------------------------

(function () {
  const params = new URLSearchParams(window.location.search);
  const profile = params.get('profile');
  const platform = params.get('platform');
  if (platform) {
    const radio = document.querySelector(`input[name=platform][value="${platform}"]`);
    if (radio) radio.checked = true;
  }
  if (profile) {
    const textarea = $('handles');
    textarea.value = textarea.value.trim() ? textarea.value.trim() + '\n' + profile : profile;
  }
  if (profile || platform) {
    history.replaceState(null, '', window.location.pathname);
  }
})();

loadConfig();
loadJobList();
onPlatformChange();
