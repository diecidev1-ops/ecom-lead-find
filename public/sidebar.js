(function () {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const toggle = document.getElementById('sidebar-toggle');
  if (!sidebar || !toggle) return;

  function open() {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
  }
  function close() {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
  }

  toggle.addEventListener('click', () => {
    sidebar.classList.contains('open') ? close() : open();
  });
  overlay.addEventListener('click', close);

  // Theme toggle
  const themeBtn = document.getElementById('theme-toggle');
  if (!themeBtn) return;

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const label = themeBtn.querySelector('.theme-label');
    if (label) label.textContent = theme === 'dark' ? 'Tema scuro' : 'Tema chiaro';
  }

  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);

  themeBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    applyTheme(next);
  });
})();
