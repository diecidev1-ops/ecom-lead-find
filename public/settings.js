const $ = (id) => document.getElementById(id);

let original = {};

const icpFields = [
  ['icp-s-description', 'description'],
  ['icp-s-age-min', 'age_min'],
  ['icp-s-age-max', 'age_max'],
  ['icp-s-gender', 'gender'],
  ['icp-s-business', 'business_type'],
  ['icp-s-countries', 'countries'],
  ['icp-s-languages', 'languages'],
  ['icp-s-interests', 'interests'],
  ['icp-s-professions', 'professions'],
  ['icp-s-followers-min', 'followers_min'],
  ['icp-s-followers-max', 'followers_max'],
  ['icp-s-avoid', 'avoid'],
];
const econLabels = { basso: 'Basso', medio: 'Medio', 'medio-alto': 'Medio-alto', alto: 'Alto', luxury: 'Luxury' };

function updateEconomicLabel() {
  const checked = [...document.querySelectorAll('#icp-s-economic-panel input:checked')].map(c => c.value);
  const label = $('icp-s-economic-label');
  const count = $('icp-s-economic-count');
  if (!checked.length) {
    label.textContent = 'Qualsiasi'; label.classList.add('is-placeholder'); count.hidden = true;
  } else if (checked.length === 1) {
    label.textContent = econLabels[checked[0]] || checked[0]; label.classList.remove('is-placeholder'); count.hidden = true;
  } else if (checked.length === 5) {
    label.textContent = 'Tutti i livelli'; label.classList.remove('is-placeholder'); count.hidden = true;
  } else {
    label.textContent = checked.map(v => econLabels[v] || v).join(', ');
    label.classList.remove('is-placeholder');
    count.hidden = false; count.textContent = String(checked.length);
  }
}
function setEconomic(val) {
  const set = new Set(String(val || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  document.querySelectorAll('#icp-s-economic-panel input').forEach(c => { c.checked = set.has(c.value); });
  updateEconomicLabel();
}
function getEconomic() {
  return [...document.querySelectorAll('#icp-s-economic-panel input:checked')].map(c => c.value).join(', ');
}

async function load() {
  const data = await fetch('/api/settings').then(r => r.json());
  original = data;

  $('apify-key').value = data.apify_key || '';
  $('ai-key').value = data.ai_key || '';
  if (data.ai_provider) $('ai-provider').value = data.ai_provider;
  $('followup-days').value = data.followup_days || 3;

  if (data.apify_key) showStatus('apify-status', 'Chiave salvata', 'good');
  if (data.ai_key) showStatus('ai-status', 'Chiave salvata', 'good');

  try {
    const { icp } = await fetch('/api/crm/icp').then(r => r.json());
    if (icp) {
      for (const [id, key] of icpFields) {
        const el = $(id);
        if (el && icp[key] != null) el.value = icp[key];
      }
      setEconomic(icp.economic_level);
    } else {
      setEconomic('');
    }
  } catch { setEconomic(''); }
}

function showStatus(id, msg, type) {
  const el = $(id);
  el.textContent = msg;
  el.className = `settings-field__status settings-field__status--${type}`;
}

function setupToggle(btnId, inputId) {
  $(btnId).addEventListener('click', () => {
    const inp = $(inputId);
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
}

setupToggle('toggle-apify', 'apify-key');
setupToggle('toggle-ai', 'ai-key');

// Economic multi-select dropdown
$('icp-s-economic-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = $('icp-s-economic-dd');
  const p = $('icp-s-economic-panel');
  const open = dd.classList.toggle('open');
  p.hidden = !open;
});
$('icp-s-economic-panel').addEventListener('change', (e) => {
  if (e.target.matches('input[type="checkbox"]')) updateEconomicLabel();
});
$('icp-s-economic-all').addEventListener('click', () => {
  document.querySelectorAll('#icp-s-economic-panel input[type="checkbox"]').forEach(c => { c.checked = true; });
  updateEconomicLabel();
});
$('icp-s-economic-none').addEventListener('click', () => {
  document.querySelectorAll('#icp-s-economic-panel input[type="checkbox"]').forEach(c => { c.checked = false; });
  updateEconomicLabel();
});
document.addEventListener('click', (e) => {
  const dd = $('icp-s-economic-dd');
  if (!dd || !dd.classList.contains('open')) return;
  if (!dd.contains(e.target)) { dd.classList.remove('open'); $('icp-s-economic-panel').hidden = true; }
});

$('btn-save').addEventListener('click', async () => {
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Salvataggio...';

  const settingsBody = {};
  const apifyVal = $('apify-key').value.trim();
  if (apifyVal && !apifyVal.includes('••')) settingsBody.apify_key = apifyVal;
  const aiVal = $('ai-key').value.trim();
  if (aiVal && !aiVal.includes('••')) settingsBody.ai_key = aiVal;
  settingsBody.ai_provider = $('ai-provider').value;
  const daysVal = parseInt($('followup-days').value, 10);
  if (!isNaN(daysVal) && daysVal >= 1 && daysVal <= 60) settingsBody.followup_days = String(daysVal);

  const icpBody = {};
  for (const [id, key] of icpFields) {
    const el = $(id);
    if (el) icpBody[key] = el.value;
  }
  icpBody.economic_level = getEconomic();

  try {
    if (Object.keys(settingsBody).length) {
      const r1 = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settingsBody),
      });
      if (!r1.ok) throw new Error((await r1.json()).error || 'Errore impostazioni');
    }
    const r2 = await fetch('/api/crm/icp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(icpBody),
    });
    if (!r2.ok) throw new Error((await r2.json()).error || 'Errore ICP');

    $('save-feedback').textContent = 'Salvato!';
    $('save-feedback').className = 'settings-saved settings-saved--ok';
    if (settingsBody.apify_key) showStatus('apify-status', 'Chiave salvata', 'good');
    if (settingsBody.ai_key) showStatus('ai-status', 'Chiave salvata', 'good');

    setTimeout(() => { $('save-feedback').textContent = ''; }, 3000);
    load();
  } catch (err) {
    $('save-feedback').textContent = err.message;
    $('save-feedback').className = 'settings-saved settings-saved--err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salva impostazioni';
  }
});

$('btn-test-ai').addEventListener('click', async () => {
  const btn = $('btn-test-ai');
  const result = $('ai-test-result');
  btn.disabled = true;
  btn.textContent = 'Testando...';
  result.textContent = '';
  result.className = 'settings-field__status';

  try {
    const res = await fetch('/api/settings/test-ai', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore');
    result.textContent = `Connesso a ${data.provider} — risposta: "${data.reply}"`;
    result.className = 'settings-field__status settings-field__status--good';
  } catch (err) {
    result.textContent = `Errore: ${err.message}`;
    result.className = 'settings-field__status settings-field__status--err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Testa connessione';
  }
});

load();
