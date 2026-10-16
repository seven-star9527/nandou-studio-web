/* Apply before paint, including when a guide is opened directly. No account data is stored. */
try { document.documentElement.dataset.theme = localStorage.getItem('nandou-theme') === 'light' ? 'light' : 'dark'; } catch { document.documentElement.dataset.theme = 'dark'; }
window.addEventListener('storage', event => { if (event.key === 'nandou-theme') document.documentElement.dataset.theme = event.newValue === 'light' ? 'light' : 'dark'; });
