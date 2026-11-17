// JARVIS on a TV or second monitor. This window never listens or talks itself: the main window
// keeps the microphone and sends the state, sound level and last words here (~30 times a second).
(function () {
  const $ = s => document.querySelector(s);
  const d = window.jarvisDesktop || {};
  const canvas = $('#orb'), orb = window.JarvisOrb.create(canvas, { scale: 0.19, cy: 0.44 });
  let cur = { state: 'idle', level: 0 }, lastCaption = '';
  const fit = () => window.JarvisOrb.fit(canvas);
  addEventListener('resize', fit); fit();

  const frame = now => { requestAnimationFrame(frame); orb.draw(now, cur); };
  requestAnimationFrame(frame);

  if (d.onStageFrame) d.onStageFrame(f => {
    if (f.skin !== undefined) {
      const h = document.documentElement;
      if (f.skin) h.dataset.skin = f.skin; else delete h.dataset.skin;
      if (f.theme) h.dataset.theme = f.theme; else delete h.dataset.theme;
      orb.setPalette(f.palette);
      return;
    }
    cur = { state: f.state || 'idle', level: +f.level || 0 };
    if (f.label && $('#state').textContent !== f.label) $('#state').textContent = f.label;
    if ((f.caption || '') !== lastCaption) { lastCaption = f.caption || ''; const c = $('#caption'); c.textContent = lastCaption; c.classList.toggle('you', f.who === 'user'); }
  });

  // clock (big, readable from the sofa)
  const tick = () => {
    const n = new Date();
    $('#time').textContent = n.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    $('#date').textContent = n.toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick(); setInterval(tick, 10000);

  $('#hit').onclick = () => d.stageInput && d.stageInput('talk');
  addEventListener('keydown', e => {
    if (e.key === 'Escape') d.stageInput && d.stageInput('close');
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); d.stageInput && d.stageInput('talk'); }
  });
  // hide the mouse pointer and the hint when nobody moves it
  let idleT = 0;
  const wake = () => { document.body.classList.remove('idle-cursor'); $('#hint').style.opacity = '.6'; clearTimeout(idleT); idleT = setTimeout(() => { document.body.classList.add('idle-cursor'); $('#hint').style.opacity = '0'; }, 3000); };
  addEventListener('pointermove', wake); wake();
})();
