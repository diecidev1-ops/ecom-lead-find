(() => {
  const state = { days: 30, platform: '' };
  let data = null;
  const vis = { extracted: true, contacted: true, clients: true };

  async function load() {
    const p = new URLSearchParams();
    if (state.from && state.to) {
      p.set('from', state.from);
      p.set('to', state.to);
    } else if (state.days) {
      p.set('days', state.days);
    }
    if (state.platform) p.set('platform', state.platform);
    const r = await fetch('/api/analytics?' + p);
    data = await r.json();
    render();
  }

  function fmt(n) { return n == null ? '—' : n.toLocaleString('it-IT'); }

  function trend(cur, prev) {
    if (prev == null) return '';
    const d = cur - prev;
    if (d === 0) return '<span class="an-trend an-trend--flat">—</span>';
    const c = d > 0 ? 'up' : 'down';
    return `<span class="an-trend an-trend--${c}">${d > 0 ? '↑' : '↓'} ${Math.abs(d)}</span>`;
  }

  function ptrend(cur, prev) {
    if (prev == null) return '';
    const d = cur - prev;
    if (d === 0) return '<span class="an-trend an-trend--flat">—</span>';
    const c = d > 0 ? 'up' : 'down';
    return `<span class="an-trend an-trend--${c}">${d > 0 ? '↑' : '↓'} ${Math.abs(d)}pp</span>`;
  }

  function spark(arr, color) {
    if (!arr || !arr.length) return '';
    const w = 64, h = 20, mx = Math.max(...arr, 1);
    const pts = arr.map((v, i) =>
      `${(i / (arr.length - 1)) * w},${h - (v / mx) * (h - 2) - 1}`
    ).join(' ');
    return `<svg class="an-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <polyline points="${pts}" fill="none" stroke="${color || 'var(--accent)'}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  const ICO = {
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    plus: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    phone: '<path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94m-1 7.98v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  };

  function ico(name) {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICO[name] || ''}</svg>`;
  }

  function renderKpis() {
    const { kpis, withEmail, total } = data;
    const items = [
      { ic: 'users', lb: 'Lead Totali', v: fmt(kpis.totalLeads.value), tr: trend(kpis.totalLeads.delta, kpis.totalLeads.prevDelta), sp: spark(kpis.totalLeads.spark), accent: true },
      { ic: 'plus', lb: 'Nuovi', v: fmt(kpis.newLeads.value) },
      { ic: 'zap', lb: 'Ultimi 7g', v: fmt(kpis.last7d.value), tr: trend(kpis.last7d.delta, kpis.last7d.prevDelta) },
      { ic: 'mail', lb: 'Con Email', v: fmt(withEmail), sub: total > 0 ? `${Math.round(withEmail / total * 100)}%` : '' },
      { ic: 'phone', lb: '% Contattati', v: `${kpis.contactRate.value}%`, tr: ptrend(kpis.contactRate.value, kpis.contactRate.prev) },
      { ic: 'msg', lb: '% Risposta', v: `${kpis.replyRate.value}%`, tr: ptrend(kpis.replyRate.value, kpis.replyRate.prev) },
      { ic: 'target', lb: '% Conversione', v: `${kpis.conversionRate.value}%`, tr: ptrend(kpis.conversionRate.value, kpis.conversionRate.prev) },
      { ic: 'star', lb: 'Clienti', v: fmt(kpis.clients.value), tr: trend(kpis.clients.delta, kpis.clients.prevDelta), sp: spark(kpis.clients.spark, 'var(--good)'), color: 'good' },
    ];
    document.getElementById('an-kpis').innerHTML = items.map(c => `
      <div class="an-kpi${c.accent ? ' an-kpi--accent' : ''}${c.color ? ' an-kpi--' + c.color : ''}">
        <div class="an-kpi__top">
          <span class="an-kpi__icon">${ico(c.ic)}</span>
          ${c.sp || ''}
        </div>
        <div class="an-kpi__val">${c.v}</div>
        <div class="an-kpi__bot">
          <span class="an-kpi__label">${c.lb}</span>
          ${c.tr || ''}${c.sub ? `<span class="an-kpi__sub">${c.sub}</span>` : ''}
        </div>
      </div>
    `).join('');
  }

  function renderPerf() {
    const { timeline } = data;
    const series = [
      { key: 'extracted', label: 'Estratti', color: '#2383E2', data: timeline.extracted },
      { key: 'contacted', label: 'Contattati', color: '#F7B500', data: timeline.contacted },
      { key: 'clients', label: 'Clienti', color: '#2EA043', data: timeline.clients },
    ];

    document.getElementById('an-legend').innerHTML = series.map(s =>
      `<button class="an-leg__btn${vis[s.key] ? ' active' : ''}" data-key="${s.key}">
        <span class="an-leg__dot" style="background:${s.color}"></span>${s.label}
      </button>`
    ).join('');

    const n = timeline.labels.length;
    if (!n) {
      document.getElementById('an-perf').innerHTML = '<p class="muted" style="padding:40px;text-align:center">Nessun dato</p>';
      return;
    }

    const W = 760, H = 260;
    const PD = { t: 20, r: 15, b: 32, l: 45 };
    const cw = W - PD.l - PD.r, ch = H - PD.t - PD.b;
    const shown = series.filter(s => vis[s.key]);
    const allV = shown.flatMap(s => s.data);
    const maxV = Math.max(...allV, 1);

    const xp = i => PD.l + (i / Math.max(n - 1, 1)) * cw;
    const yp = v => PD.t + ch - (v / maxV) * ch;

    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const val = Math.round(maxV * i / 4);
      const yy = yp(val);
      grid += `<line x1="${PD.l}" y1="${yy}" x2="${W - PD.r}" y2="${yy}" stroke="var(--border)" stroke-width="0.5"/>`;
      grid += `<text x="${PD.l - 8}" y="${yy + 4}" text-anchor="end" fill="var(--muted)" font-size="10" font-family="system-ui">${val}</text>`;
    }

    const step = Math.max(1, Math.floor(n / 7));
    let xLabels = '';
    for (let i = 0; i < n; i += step) {
      xLabels += `<text x="${xp(i)}" y="${H - 5}" text-anchor="middle" fill="var(--muted)" font-size="10" font-family="system-ui">${timeline.labels[i].slice(5)}</text>`;
    }

    let paths = '';
    for (const s of shown) {
      const pts = s.data.map((v, i) => `${xp(i)},${yp(v)}`);
      const area = `M${xp(0)},${yp(0)} ${pts.map(p => `L${p}`).join(' ')} L${xp(n - 1)},${PD.t + ch} L${xp(0)},${PD.t + ch} Z`;
      paths += `<path d="${area}" fill="${s.color}" opacity="0.06"/>`;
      paths += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
      s.data.forEach((v, i) => {
        paths += `<circle cx="${xp(i)}" cy="${yp(v)}" r="0" fill="${s.color}" class="an-dot" data-idx="${i}"/>`;
      });
    }

    document.getElementById('an-perf').innerHTML = `
      <div class="an-perf-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="an-svg">
          ${grid}${xLabels}${paths}
          <line id="hl" x1="0" y1="${PD.t}" x2="0" y2="${PD.t + ch}" stroke="var(--border-light)" stroke-dasharray="3 3" opacity="0"/>
        </svg>
        <div class="an-tip" id="an-tip"></div>
      </div>`;

    const wrap = document.querySelector('.an-perf-wrap');
    const svg = wrap.querySelector('.an-svg');
    const hl = svg.querySelector('#hl');
    const tip = document.getElementById('an-tip');

    wrap.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width * W;
      if (mx < PD.l || mx > W - PD.r) { hl.setAttribute('opacity', '0'); tip.style.display = 'none'; return; }
      const idx = Math.min(Math.max(Math.round((mx - PD.l) / cw * (n - 1)), 0), n - 1);
      const xi = xp(idx);
      hl.setAttribute('x1', xi); hl.setAttribute('x2', xi); hl.setAttribute('opacity', '1');
      svg.querySelectorAll('.an-dot').forEach(d => {
        d.setAttribute('r', +d.dataset.idx === idx ? '4' : '0');
      });
      const rows = shown.map(s =>
        `<div class="an-tip__row"><span style="background:${s.color}" class="an-tip__dot"></span>${s.label}: <b>${s.data[idx]}</b></div>`
      ).join('');
      tip.innerHTML = `<div class="an-tip__date">${timeline.labels[idx]}</div>${rows}`;
      tip.style.display = 'block';
      const pctX = xi / W * 100;
      tip.style.left = pctX + '%';
      tip.style.transform = pctX > 65 ? 'translateX(-100%)' : '';
    });
    wrap.addEventListener('mouseleave', () => {
      hl.setAttribute('opacity', '0');
      tip.style.display = 'none';
      svg.querySelectorAll('.an-dot').forEach(d => d.setAttribute('r', '0'));
    });

    document.getElementById('an-legend').querySelectorAll('.an-leg__btn').forEach(btn => {
      btn.onclick = () => { vis[btn.dataset.key] = !vis[btn.dataset.key]; renderPerf(); };
    });
  }

  function renderFunnel() {
    const { funnel } = data;
    const colors = ['#2383E2', '#58A6FF', '#F7B500', '#F0883E', '#2EA043', '#238636'];
    const maxC = funnel[0]?.count || 1;
    document.getElementById('an-funnel').innerHTML = funnel.map((f, i) => {
      const pct = maxC > 0 ? Math.max(f.count / maxC * 100, 3) : 3;
      return `<div class="an-fn__step${f.isBiggestDrop ? ' an-fn__step--drop' : ''}">
        <span class="an-fn__label">${f.label}</span>
        <div class="an-fn__bar-wrap">
          <div class="an-fn__bar" style="width:${pct}%;background:${colors[i]}"></div>
        </div>
        <span class="an-fn__val">${fmt(f.count)} <span class="muted">${f.pctTotal}%</span></span>
      </div>`;
    }).join('');
  }

  function renderPlatforms() {
    const { platforms } = data;
    if (!platforms.length) {
      document.getElementById('an-platforms').innerHTML = '<p class="muted" style="text-align:center;padding:30px">Nessun dato</p>';
      return;
    }
    const colors = { instagram: '#E1306C', tiktok: '#00F2EA', facebook: '#1877F2' };
    const total = platforms.reduce((a, p) => a + p.leads, 0) || 1;
    const R = 60, gap = 4, C = 2 * Math.PI * R;
    let offset = 0;
    const arcs = platforms.map(p => {
      const pct = p.leads / total;
      const len = pct * C;
      const arc = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${colors[p.platform] || '#6E7681'}" stroke-width="18" stroke-dasharray="${Math.max(len - gap, 0)} ${C}" stroke-dashoffset="${-offset}"/>`;
      offset += len;
      return arc;
    });
    const rows = platforms.map(p => `
      <tr>
        <td><span class="an-plt__dot" style="background:${colors[p.platform] || '#6E7681'}"></span>${p.platform}</td>
        <td>${fmt(p.leads)}</td>
        <td>${p.replyRate}%</td>
        <td>${p.convRate}%</td>
      </tr>`).join('');
    document.getElementById('an-platforms').innerHTML = `
      <div class="an-plt">
        <svg viewBox="0 0 160 160" width="140" height="140" class="an-donut" style="transform:rotate(-90deg)">${arcs.join('')}</svg>
        <table class="an-plt__tbl">
          <thead><tr><th>Piattaforma</th><th>Lead</th><th>Reply</th><th>Conv.</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function renderScoreDist() {
    const { scoreDist } = data;
    const mx = Math.max(...scoreDist.map(s => s.count), 1);
    const colors = ['#6E7681', '#F7B500', '#2383E2', '#2EA043'];
    document.getElementById('an-score-dist').innerHTML = `
      <div class="an-bars">
        ${scoreDist.map((s, i) => `
          <div class="an-bars__col">
            <div class="an-bars__tooltip">${s.count}</div>
            <div class="an-bars__bar" style="height:${Math.max(s.count / mx * 100, 4)}%;background:${colors[i]}"></div>
            <span class="an-bars__label">${s.range}</span>
          </div>`).join('')}
      </div>`;
  }

  function renderTimeline() {
    const { timeline } = data;
    const n = timeline.labels.length;
    if (!n) { document.getElementById('an-timeline').innerHTML = '<p class="muted" style="text-align:center;padding:30px">Nessun dato</p>'; return; }
    const mx = Math.max(...timeline.extracted, 1);
    const bw = Math.max(Math.min(Math.floor(700 / n), 20), 4);
    const labelStep = Math.max(1, Math.floor(n / 12));
    document.getElementById('an-timeline').innerHTML = `
      <div class="an-tl">
        <div class="an-tl__bars" style="height:160px">
          ${timeline.extracted.map((v, i) => `
            <div class="an-tl__col" style="width:${bw}px">
              <div class="an-tl__tip">${v}</div>
              <div class="an-tl__bar" style="height:${Math.max(v / mx * 100, 2)}%"></div>
              ${i % labelStep === 0 ? `<span class="an-tl__lbl">${timeline.labels[i].slice(5)}</span>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
  }

  function renderCrm() {
    const { crmPerformance: cp } = data;
    const items = [
      { label: 'Senza Email', value: cp.noEmail, color: 'warn' },
      { label: 'Senza Telefono', value: cp.noPhone, color: 'warn' },
      { label: 'Inattivi 14g+', value: cp.inactive, color: 'danger' },
      { label: 'Follow-up in ritardo', value: cp.forgotten, color: 'danger' },
    ];
    document.getElementById('an-crm').innerHTML = `
      <div class="an-metrics">
        ${items.map(it => `
          <div class="an-metric an-metric--${it.color}">
            <span class="an-metric__val">${it.value}</span>
            <span class="an-metric__label">${it.label}</span>
          </div>`).join('')}
      </div>`;
  }

  function renderAlerts() {
    const { alerts } = data;
    const icoMap = { danger: '⚠', warning: '⚡', info: 'ℹ', good: '✓' };
    document.getElementById('an-alerts').innerHTML = `
      <div class="an-alerts">
        ${alerts.map(a => `
          <div class="an-alert an-alert--${a.severity}">
            <span class="an-alert__ico">${icoMap[a.severity] || '•'}</span>
            <span>${a.message}</span>
          </div>`).join('')}
      </div>`;
  }

  function renderGoals() {
    const { goals } = data;
    const pct = goals.target > 0 ? Math.min(Math.round(goals.current / goals.target * 100), 100) : 0;
    document.getElementById('an-goals').innerHTML = `
      <div class="an-goal">
        <div class="an-goal__head">
          <span class="an-goal__pct">${pct}%</span>
          <span class="an-goal__of">${fmt(goals.current)} / ${fmt(goals.target)}</span>
        </div>
        <div class="an-goal__track">
          <div class="an-goal__fill" style="width:${pct}%"></div>
        </div>
        <div class="an-goal__foot">
          <span>${goals.daysLeft} giorni rimanenti</span>
          <span>${goals.dailyNeeded} lead/giorno necessari</span>
        </div>
      </div>`;
  }

  function renderScoreConv() {
    const { scoreConv } = data;
    document.getElementById('an-score-conv').innerHTML = `
      <div class="an-sconv">
        ${scoreConv.map(s => `
          <div class="an-sconv__card">
            <div class="an-sconv__range">${s.range}</div>
            <div class="an-sconv__rate">${s.convRate}%</div>
            <div class="an-sconv__detail">${s.clients}/${s.leads} lead</div>
          </div>`).join('')}
      </div>`;
  }

  function render() {
    renderKpis();
    renderPerf();
    renderFunnel();
    renderPlatforms();
    renderScoreDist();
    renderTimeline();
    renderCrm();
    renderAlerts();
    renderGoals();
    renderScoreConv();
  }

  document.getElementById('an-pills').addEventListener('click', e => {
    const btn = e.target.closest('.an-pill');
    if (!btn) return;
    document.querySelectorAll('.an-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const val = btn.dataset.days;
    const dateRange = document.getElementById('an-date-range');
    if (val === 'custom') {
      dateRange.hidden = false;
      return;
    }
    dateRange.hidden = true;
    state.days = +val;
    delete state.from;
    delete state.to;
    load();
  });

  document.getElementById('an-date-range').addEventListener('change', () => {
    const from = document.getElementById('an-date-from').value;
    const to = document.getElementById('an-date-to').value;
    if (from && to) {
      state.from = from;
      state.to = to;
      state.days = 0;
      load();
    }
  });

  document.getElementById('an-platform').addEventListener('change', e => {
    state.platform = e.target.value;
    load();
  });

  load();
})();
