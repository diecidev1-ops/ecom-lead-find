const $ = (id) => document.getElementById(id);

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfmt = (n) => (n == null ? '—' : Intl.NumberFormat('it-IT').format(n));

let members = [];
let currentJobId = null;

// ---- Source toggles ----
$('tg-src-members').addEventListener('change', updateSourceUI);
$('tg-src-messages').addEventListener('change', updateSourceUI);

function updateSourceUI() {
  const mem = $('tg-src-members').checked;
  const msg = $('tg-src-messages').checked;
  $('tg-members-limit-row').hidden = !mem;
  $('tg-messages-limit-row').hidden = !msg;
  $('tg-deep-wrap').hidden = !mem;
}

// ---- Job dropdown ----
function toggleDropdown() {
  const dd = $('tg-job-dropdown');
  const menu = $('tg-job-menu');
  const isOpen = !menu.hidden;
  menu.hidden = isOpen;
  dd.classList.toggle('open', !isOpen);
}

$('tg-job-btn').addEventListener('click', () => { toggleDropdown(); if (!$('tg-job-menu').hidden) loadJobList(); });
document.addEventListener('click', (e) => {
  if (!$('tg-job-dropdown').contains(e.target)) {
    $('tg-job-menu').hidden = true;
    $('tg-job-dropdown').classList.remove('open');
  }
});

async function loadJobList() {
  try {
    const jobs = await api('/api/telegram/jobs');
    const list = $('tg-job-list');
    if (!jobs.length) {
      list.innerHTML = '<div class="dropdown__empty">Nessun job precedente</div>';
      return;
    }
    list.innerHTML = jobs.map(j => {
      const when = new Date(j.created_at).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const group = j.params?.groupUrl ?? '?';
      const mode = j.params?.mode === 'messages' ? 'msg' : 'membri';
      const statusClass = j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : 'running';
      const count = j.stats?.members != null ? ` · ${j.stats.members} lead` : '';
      return `<div class="dropdown__item ${j.id === currentJobId ? 'active' : ''}" data-id="${j.id}">
        <div class="dropdown__item-main">${esc(mode)} · ${esc(group.replace('https://t.me/', '@'))}${count}</div>
        <div class="dropdown__item-meta">
          <span class="dropdown__item-status dropdown__item-status--${statusClass}"></span>
          <span>${esc(j.status)}</span>
          <span>${when}</span>
        </div>
        <button class="dropdown__item-delete" data-id="${j.id}" title="Elimina">&times;</button>
      </div>`;
    }).join('');
  } catch {}
}

$('tg-job-list').addEventListener('click', async (e) => {
  const del = e.target.closest('.dropdown__item-delete');
  if (del) {
    e.stopPropagation();
    await api(`/api/telegram/jobs/${del.dataset.id}`, { method: 'DELETE' }).catch(() => {});
    if (del.dataset.id === currentJobId) { currentJobId = null; members = []; renderMembers(); }
    loadJobList();
    return;
  }
  const item = e.target.closest('.dropdown__item');
  if (!item) return;
  currentJobId = item.dataset.id;
  toggleDropdown();
  updateDropdownLabel();
  loadJobResults(currentJobId);
});

function updateDropdownLabel() {
  if (!currentJobId) { $('tg-job-label').textContent = '— nessun job —'; return; }
}

async function loadJobResults(jobId) {
  const job = await api(`/api/telegram/status/${jobId}`).catch(() => null);
  if (!job || job.error === 'Job non trovato') return;
  if (job.status === 'done') {
    members = job.members ?? [];
    renderMembers();
  }
}

// ---- Token check ----
async function checkToken() {
  try {
    const { apify } = await api('/api/config');
    const el = $('apify-status');
    if (apify.ok) { el.className = 'status status--ok'; el.textContent = `Apify: ${apify.username}`; }
    else { el.className = 'status status--err'; el.textContent = apify.error ?? 'Token mancante'; }
  } catch { $('apify-status').className = 'status status--err'; $('apify-status').textContent = 'Errore connessione'; }
}

// ---- UI helpers ----
function showError(msg) { $('tg-error').hidden = false; $('tg-error').textContent = msg; }

function setProgress(pct, msg) {
  $('tg-progress').hidden = false;
  $('tg-progress-fill').style.width = pct + '%';
  $('tg-progress-msg').textContent = msg;
  $('tg-progress-count').textContent = '';
}

function renderMembers() {
  $('tg-empty').hidden = members.length > 0;
  $('tg-table').hidden = members.length === 0;
  $('btn-tg-save-crm').disabled = members.length === 0;
  $('btn-tg-csv').disabled = members.length === 0;

  $('tg-stats').hidden = members.length === 0;
  if (members.length) {
    const withUser = members.filter(m => m.username).length;
    const withPhone = members.filter(m => m.phone).length;
    const premium = members.filter(m => m.is_premium).length;
    const totalMsg = members.reduce((s, m) => s + (m.message_count || 0), 0);

    let html = `<div class="stat"><b>${nfmt(members.length)}</b><span>Lead totali</span></div>`;
    html += `<div class="stat"><b>${nfmt(withUser)}</b><span>Con username</span></div>`;
    if (totalMsg > 0) {
      html += `<div class="stat"><b>${nfmt(totalMsg)}</b><span>Messaggi analizzati</span></div>`;
    }
    if (withPhone > 0) {
      html += `<div class="stat"><b>${nfmt(withPhone)}</b><span>Con telefono</span></div>`;
    }
    if (premium > 0) {
      html += `<div class="stat"><b>${nfmt(premium)}</b><span>Premium</span></div>`;
    }
    $('tg-stats').innerHTML = html;
  }

  $('tg-body').innerHTML = members.map((m, i) => `<tr>
    <td>${m.username ? `<a href="https://t.me/${esc(m.username)}" target="_blank" rel="noopener">@${esc(m.username)}</a>` : '<span class="muted">—</span>'}</td>
    <td>${esc(m.full_name || '—')}${m.is_verified ? ' ✓' : ''}</td>
    <td>${esc(m.phone || '—')}</td>
    <td>${m.is_premium ? '<span class="tag tag--good">Premium</span>' : '<span class="muted">—</span>'}</td>
    <td>${m.message_count ? `<span class="tag">${m.message_count}</span>` : '<span class="muted">—</span>'}</td>
    <td class="muted" style="font-size:11px">${esc(m.telegram_id || '—')}</td>
    <td><button class="btn-delete-lead" data-idx="${i}" title="Rimuovi">&times;</button></td>
  </tr>`).join('');
}

$('tg-body').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-delete-lead');
  if (!btn) return;
  members.splice(Number(btn.dataset.idx), 1);
  renderMembers();
});

// ---- Extraction ----
async function pollJob(jobId, progressOffset, progressRange, stepLabel) {
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    const job = await api(`/api/telegram/status/${jobId}`);
    const localPct = job.progress ?? 50;
    const globalPct = Math.round(progressOffset + (localPct / 100) * progressRange);
    setProgress(globalPct, stepLabel + ': ' + (job.message ?? 'in corso...'));
    if (job.status === 'done') return job.members;
    if (job.status === 'error') throw new Error(job.error ?? 'Errore sconosciuto');
  }
}

$('btn-tg-run').addEventListener('click', async () => {
  const raw = $('tg-group-url').value.trim();
  $('tg-error').hidden = true;
  if (!raw) return showError('Inserisci un gruppo Telegram.');

  const srcMembers = $('tg-src-members').checked;
  const srcMessages = $('tg-src-messages').checked;
  if (!srcMembers && !srcMessages) return showError('Seleziona almeno una fonte.');

  const btn = $('btn-tg-run');
  btn.disabled = true;
  btn.textContent = 'Estrazione...';
  members = [];
  renderMembers();

  const steps = [];
  if (srcMembers) steps.push('members');
  if (srcMessages) steps.push('messages');
  const stepWeight = 100 / steps.length;
  let allMembers = [];

  try {
    let stepIdx = 0;

    if (srcMembers) {
      const maxResults = Math.max(100, Math.min(Number($('tg-max-results').value) || 500, 10000));
      const deepSearch = $('tg-deep-search').checked;
      const offset = stepIdx * stepWeight;
      setProgress(offset + 2, 'Lista membri: avvio...');
      const { jobId } = await api('/api/telegram/extract', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupUrl: raw, maxResults, deepSearch }),
      });
      currentJobId = jobId;
      updateDropdownLabel();
      const result = await pollJob(jobId, offset, stepWeight, 'Lista membri');
      allMembers.push(...result);
      stepIdx++;
    }

    if (srcMessages) {
      const maxMessages = Math.max(50, Math.min(Number($('tg-max-messages')?.value) || 200, 5000));
      const offset = stepIdx * stepWeight;
      setProgress(offset + 2, 'Autori messaggi: avvio...');
      const { jobId } = await api('/api/telegram/extract-messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupUrl: raw, maxResults: maxMessages }),
      });
      if (!currentJobId) { currentJobId = jobId; updateDropdownLabel(); }
      const result = await pollJob(jobId, offset, stepWeight, 'Autori messaggi');
      allMembers.push(...result);
      stepIdx++;
    }

    // Merge & dedup
    const merged = new Map();
    for (const m of allMembers) {
      const key = m.username?.toLowerCase() || m.telegram_id || m.full_name?.toLowerCase() || Math.random().toString();
      if (merged.has(key)) {
        const ex = merged.get(key);
        ex.message_count = (ex.message_count || 0) + (m.message_count || 0);
        if (!ex.phone && m.phone) ex.phone = m.phone;
        if (!ex.username && m.username) ex.username = m.username;
        if (!ex.full_name && m.full_name) ex.full_name = m.full_name;
        if (m.is_premium) ex.is_premium = true;
        if (m.is_verified) ex.is_verified = true;
        if (!ex.telegram_id && m.telegram_id) ex.telegram_id = m.telegram_id;
        if (m.last_seen && (!ex.last_seen || m.last_seen > ex.last_seen)) ex.last_seen = m.last_seen;
      } else {
        merged.set(key, { ...m });
      }
    }
    members = [...merged.values()].sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
    setProgress(100, `Completato: ${members.length} lead trovati.`);
    setTimeout(() => { $('tg-progress').hidden = true; }, 1200);
    renderMembers();
    loadJobList();

  } catch (err) {
    $('tg-progress').hidden = true;
    showError('Errore: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Avvia estrazione';
  }
});

// ---- Save & Export ----
$('btn-tg-save-crm').addEventListener('click', async () => {
  if (!members.length) return;
  const btn = $('btn-tg-save-crm');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Salvataggio...';
  try {
    const data = await api('/api/telegram/save-crm', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ members }),
    });
    btn.textContent = `${data.saved} salvati` + (data.duplicates ? ` · ${data.duplicates} duplicati` : '');
  } catch (err) { showError('Errore salvataggio: ' + err.message); btn.textContent = orig; }
  finally { setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000); }
});

$('btn-tg-csv').addEventListener('click', () => {
  const cols = ['username', 'full_name', 'phone', 'telegram_id', 'is_premium', 'is_verified', 'message_count', 'last_seen'];
  const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const csv = [cols.join(','), ...members.map(m => cols.map(c => cell(m[c])).join(','))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'telegram-lead.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- Init ----
checkToken();
updateSourceUI();
renderMembers();
loadJobList();
