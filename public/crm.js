const $ = (id) => document.getElementById(id);

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data });
  return data;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfmt = (n) => (n == null ? '—' : Intl.NumberFormat('it-IT').format(n));

const platformLabels = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook' };
const platformUrls = {
  instagram: u => `https://www.instagram.com/${u}/`,
  tiktok: u => `https://www.tiktok.com/@${u}`,
  facebook: u => `https://www.facebook.com/${u}`,
};
const statusOptions = ['nuovo', 'da contattare', 'contattato', 'interessato', 'cliente', 'scartato'];
const statusLabels = { nuovo:'Nuovo', 'da contattare':'Da contattare', contattato:'Contattato', interessato:'Interessato', cliente:'Cliente', scartato:'Scartato' };
const genderOptions = ['', 'M', 'F', 'Altro'];
const economicOptions = ['', 'basso', 'medio', 'medio-alto', 'alto', 'luxury'];

function formatAnalysis(text) {
  if (!text) return '<span style="color:var(--muted)">Nessuna analisi</span>';
  try {
    const d = JSON.parse(text);
    if (d.grade || d.score != null) return renderAiReport(d);
  } catch {}
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
}

function scoreBar(score) {
  if (score == null || score === 0) return '<span class="dp-val">—</span>';
  const s = Number(score);
  const cls = s >= 70 ? 'high' : s >= 40 ? 'mid' : 'low';
  return `<div class="score-bar"><div class="score-bar__fill score-bar--${cls}" style="width:${s}%"></div><span class="score-bar__label">${s}/100</span></div>`;
}

function renderAiReport(d) {
  const score = d.score ?? 0;
  const grade = d.grade || (score >= 90 ? 'S' : score >= 75 ? 'A' : score >= 55 ? 'B' : score >= 35 ? 'C' : 'D');
  const stars = score >= 90 ? 5 : score >= 70 ? 4 : score >= 50 ? 3 : score >= 30 ? 2 : 1;
  const starStr = '★'.repeat(stars) + '☆'.repeat(5 - stars);
  const prioLabel = { alta: 'Alta priorità', media: 'Media priorità', bassa: 'Bassa priorità' };
  const bdLabels = {
    profile_quality: 'Qualità profilo', professionalism: 'Professionalità', completeness: 'Completezza',
    brand_fit: 'Brand Fit', commercial_potential: 'Potenziale comm.', reliability: 'Affidabilità',
    engagement: 'Engagement', bio_quality: 'Qualità Bio', niche: 'Niche', credibility: 'Credibilità'
  };

  let h = '<div class="ai-report">';

  // Hero
  h += `<div class="ai-hero">
    <div class="ai-hero__grade ai-grade--${grade}">${grade}</div>
    <div class="ai-hero__info">
      <div class="ai-hero__score">${score}<span>/100</span></div>
      <div class="ai-hero__stars">${starStr}</div>
      ${d.priority ? `<div class="ai-hero__prio ai-prio--${d.priority}">${prioLabel[d.priority] || d.priority}</div>` : ''}
    </div>
    <div class="ai-hero__probs">
      <div class="ai-prob"><span class="ai-prob__val">${d.response_probability ?? '—'}%</span><span class="ai-prob__lbl">Risposta</span></div>
      <div class="ai-prob"><span class="ai-prob__val">${d.conversion_probability ?? '—'}%</span><span class="ai-prob__lbl">Conversione</span></div>
      <div class="ai-prob"><span class="ai-prob__val">${d.confidence ?? '—'}%</span><span class="ai-prob__lbl">Affidabilità</span></div>
    </div>
  </div>`;

  // Summary
  if (d.summary) h += `<div class="ai-summary">${esc(d.summary)}</div>`;

  // Come è stata dedotta l'età (rende la stima verificabile)
  if (d.age_basis || d.estimated_age) {
    const conf = d.age_confidence;
    const cCls = conf == null ? 'mid' : conf >= 70 ? 'high' : conf >= 40 ? 'mid' : 'low';
    h += `<div class="ai-agebox">
      <span class="ai-agebox__val">${d.estimated_age ? esc(d.estimated_age) + ' anni' : 'Età non determinata'}</span>
      ${d.age_basis ? `<span class="ai-agebox__basis">${esc(d.age_basis)}</span>` : ''}
      ${conf != null ? `<span class="ai-agebox__conf ai-agebox__conf--${cCls}">${conf}%</span>` : ''}
    </div>`;
  }

  // Breakdown
  if (d.breakdown) {
    h += '<div class="ai-sect"><div class="ai-sect__title">Score Breakdown</div><div class="ai-breakdown">';
    for (const [k, lbl] of Object.entries(bdLabels)) {
      const v = d.breakdown[k] ?? 0;
      const c = v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low';
      h += `<div class="ai-bar"><span class="ai-bar__lbl">${lbl}</span><div class="ai-bar__track"><div class="ai-bar__fill ai-bar--${c}" style="width:${v}%"></div></div><span class="ai-bar__val">${v}</span></div>`;
    }
    h += '</div></div>';
  }

  // Strengths + Weaknesses
  if (d.strengths?.length || d.weaknesses?.length) {
    h += '<div class="ai-cards">';
    if (d.strengths?.length) h += `<div class="ai-card ai-card--str"><div class="ai-card__hd">Punti di forza</div><ul>${d.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
    if (d.weaknesses?.length) h += `<div class="ai-card ai-card--weak"><div class="ai-card__hd">Criticità</div><ul>${d.weaknesses.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    h += '</div>';
  }

  // Why interesting
  if (d.why_interesting) h += `<div class="ai-sect"><div class="ai-sect__title">Perché questo lead è interessante</div><p class="ai-text">${esc(d.why_interesting)}</p></div>`;

  // Strategy
  if (d.contact_strategy) {
    const cs = d.contact_strategy;
    h += '<div class="ai-sect"><div class="ai-sect__title">Strategia di contatto</div><div class="ai-strat">';
    if (cs.approach) h += `<div class="ai-strat__row"><span class="ai-strat__k">Approccio</span><span>${esc(cs.approach)}</span></div>`;
    if (cs.tone) h += `<div class="ai-strat__row"><span class="ai-strat__k">Tono</span><span>${esc(cs.tone)}</span></div>`;
    if (cs.opening_topic) h += `<div class="ai-strat__row"><span class="ai-strat__k">Tema iniziale</span><span>${esc(cs.opening_topic)}</span></div>`;
    if (cs.errors_to_avoid) h += `<div class="ai-strat__row"><span class="ai-strat__k">Da evitare</span><span>${esc(cs.errors_to_avoid)}</span></div>`;
    h += '</div></div>';
  }

  // Brands
  if (d.compatible_brands?.length) {
    h += `<div class="ai-sect"><div class="ai-sect__title">Brand compatibili</div><div class="ai-brands">${d.compatible_brands.map(b => `<span class="ai-brand">${esc(b)}</span>`).join('')}</div></div>`;
  }

  // Score motivation
  if (d.score_motivation) {
    const sm = d.score_motivation;
    h += '<div class="ai-sect"><div class="ai-sect__title">Motivazione dello score</div><div class="ai-motiv">';
    if (sm.positives?.length) h += `<div class="ai-motiv__col ai-motiv--pos">${sm.positives.map(p => `<div class="ai-motiv__item">${esc(p)}</div>`).join('')}</div>`;
    if (sm.negatives?.length) h += `<div class="ai-motiv__col ai-motiv--neg">${sm.negatives.map(n => `<div class="ai-motiv__item">${esc(n)}</div>`).join('')}</div>`;
    h += '</div></div>';
  }

  h += '</div>';
  return h;
}

function toast(msg, type = 'ok') {
  const wrap = $('toast-wrap');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.animation = 'toastOut .2s ease forwards'; setTimeout(() => el.remove(), 200); }, 2800);
}

function initials(name) {
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ─── State ───
let leadsData = [];
let activeTab = 'tutti';
let currentPage = 1;
let perPage = 50;
let selectedIds = new Set();

// ─── Filters ───
function getFilters() {
  const v = (id) => $(id)?.value?.trim() ?? '';
  const search = ($('crm-global-search')?.value?.trim() ?? '').toLowerCase();
  return {
    search,
    platform: v('f-platform'),
    status: v('f-status'),
    gender: v('f-gender'),
    economic: v('f-economic'),
    visibility: v('f-visibility'),
    type: v('f-type'),
    email: v('f-email'),
    country: v('f-country').toLowerCase(),
    language: v('f-language').toLowerCase(),
    profession: v('f-profession').toLowerCase(),
    interests: v('f-interests').toLowerCase(),
    followersMin: Number(v('f-followers-min')) || 0,
    followersMax: Number(v('f-followers-max')) || Infinity,
    scoreMin: Number(v('f-score-min')) || 0,
  };
}

function matchesFilters(l, f) {
  if (f.search && !(
    (l.username ?? '').toLowerCase().includes(f.search) ||
    (l.full_name ?? '').toLowerCase().includes(f.search) ||
    (l.bio ?? '').toLowerCase().includes(f.search) ||
    (l.email ?? '').toLowerCase().includes(f.search)
  )) return false;
  if (f.platform && l.platform !== f.platform) return false;
  if (f.status && (l.status ?? 'nuovo') !== f.status) return false;
  if (f.gender && (l.gender ?? '') !== f.gender) return false;
  if (f.economic && (l.economic_level ?? '') !== f.economic) return false;
  if (f.visibility === 'public' && l.is_private) return false;
  if (f.visibility === 'private' && !l.is_private) return false;
  if (f.type === 'business' && !l.is_business) return false;
  if (f.type === 'personal' && l.is_business) return false;
  if (f.email === 'yes' && !l.email) return false;
  if (f.email === 'no' && l.email) return false;
  if (f.country && !(l.country ?? '').toLowerCase().includes(f.country)) return false;
  if (f.language && !(l.language ?? '').toLowerCase().includes(f.language)) return false;
  if (f.profession && !(l.profession ?? '').toLowerCase().includes(f.profession)) return false;
  if (f.interests && !(l.interests ?? '').toLowerCase().includes(f.interests)) return false;
  if ((l.followers ?? 0) < f.followersMin) return false;
  if ((l.followers ?? 0) > f.followersMax) return false;
  if ((l.score ?? 0) < f.scoreMin) return false;
  return true;
}

function tabFilter(l) {
  if (activeTab === 'tutti') return true;
  return (l.status ?? 'nuovo') === activeTab;
}

// ─── KPI ───
function updateKpi() {
  const counts = { tutti: leadsData.length };
  statusOptions.forEach(s => { counts[s] = 0; });
  leadsData.forEach(l => { counts[(l.status ?? 'nuovo')]++; });
  $('kpi-tutti').textContent = nfmt(counts.tutti);
  $('kpi-nuovo').textContent = nfmt(counts.nuovo);
  $('kpi-da_contattare').textContent = nfmt(counts['da contattare']);
  $('kpi-contattato').textContent = nfmt(counts.contattato);
  $('kpi-interessato').textContent = nfmt(counts.interessato);
  $('kpi-cliente').textContent = nfmt(counts.cliente);
  $('kpi-scartato').textContent = nfmt(counts.scartato);
}

function sparkPath(data, w, h) {
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`);
  return pts.join(' ');
}

let kpiDays = 7;
const kpiTfLabels = { 1: '24h', 7: '7gg', 14: '14gg', 30: '30gg' };

function renderKpiCards(cards) {
  const suffix = kpiTfLabels[kpiDays] || `${kpiDays}gg`;
  cards.forEach(c => {
    const el = $(`kpi-${c.key}`);
    if (el) el.textContent = nfmt(c.count);

    const deltaEl = $(`kpi-delta-${c.key}`);
    if (deltaEl) {
      if (c.pct === 0) {
        deltaEl.className = 'kpi-card__delta kpi-card__delta--flat';
        deltaEl.textContent = `— ${suffix}`;
      } else {
        const cls = c.pct > 0 ? 'up' : 'down';
        deltaEl.className = `kpi-card__delta kpi-card__delta--${cls}`;
        deltaEl.textContent = (c.pct > 0 ? '▲ +' : '▼ ') + c.pct + '% ' + suffix;
      }
      deltaEl.title = `${c.cur} negli ultimi ${suffix} vs ${c.prev} nel periodo precedente`;
    }

    const svg = $(`kpi-spark-${c.key}`);
    if (svg && c.spark) {
      const pts = sparkPath(c.spark, 80, 28);
      svg.innerHTML = `<polygon class="spark-area" points="0,28 ${pts} 80,28"/><polyline points="${pts}"/>`;
    }
  });
}

async function loadKpi() {
  try {
    const cards = await api('/api/crm/kpi?days=' + kpiDays);
    renderKpiCards(cards);
  } catch {}
}

// ─── KPI timeframe ───
$('kpi-tf').addEventListener('click', (e) => {
  const pill = e.target.closest('.kpi-tf__pill');
  if (!pill) return;
  kpiDays = Number(pill.dataset.days);
  document.querySelectorAll('.kpi-tf__pill').forEach(p => p.classList.toggle('active', p === pill));
  loadKpi();
});

// ─── Table rendering ───
function getProfileUrl(l) {
  return l.profile_url || platformUrls[l.platform]?.(l.username) || '#';
}

function buildRow(l) {
  const st = l.status ?? 'nuovo';
  const stClass = st.replace(/ /g, '_');
  const checked = selectedIds.has(String(l.id)) ? 'checked' : '';
  const selClass = selectedIds.has(String(l.id)) ? ' selected' : '';
  const ini = initials(l.full_name || l.username);
  const avatar = l.profile_pic_url
    ? `<img class="td-account__avatar" src="${esc(l.profile_pic_url)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'td-account__avatar--ph',textContent:'${ini}'}))">`
    : `<div class="td-account__avatar--ph">${ini}</div>`;
  const profileUrl = getProfileUrl(l);
  const date = l.added_at ? new Date(l.added_at).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';

  return `<tr class="crm-row${selClass}" data-id="${l.id}">
    <td><input type="checkbox" class="crm-check row-check" data-id="${l.id}" ${checked} onclick="event.stopPropagation()"></td>
    <td><div class="td-account">${avatar}<div class="td-account__info"><div class="td-account__name">${esc(l.full_name || l.username)}${l.is_verified ? ' <span style="color:var(--accent)">✓</span>' : ''}</div><div class="td-account__sub"><a href="${esc(profileUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">@${esc(l.username)}</a></div></div></div></td>
    <td><span class="plat-badge plat-badge--${esc(l.platform)}">${esc(platformLabels[l.platform] ?? l.platform)}</span></td>
    <td class="td-email">${l.email ? `<a href="mailto:${esc(l.email)}" onclick="event.stopPropagation()" style="color:var(--accent);text-decoration:none">${esc(l.email)}</a>` : '<span style="color:var(--muted)">—</span>'}</td>
    <td>${nfmt(l.followers)}</td>
    <td>${l.is_business ? '<span class="plat-badge" style="background:rgba(34,197,94,.1);color:var(--good)">Pagina</span>' : (l.enriched ? '<span class="plat-badge" style="background:var(--input-bg);color:var(--muted)">Persona</span>' : '<span style="color:var(--muted)">—</span>')}</td>
    <td>${l.is_private ? '<span class="vis-badge vis-badge--private" title="Profilo privato">🔒 Privato</span>' : '<span class="vis-badge vis-badge--public" title="Profilo pubblico">🌐 Pubblico</span>'}</td>
    <td class="td-status"><div class="status-dd-wrap"><button class="status-pill status-pill--${stClass} status-pill--btn" data-id="${l.id}">${statusLabels[st] ?? st} ▾</button><div class="status-dd" hidden>${statusOptions.map(s => `<button class="status-dd__opt" data-status="${s}" data-id="${l.id}"><span class="status-dot status-dot--${s.replace(/ /g,'_')}"></span>${statusLabels[s]}</button>`).join('')}</div></div></td>
    <td class="td-actions"><button class="row-toggle" data-id="${l.id}" title="Dettagli">▾</button></td>
  </tr>
  <tr class="crm-detail-row" data-detail="${l.id}" hidden>
    <td colspan="9">
      <div class="detail-panel" data-lead-id="${l.id}">
        <div class="detail-panel__top">
          <div class="detail-panel__stats">
            <div class="dp-stat"><b>${nfmt(l.followers)}</b><span>Follower</span></div>
            <div class="dp-stat"><b>${nfmt(l.following)}</b><span>Seguiti</span></div>
            <div class="dp-stat"><b>${nfmt(l.posts_count)}</b><span>Post</span></div>
          </div>
          <div class="detail-panel__actions">
            <a href="${esc(profileUrl)}" target="_blank" rel="noopener" class="btn btn--ghost btn--sm" onclick="event.stopPropagation()">Apri profilo</a>
            <button class="btn btn--danger btn--sm detail-delete" data-id="${l.id}" onclick="event.stopPropagation()">Elimina</button>
          </div>
        </div>
        ${l.bio ? `<div class="dp-bio">${esc(l.bio)}</div>` : ''}
        <div class="dp-fields">
          <div class="dp-field"><label>Stato</label><select class="dp-input" data-field="status" data-id="${l.id}">${statusOptions.map(s => `<option value="${s}" ${st === s ? 'selected' : ''}>${statusLabels[s]}</option>`).join('')}</select></div>
          <div class="dp-field"><label>Età</label><input class="dp-input" data-field="estimated_age" data-id="${l.id}" value="${esc(l.estimated_age ?? '')}"></div>
          <div class="dp-field"><label>Sesso</label><select class="dp-input" data-field="gender" data-id="${l.id}">${genderOptions.map(g => `<option value="${g}" ${(l.gender ?? '') === g ? 'selected' : ''}>${g || '—'}</option>`).join('')}</select></div>
          <div class="dp-field"><label>Paese</label><input class="dp-input" data-field="country" data-id="${l.id}" value="${esc(l.country ?? '')}"></div>
          <div class="dp-field"><label>Lingua</label><input class="dp-input" data-field="language" data-id="${l.id}" value="${esc(l.language ?? '')}"></div>
          <div class="dp-field"><label>Professione</label><input class="dp-input" data-field="profession" data-id="${l.id}" value="${esc(l.profession ?? '')}"></div>
          <div class="dp-field"><label>Interessi</label><input class="dp-input" data-field="interests" data-id="${l.id}" value="${esc(l.interests ?? '')}"></div>
          <div class="dp-field"><label>Livello econ.</label><select class="dp-input" data-field="economic_level" data-id="${l.id}">${economicOptions.map(e => `<option value="${e}" ${(l.economic_level ?? '') === e ? 'selected' : ''}>${e ? e.charAt(0).toUpperCase() + e.slice(1) : '—'}</option>`).join('')}</select></div>
          <div class="dp-field dp-field--score"><label>Score</label>${scoreBar(l.score)}</div>
          <div class="dp-field"><label>Visibilità</label><span class="dp-val">${l.is_private ? 'Privato' : 'Pubblico'}</span></div>
          <div class="dp-field"><label>Data</label><span class="dp-val">${date}</span></div>
        </div>
        <div class="dp-section">
          <label>Note</label>
          <textarea class="dp-notes dp-input" data-field="notes" data-id="${l.id}" placeholder="Scrivi una nota...">${esc(l.notes ?? '')}</textarea>
        </div>
        <div class="dp-section dp-section--ai">
          <div class="dp-ai-header">
            <label>AI Lead Intelligence</label>
            <button class="btn btn--primary btn--sm btn-ai-analyze" data-id="${l.id}">${l.ai_analysis ? '↻ Ri-analizza' : '🤖 Analizza con AI'}</button>
          </div>
          <div class="dp-ai-result" id="ai-result-${l.id}">${formatAnalysis(l.ai_analysis)}</div>
        </div>
      </div>
    </td>
  </tr>`;
}

function render() {
  const f = getFilters();
  const filtered = leadsData.filter(l => tabFilter(l) && matchesFilters(l, f));
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * perPage;
  const page = filtered.slice(start, start + perPage);

  $('crm-body').innerHTML = page.map(buildRow).join('');

  $('crm-toolbar-info').textContent = filtered.length === leadsData.length
    ? `${filtered.length} lead`
    : `${filtered.length} di ${leadsData.length} lead`;

  $('page-info').textContent = `Pagina ${currentPage} di ${totalPages}`;
  $('btn-prev').disabled = currentPage <= 1;
  $('btn-next').disabled = currentPage >= totalPages;
  $('crm-pagination').hidden = filtered.length <= perPage;

  const nSel = page.filter(l => selectedIds.has(String(l.id))).length;
  $('check-all').checked = page.length > 0 && nSel === page.length;
  $('check-all').indeterminate = nSel > 0 && nSel < page.length;
  updateBulkBar();
  updateKpi();
}

function updateBulkBar() {
  const n = selectedIds.size;
  $('crm-bulk').hidden = n === 0;
  $('bulk-count').textContent = `${n} lead selezionati`;
}

// ─── Load ───
async function loadCrm() {
  $('crm-skeleton').hidden = false;
  $('crm-table-wrap').hidden = true;
  $('crm-empty').hidden = true;

  try {
    const { leads, counts } = await api('/api/crm/leads?limit=500');
    leadsData = leads;

    $('crm-skeleton').hidden = true;
    $('btn-csv-crm').disabled = counts.total === 0;
    $('crm-header-count').textContent = leads.length > 0 ? `(${nfmt(leads.length)})` : '';

    loadKpi();

    if (counts.total === 0) {
      $('crm-empty').hidden = false;
      $('crm-table-wrap').hidden = true;
      $('crm-toolbar').hidden = true;
    } else {
      $('crm-empty').hidden = true;
      $('crm-table-wrap').hidden = false;
      $('crm-toolbar').hidden = false;
      render();
    }
  } catch (err) {
    $('crm-skeleton').hidden = true;
    toast('Errore nel caricamento: ' + err.message, 'err');
  }
}

// ─── KPI tab click ───
$('crm-kpi').addEventListener('click', (e) => {
  const card = e.target.closest('.kpi-card');
  if (!card) return;
  document.querySelectorAll('.kpi-card').forEach(c => c.classList.remove('active'));
  card.classList.add('active');
  activeTab = card.dataset.tab;
  currentPage = 1;
  render();
});

// ─── Inline status dropdown ───
function closeStatusDDs() {
  document.querySelectorAll('.status-dd:not([hidden])').forEach(d => { d.hidden = true; });
}

$('crm-body').addEventListener('click', (e) => {
  const pill = e.target.closest('.status-pill--btn');
  if (pill) {
    e.stopPropagation();
    const dd = pill.nextElementSibling;
    const wasOpen = !dd.hidden;
    closeStatusDDs();
    if (!wasOpen) dd.hidden = false;
    return;
  }

  const opt = e.target.closest('.status-dd__opt');
  if (opt) {
    e.stopPropagation();
    const id = opt.dataset.id;
    const status = opt.dataset.status;
    const lead = leadsData.find(l => String(l.id) === id);
    if (lead) {
      lead.status = status;
      api(`/api/crm/leads/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }).catch(() => {});
      closeStatusDDs();
      render();
      toast(`Stato → ${statusLabels[status]}`);
    }
    return;
  }
});

document.addEventListener('click', () => closeStatusDDs());

// ─── Row detail toggle ───
$('crm-body').addEventListener('click', (e) => {
  if (e.target.closest('.row-check') || e.target.closest('a') || e.target.closest('.dp-input') || e.target.closest('.dp-notes') || e.target.closest('button') || e.target.closest('select')) return;
  const row = e.target.closest('.crm-row');
  if (row) toggleDetail(row.dataset.id);
});

$('crm-body').addEventListener('click', (e) => {
  const toggle = e.target.closest('.row-toggle');
  if (toggle) { e.stopPropagation(); toggleDetail(toggle.dataset.id); }
});

function toggleDetail(id) {
  const detail = document.querySelector(`tr[data-detail="${id}"]`);
  if (!detail) return;
  const wasOpen = !detail.hidden;
  document.querySelectorAll('.crm-detail-row:not([hidden])').forEach(r => { r.hidden = true; });
  if (!wasOpen) detail.hidden = false;
}

// ─── Detail panel: delete ───
$('crm-body').addEventListener('click', async (e) => {
  const del = e.target.closest('.detail-delete');
  if (!del) return;
  e.stopPropagation();
  const id = del.dataset.id;
  try {
    await api(`/api/crm/leads/${id}`, { method: 'DELETE' });
    leadsData = leadsData.filter(l => String(l.id) !== id);
    selectedIds.delete(id);
    render();
    toast('Lead eliminato');
  } catch (err) { toast('Errore: ' + err.message, 'err'); }
});

// ─── Detail panel: field autosave ───
let detailSaveTimer = null;
$('crm-body').addEventListener('input', (e) => {
  const input = e.target.closest('.dp-input[data-field]');
  if (!input) return;
  const id = input.dataset.id;
  const field = input.dataset.field;
  const value = input.value;
  const lead = leadsData.find(l => String(l.id) === id);
  if (lead) lead[field] = value;
  clearTimeout(detailSaveTimer);
  detailSaveTimer = setTimeout(() => {
    api(`/api/crm/leads/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field]: value }) }).catch(() => {});
  }, 500);
});

$('crm-body').addEventListener('change', (e) => {
  const sel = e.target.closest('select.dp-input[data-field]');
  if (!sel) return;
  const id = sel.dataset.id;
  const field = sel.dataset.field;
  const value = sel.value;
  const lead = leadsData.find(l => String(l.id) === id);
  if (lead) lead[field] = value;
  api(`/api/crm/leads/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [field]: value }) }).catch(() => {});
  if (field === 'status') render();
});

// ─── Detail panel: AI analyze ───
$('crm-body').addEventListener('click', async (e) => {
  const aiBtn = e.target.closest('.btn-ai-analyze');
  if (!aiBtn) return;
  e.stopPropagation();
  const id = aiBtn.dataset.id;
  const lead = leadsData.find(l => String(l.id) === id);
  const resultEl = document.getElementById(`ai-result-${id}`);
  aiBtn.disabled = true;
  aiBtn.textContent = 'Analisi in corso...';
  resultEl.innerHTML = '<div class="ai-loading"><div class="ai-loading__spinner"></div><span>Invio dati al modello AI...</span></div>';
  try {
    const data = await api(`/api/crm/leads/${id}/analyze`, { method: 'POST' });
    if (data.fields && lead) {
      Object.assign(lead, data.fields);
      lead.ai_analysis = data.analysis;
    }
    resultEl.innerHTML = formatAnalysis(data.analysis);
    aiBtn.textContent = 'Ri-analizza con AI';
    if (data.fields) {
      ['estimated_age','gender','country','language','profession','interests','economic_level','status'].forEach(f => {
        if (data.fields[f] == null) return;
        const inp = document.querySelector(`.dp-input[data-field="${f}"][data-id="${id}"]`);
        if (inp) inp.value = data.fields[f];
      });
      if (data.fields.score != null) {
        lead.score = data.fields.score;
        const parent = document.querySelector(`.detail-panel[data-lead-id="${id}"] .dp-field--score`);
        if (parent) { const lbl = parent.querySelector('label'); parent.innerHTML = ''; parent.appendChild(lbl); parent.insertAdjacentHTML('beforeend', scoreBar(lead.score)); }
      }
    }
    toast('Analisi AI completata');
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--danger)">Errore: ${esc(err.message)}</div>`;
    aiBtn.textContent = 'Riprova analisi';
    toast('Errore analisi AI', 'err');
  } finally { aiBtn.disabled = false; }
});

// ─── Checkbox selection ───
$('crm-body').addEventListener('change', (e) => {
  const cb = e.target.closest('.row-check');
  if (!cb) return;
  const id = cb.dataset.id;
  if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
  cb.closest('tr').classList.toggle('selected', cb.checked);
  const allChecks = [...$('crm-body').querySelectorAll('.row-check')];
  const nSel = allChecks.filter(c => c.checked).length;
  $('check-all').checked = allChecks.length > 0 && nSel === allChecks.length;
  $('check-all').indeterminate = nSel > 0 && nSel < allChecks.length;
  updateBulkBar();
});

$('check-all').addEventListener('change', (e) => {
  const checks = $('crm-body').querySelectorAll('.row-check');
  checks.forEach(c => {
    c.checked = e.target.checked;
    if (e.target.checked) selectedIds.add(c.dataset.id); else selectedIds.delete(c.dataset.id);
    c.closest('tr').classList.toggle('selected', e.target.checked);
  });
  e.target.indeterminate = false;
  updateBulkBar();
});

// ─── Bulk actions ───
$('bulk-deselect-btn').addEventListener('click', () => {
  selectedIds.clear();
  $('crm-body').querySelectorAll('.row-check').forEach(c => { c.checked = false; c.closest('tr').classList.remove('selected'); });
  $('check-all').checked = false;
  $('check-all').indeterminate = false;
  updateBulkBar();
});

$('bulk-delete-btn').addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  for (const id of ids) {
    api(`/api/crm/leads/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  leadsData = leadsData.filter(l => !selectedIds.has(String(l.id)));
  selectedIds.clear();
  render();
  toast(`${ids.length} lead eliminati`);
});

$('bulk-status-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  let dd = document.querySelector('.bulk-dd');
  if (dd) { dd.remove(); return; }
  dd = document.createElement('div');
  dd.className = 'bulk-dd';
  statusOptions.forEach(s => {
    const b = document.createElement('button');
    b.textContent = statusLabels[s];
    b.addEventListener('click', async () => {
      dd.remove();
      const ids = [...selectedIds];
      for (const id of ids) {
        const lead = leadsData.find(l => String(l.id) === id);
        if (lead) lead.status = s;
        api(`/api/crm/leads/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: s }),
        }).catch(() => {});
      }
      selectedIds.clear();
      render();
      toast(`Stato aggiornato per ${ids.length} lead`);
    });
    dd.appendChild(b);
  });
  $('bulk-status-btn').appendChild(dd);
});

document.addEventListener('click', () => { document.querySelectorAll('.bulk-dd').forEach(d => d.remove()); });

// ─── Pagination ───
$('btn-prev').addEventListener('click', () => { if (currentPage > 1) { currentPage--; render(); } });
$('btn-next').addEventListener('click', () => { currentPage++; render(); });
$('crm-per-page').addEventListener('change', (e) => { perPage = Number(e.target.value); currentPage = 1; render(); });

// ─── Search + Filters ───
let searchTimer = null;
$('crm-global-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage = 1; render(); }, 200);
});

$('btn-toggle-filters').addEventListener('click', () => {
  const fp = $('crm-filters');
  fp.hidden = !fp.hidden;
  $('btn-toggle-filters').classList.toggle('active', !fp.hidden);
});

$('btn-reset-filters').addEventListener('click', () => {
  ['f-country', 'f-language', 'f-profession', 'f-interests', 'f-followers-min', 'f-followers-max', 'f-score-min'].forEach(id => { if ($(id)) $(id).value = ''; });
  ['f-platform', 'f-status', 'f-gender', 'f-economic', 'f-visibility', 'f-type', 'f-email'].forEach(id => { if ($(id)) $(id).value = ''; });
  currentPage = 1;
  render();
  toast('Filtri resettati');
});

let filterTimer = null;
$('crm-filters').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => { currentPage = 1; render(); }, 200); });
$('crm-filters').addEventListener('change', () => { currentPage = 1; render(); });

// ─── CSV ───
$('btn-csv-crm').addEventListener('click', () => { window.location = '/api/crm/export.csv'; });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.crm-detail-row:not([hidden])').forEach(r => { r.hidden = true; });
    closeModal();
  }
});

// ─── Add lead modal ───
function openModal() {
  const m = $('add-modal');
  const o = $('modal-overlay');
  m.hidden = false;
  o.hidden = false;
  setTimeout(() => { m.classList.add('vis'); o.classList.add('vis'); }, 20);
  $('add-crm-username').focus();
}

function closeModal() {
  const m = $('add-modal');
  const o = $('modal-overlay');
  m.classList.remove('vis');
  o.classList.remove('vis');
  setTimeout(() => { m.hidden = true; o.hidden = true; }, 180);
}

$('btn-open-add-modal').addEventListener('click', openModal);
$('btn-empty-add').addEventListener('click', openModal);
$('modal-close').addEventListener('click', closeModal);
$('modal-cancel').addEventListener('click', closeModal);
$('modal-overlay').addEventListener('click', () => { closeModal(); closeIcpModal(); });

// ─── Cliente ideale (ICP) modal ───
const icpFields = [
  ['icp-description', 'description'],
  ['icp-age-min', 'age_min'],
  ['icp-age-max', 'age_max'],
  ['icp-gender', 'gender'],
  ['icp-business', 'business_type'],
  ['icp-countries', 'countries'],
  ['icp-languages', 'languages'],
  ['icp-interests', 'interests'],
  ['icp-professions', 'professions'],
  ['icp-followers-min', 'followers_min'],
  ['icp-followers-max', 'followers_max'],
  ['icp-avoid', 'avoid'],
];

const econLabels = { basso: 'Basso', medio: 'Medio', 'medio-alto': 'Medio-alto', alto: 'Alto', luxury: 'Luxury' };
function getIcpEconomic() {
  return [...document.querySelectorAll('#icp-economic-panel input:checked')].map(c => c.value).join(', ');
}
function setIcpEconomic(val) {
  const set = new Set(String(val || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  document.querySelectorAll('#icp-economic-panel input').forEach(c => { c.checked = set.has(c.value); });
  updateIcpEconomicLabel();
}
function updateIcpEconomicLabel() {
  const checked = [...document.querySelectorAll('#icp-economic-panel input:checked')].map(c => c.value);
  const label = $('icp-economic-label');
  const count = $('icp-economic-count');
  if (!checked.length) {
    label.textContent = 'Qualsiasi';
    label.classList.add('is-placeholder');
    count.hidden = true;
  } else if (checked.length === 1) {
    label.textContent = econLabels[checked[0]] || checked[0];
    label.classList.remove('is-placeholder');
    count.hidden = true;
  } else if (checked.length === 5) {
    label.textContent = 'Tutti i livelli';
    label.classList.remove('is-placeholder');
    count.hidden = true;
  } else {
    label.textContent = checked.map(v => econLabels[v] || v).join(', ');
    label.classList.remove('is-placeholder');
    count.hidden = false;
    count.textContent = String(checked.length);
  }
}

async function openIcpModal() {
  const m = $('icp-modal');
  const o = $('modal-overlay');
  m.hidden = false;
  o.hidden = false;
  setTimeout(() => { m.classList.add('vis'); o.classList.add('vis'); }, 20);
  try {
    const { icp } = await api('/api/crm/icp');
    if (icp) {
      for (const [id, key] of icpFields) {
        const el = $(id);
        if (el && icp[key] != null) el.value = icp[key];
      }
      setIcpEconomic(icp.economic_level);
    } else {
      setIcpEconomic('');
    }
  } catch { setIcpEconomic(''); }
  $('icp-description').focus();
}

function closeIcpModal() {
  const m = $('icp-modal');
  const o = $('modal-overlay');
  m.classList.remove('vis');
  o.classList.remove('vis');
  setTimeout(() => { m.hidden = true; o.hidden = true; }, 180);
}

async function saveIcp() {
  const body = {};
  for (const [id, key] of icpFields) {
    const el = $(id);
    if (!el) continue;
    body[key] = el.value;
  }
  body.economic_level = getIcpEconomic();
  const btn = $('icp-save');
  btn.disabled = true;
  try {
    await api('/api/crm/icp', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    toast('Cliente ideale salvato', 'good');
    closeIcpModal();
  } catch (e) {
    toast('Errore salvataggio: ' + (e.message || e), 'bad');
  } finally {
    btn.disabled = false;
  }
}

$('btn-open-icp').addEventListener('click', openIcpModal);
$('icp-close').addEventListener('click', closeIcpModal);
$('icp-cancel').addEventListener('click', closeIcpModal);
$('icp-save').addEventListener('click', saveIcp);

// ─── Follow-up ───
let fuData = [];
let fuDays = 3;
async function loadFuDays() {
  try {
    const s = await api('/api/settings');
    const d = parseInt(s.followup_days, 10);
    if (d >= 1 && d <= 60) fuDays = d;
    $('fu-panel-sub').textContent = `Lead contattati da più di ${fuDays} giorni senza risposta`;
  } catch {}
}

function daysAgoLabel(n) {
  if (n <= 0) return 'oggi';
  if (n === 1) return '1 giorno fa';
  return `${n} giorni fa`;
}

function renderFollowups() {
  const wrap = $('fu-wrap');
  const badge = $('fu-badge');
  const body = $('fu-panel-body');
  const count = fuData.length;
  if (count > 0) {
    wrap.classList.add('has-items');
    badge.hidden = false;
    badge.textContent = count > 99 ? '99+' : String(count);
  } else {
    wrap.classList.remove('has-items');
    badge.hidden = true;
  }
  if (!count) {
    body.innerHTML = `<div class="fu-empty">
      <svg class="fu-empty__ico" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
      Tutto a posto!<br>Nessun lead in attesa di follow-up.
    </div>`;
    return;
  }
  body.innerHTML = fuData.map(l => {
    const ini = initials(l.full_name || l.username);
    const avatar = l.profile_pic_url
      ? `<img class="fu-item__ava" src="${esc(l.profile_pic_url)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'fu-item__ava fu-item__ava--ph',textContent:'${ini}'}))">`
      : `<div class="fu-item__ava fu-item__ava--ph">${ini}</div>`;
    return `<div class="fu-item" data-id="${l.id}">
      ${avatar}
      <div class="fu-item__body">
        <div class="fu-item__name">${esc(l.full_name || l.username)}</div>
        <div class="fu-item__sub">@${esc(l.username)} · <span class="fu-item__age">${daysAgoLabel(l.days_waiting)}</span></div>
      </div>
      <div class="fu-item__acts">
        <button class="fu-btn fu-btn--primary" data-fu-act="open" data-id="${l.id}" title="Apri lead">Apri</button>
        <button class="fu-btn" data-fu-act="dismiss" data-id="${l.id}" title="Nascondi finché non cambia stato">Rimanda</button>
      </div>
    </div>`;
  }).join('');
}

async function loadFollowups() {
  try {
    const r = await api('/api/crm/followups?days=' + fuDays);
    fuData = r.followups || [];
    renderFollowups();
  } catch {}
}

function openFuPanel() {
  $('fu-wrap').classList.add('open');
  $('fu-panel').hidden = false;
  loadFollowups();
}
function closeFuPanel() {
  $('fu-wrap').classList.remove('open');
  $('fu-panel').hidden = true;
}

$('btn-fu').addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = $('fu-wrap').classList.contains('open');
  if (isOpen) closeFuPanel(); else openFuPanel();
});
$('fu-close').addEventListener('click', closeFuPanel);
document.addEventListener('click', (e) => {
  const wrap = $('fu-wrap');
  if (!wrap.classList.contains('open')) return;
  if (!wrap.contains(e.target)) closeFuPanel();
});

$('fu-panel-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-fu-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.fuAct;
  if (act === 'dismiss') {
    try {
      await api(`/api/crm/leads/${id}/followup/dismiss`, { method: 'POST' });
      fuData = fuData.filter(l => String(l.id) !== String(id));
      renderFollowups();
      toast('Follow-up rimandato', 'ok');
    } catch (err) { toast('Errore: ' + err.message, 'bad'); }
  } else if (act === 'open') {
    closeFuPanel();
    // Scroll to and open the lead's detail row.
    const row = document.querySelector(`tr.crm-row[data-id="${id}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const toggle = row.querySelector('.row-toggle');
      if (toggle) toggle.click();
    } else {
      toast('Lead non in vista: rimuovi i filtri', 'bad');
    }
  }
});

(async () => { await loadFuDays(); loadFollowups(); })();
setInterval(loadFollowups, 60000);

$('icp-economic-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = $('icp-economic-dd');
  const p = $('icp-economic-panel');
  const open = dd.classList.toggle('open');
  p.hidden = !open;
});
$('icp-economic-panel').addEventListener('change', (e) => {
  if (e.target.matches('input[type="checkbox"]')) updateIcpEconomicLabel();
});
$('icp-economic-all').addEventListener('click', () => {
  document.querySelectorAll('#icp-economic-panel input[type="checkbox"]').forEach(c => { c.checked = true; });
  updateIcpEconomicLabel();
});
$('icp-economic-none').addEventListener('click', () => {
  document.querySelectorAll('#icp-economic-panel input[type="checkbox"]').forEach(c => { c.checked = false; });
  updateIcpEconomicLabel();
});
document.addEventListener('click', (e) => {
  const dd = $('icp-economic-dd');
  if (!dd || !dd.classList.contains('open')) return;
  if (!dd.contains(e.target)) { dd.classList.remove('open'); $('icp-economic-panel').hidden = true; }
});

function parseProfileInput(raw) {
  let input = raw.trim().replace(/^@/, '');
  const urlMatch = input.match(/(?:https?:\/\/)?(?:www\.)?(?:(instagram|tiktok|facebook)\.com)\/(?:@)?([\w.]+)/i);
  if (urlMatch) return { platform: urlMatch[1].toLowerCase(), username: urlMatch[2].replace(/\/$/, '') };
  return { platform: null, username: input };
}

function setProgress(pct, label) {
  $('enrich-progress').hidden = false;
  $('enrich-progress-fill').style.width = pct + '%';
  $('enrich-progress-label').textContent = label;
}

function hideProgress() {
  $('enrich-progress').hidden = true;
  $('enrich-progress-fill').style.width = '0%';
}

function updateAddBtnLabel() {
  const p = $('add-crm-platform').value;
  $('btn-add-crm-lead').textContent = p === 'telegram' ? 'Aggiungi' : 'Aggiungi e arricchisci';
}
$('add-crm-platform').addEventListener('change', updateAddBtnLabel);

$('add-crm-username').addEventListener('input', () => {
  const { platform } = parseProfileInput($('add-crm-username').value);
  if (platform) { $('add-crm-platform').value = platform; updateAddBtnLabel(); }
});

$('btn-add-crm-lead').addEventListener('click', async () => {
  const rawInput = $('add-crm-username').value.trim();
  const full_name = $('add-crm-name').value.trim();
  if (!rawInput && !full_name) return;

  const parsed = parseProfileInput(rawInput);
  const platform = parsed.platform || $('add-crm-platform').value;
  const username = parsed.username;

  const btn = $('btn-add-crm-lead');
  btn.disabled = true;
  btn.textContent = 'Aggiunta...';

  setProgress(10, 'Creazione lead...');
  try {
    setProgress(20, 'Invio dati...');
    const progressInterval = setInterval(() => {
      const cur = parseFloat($('enrich-progress-fill').style.width) || 20;
      if (cur < 85) $('enrich-progress-fill').style.width = (cur + Math.random() * 8) + '%';
    }, 800);

    setProgress(25, 'Arricchimento profilo...');
    await api('/api/crm/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, username, full_name, email: $('add-crm-email').value.trim() }),
    });

    clearInterval(progressInterval);
    setProgress(100, 'Completato!');
    $('add-crm-username').value = '';
    $('add-crm-name').value = '';
    $('add-crm-email').value = '';
    setTimeout(() => {
      hideProgress();
      closeModal();
      loadCrm();
      toast('Lead aggiunto con successo');
    }, 600);
  } catch (err) {
    hideProgress();
    toast('Errore: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
    updateAddBtnLabel();
  }
});

// ─── Init ───
loadCrm();
