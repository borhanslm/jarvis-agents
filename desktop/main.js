// JARVIS desktop app (Electron main process).
// Runs the local server in-process (127.0.0.1 only) and shows the panel in a window.
// Everything stays on this computer: data lives in %APPDATA%\JARVIS\data.
'use strict';
const electron = require('electron');
// voice: audio capture and timers must keep running while the window is hidden or covered
electron.app.commandLine.appendSwitch('disable-background-timer-throttling');
electron.app.commandLine.appendSwitch('disable-renderer-backgrounding');
electron.app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
electron.app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // JARVIS answers out loud without a click
const { app, BrowserWindow, shell, nativeTheme, Menu, dialog, ipcMain, session, Tray, globalShortcut, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_PORT = 47777; // fixed so the page origin (and its saved preferences) stays the same

// a separate data folder for testing next to an installed JARVIS (developers only)
if (process.env.JARVIS_USER_DATA) electron.app.setPath('userData', process.env.JARVIS_USER_DATA);
// ---- logging to %APPDATA%\JARVIS\logs\main.log ----
const logDir = path.join(app.getPath('userData'), 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'main.log');
process.env.JARVIS_LOG = logFile; // shown in the panel's diagnostics
try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old'); } catch {}
const log = (...a) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map(String).join(' ')}\n`); } catch {} };
for (const k of ['log', 'warn', 'error']) { const orig = console[k].bind(console); console[k] = (...a) => { log(k.toUpperCase(), ...a); orig(...a); }; }
process.on('uncaughtException', e => log('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', e => log('UNHANDLED', e && e.stack || e));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('app.jarvis.agents');
  let win = null, serverOrigin = "";
  let srv = null;
  let quitting = false;
  let tray = null;
  let trayHintShown = false;
  const startHidden = process.argv.includes('--hidden'); // launched at Windows sign-in
  const desk = () => { try { return srv.settings(); } catch { return {}; } };
  const showWin = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); };
  const reallyQuit = () => {
    if (srv && srv.isBusy()) {
      if (win) showWin();
      const r = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['خروج', 'انصراف'], defaultId: 1, cancelId: 1, title: 'JARVIS',
        message: 'ایجنت‌ها هنوز در حال کارند. خارج می‌شوید؟', detail: 'کارهای در حال اجرا متوقف می‌شوند. نقطه‌ی بازگشت هر اجرا محفوظ است.',
      });
      if (r !== 0) return;
    }
    quitting = true;
    try { srv.stopAll(); } catch (err) { log('stopAll', err); }
    app.quit();
  };
  // ---- updates from GitHub Releases (only in the installed app) ----
  let updater = null, updateState = { state: 'idle' }, installWhenReady = false;
  const sendUpdate = st => { updateState = st; if (win && !win.isDestroyed()) win.webContents.send('jarvis:update-state', st); };
  function installNow() {
    quitting = true;
    try { srv.stopAll(); } catch (err) { log('stopAll', err); }
    setImmediate(() => updater.quitAndInstall(false, true)); // silent install, then JARVIS opens again
  }
  function checkUpdates(manual) {
    if (!updater) { installWhenReady = false; if (manual) sendUpdate({ state: 'unsupported' }); return; }
    if (!manual && desk().desktopAutoUpdate === false) return;
    sendUpdate({ state: 'checking', manual: !!manual });
    updater.checkForUpdates().catch(e => { log('update check', e && e.message || e); sendUpdate({ state: 'error', message: String(e && e.message || e).slice(0, 300), manual: !!manual }); });
  }
  function setupUpdates() {
    if (!app.isPackaged) return;
    try { updater = require('electron-updater').autoUpdater; } catch (e) { log('electron-updater missing', e); return; }
    updater.logger = { info: m => log('update', m), warn: m => log('update warn', m), error: m => log('update error', m), debug() {} };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('update-available', i => sendUpdate({ state: 'downloading', version: i.version, percent: 0 }));
    updater.on('update-not-available', i => { installWhenReady = false; sendUpdate({ state: 'latest', version: i && i.version, manual: updateState.manual }); });
    updater.on('download-progress', p => sendUpdate({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', i => {
      // «به‌روزرسانی الان» in settings: no second question, install and restart at once
      if (installWhenReady) { installWhenReady = false; sendUpdate({ state: 'installing', version: i.version }); return installNow(); }
      sendUpdate({ state: 'ready', version: i.version });
      if (Notification.isSupported()) new Notification({ title: 'نسخه‌ی تازه‌ی جارویس آماده است', body: `نسخه‌ی ${i.version} دانلود شد. از داخل برنامه «نصب» را بزنید، یا با بستن کامل برنامه خودکار نصب می‌شود.` }).show();
    });
    updater.on('error', e => { installWhenReady = false; log('update error', e && e.stack || e); sendUpdate({ state: 'error', message: String(e && e.message || e).slice(0, 300), manual: updateState.manual }); });
    setTimeout(() => checkUpdates(false), 20000);
    setInterval(() => checkUpdates(false), 6 * 3600 * 1000).unref();
  }
  ipcMain.handle('jarvis:app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, update: updateState }));
  ipcMain.on('jarvis:update', (_e, action) => {
    if (action === 'check') return checkUpdates(true);
    if (action === 'install' && updater && updateState.state === 'ready') return installNow();
    if (action === 'now') {
      if (updater && updateState.state === 'ready') return installNow();
      installWhenReady = true;
      if (updateState.state !== 'downloading' && updateState.state !== 'checking') checkUpdates(true);
    }
  });

  function makeTray() {
    if (tray) return;
    tray = new Tray(path.join(__dirname, 'icon.ico'));
    tray.setToolTip('JARVIS');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'نمایش جارویس', click: showWin },
      { type: 'separator' },
      { label: 'خروج کامل', click: reallyQuit },
    ]));
    tray.on('click', showWin);
  }
  // Start with Windows / global shortcut follow the panel settings (re-applied when they change).
  function applyDesktopSettings() {
    const s = desk();
    try { app.setLoginItemSettings({ openAtLogin: !!s.desktopStartup, args: ['--hidden'] }); } catch (e) { log('login item', e); }
    globalShortcut.unregisterAll();
    if (s.desktopHotkey) {
      const ok = globalShortcut.register('CommandOrControl+Shift+J', () => { if (!win) return; if (win.isVisible() && win.isFocused()) win.hide(); else showWin(); });
      if (!ok) log('hotkey Ctrl+Shift+J is taken by another app');
    }
    if (s.desktopTray) makeTray(); else if (tray) { tray.destroy(); tray = null; }
  }

  async function start() {
    process.env.JARVIS_DESKTOP = '1';
    process.env.JARVIS_PORT = String(APP_PORT);
    process.env.JARVIS_DATA = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(process.env.JARVIS_DATA, { recursive: true });
    srv = require('../server.js');
    const { port, token } = await srv.ready;
    const origin = `http://127.0.0.1:${port}`; serverOrigin = origin;
    log('server ready on', origin, 'data', process.env.JARVIS_DATA);

    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);

    // Only the microphone (voice input) and notifications may be requested.
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'notifications'].includes(perm)));

    win = new BrowserWindow({
      width: 1440, height: 900, minWidth: 960, minHeight: 600,
      // No native title bar (it took the Windows accent colour); the panel draws its own.
      frame: false, thickFrame: true,
      title: 'JARVIS', backgroundColor: '#02060E', show: false, autoHideMenuBar: true,
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
        backgroundThrottling: false, // the voice assistant keeps listening for "Hey JARVIS" when hidden
      },
    });
    win.loadURL(`${origin}/?token=${encodeURIComponent(token)}`);
    win.once('ready-to-show', () => { if (!startHidden) win.show(); });
    applyDesktopSettings();
    setupUpdates();

    // Keep the window on our own origin; open web links in the user's browser.
    const openOutside = url => { if (/^https:\/\//i.test(url)) shell.openExternal(url); };
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); openOutside(url); } });
    const isLocalPreview = url => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+(\/|$)/i.test(url) && !url.startsWith(origin);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isLocalPreview(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 860, title: 'پیش‌نمایش — JARVIS', icon: path.join(__dirname, 'icon.ico'), autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: undefined } } };
      }
      openOutside(url); return { action: 'deny' };
    });
    app.on('web-contents-created', (_e, wc) => {
      if (wc === win.webContents) return;
      // preview windows: stay on the local dev server, send everything else to the browser
      wc.on('will-navigate', (e, url) => { if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/i.test(url)) { e.preventDefault(); openOutside(url); } });
      wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
    });
    win.webContents.on('render-process-gone', (_e, d) => log('renderer gone', JSON.stringify(d)));
    // the panel keeps running in the tray (for "Hey JARVIS"), so tell it when nobody can see it:
    // animations and timers pause, only the microphone keeps working
    const vis = v => { if (!win.isDestroyed()) win.webContents.send('jarvis:visible', v); };
    win.on('hide', () => vis(false)); win.on('minimize', () => vis(false));
    win.on('show', () => vis(!win.isMinimized())); win.on('restore', () => vis(true));

    // Closing while agents work: ask first; then stop them cleanly.
    win.on('close', e => {
      if (quitting) return;
      if (desk().desktopTray && tray) {
        e.preventDefault();
        win.hide();
        if (!trayHintShown && Notification.isSupported()) {
          trayHintShown = true;
          new Notification({ title: 'JARVIS در پس‌زمینه است', body: srv.isBusy() ? 'کار ایجنت‌ها ادامه دارد. برای خروج کامل از آیکون کنار ساعت استفاده کنید.' : 'برای خروج کامل از آیکون کنار ساعت «خروج کامل» را بزنید.' }).show();
        }
        return;
      }
      if (srv.isBusy()) {
        const r = dialog.showMessageBoxSync(win, {
          type: 'question', buttons: ['خروج', 'انصراف'], defaultId: 1, cancelId: 1, title: 'JARVIS',
          message: 'ایجنت‌ها هنوز در حال کارند. خارج می‌شوید؟', detail: 'کارهای در حال اجرا متوقف می‌شوند. نقطه‌ی بازگشت هر اجرا محفوظ است.',
        });
        if (r !== 0) { e.preventDefault(); return; }
      }
      quitting = true;
      try { srv.stopAll(); } catch (err) { log('stopAll', err); }
    });
    win.on('closed', () => { win = null; });
  }

  // Keep native surfaces (context menus, scrollbars) in step with the panel's theme.
  ipcMain.on('jarvis:set-theme', (_e, theme) => {
    const light = theme === 'light' || (theme === 'system' && !nativeTheme.shouldUseDarkColors);
    nativeTheme.themeSource = theme === 'system' ? 'system' : light ? 'light' : 'dark';
    if (win) win.setBackgroundColor(light ? '#F1F5F9' : '#02060E');
  });

  ipcMain.on('jarvis:desktop-settings', () => applyDesktopSettings());
  // Voice assistant while the window is hidden: the answer is spoken, and also shown as a Windows notification
  ipcMain.on('jarvis:voice', (_e, ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (tray && ev.state) tray.setToolTip(ev.state === 'off' ? 'JARVIS' : 'JARVIS — ' + String(ev.label || '').slice(0, 60));
    if (ev.reply && win && (!win.isVisible() || win.isMinimized() || !win.isFocused()) && Notification.isSupported()) {
      const n = new Notification({ title: 'JARVIS', body: String(ev.reply).slice(0, 240), silent: true });
      n.on('click', showWin); n.show();
    }
  });
  // Custom title bar buttons.
  ipcMain.on('jarvis:win', (e, action) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (action === 'minimize') w.minimize();
    else if (action === 'toggle-max') (w.isMaximized() ? w.unmaximize() : w.maximize());
    else if (action === 'toggle-full') w.setFullScreen(!w.isFullScreen());
    else if (action === 'close') w.close();
  });
  ipcMain.handle('jarvis:win-state', e => { const w = BrowserWindow.fromWebContents(e.sender); return { maximized: !!(w && w.isMaximized()), fullscreen: !!(w && w.isFullScreen()) }; });
  app.on('browser-window-created', (_e, w) => {
    // on Windows isFullScreen() still has the old value inside these events, so the event says which
    const push = full => { if (!w.isDestroyed()) w.webContents.send('jarvis:win-state', { maximized: w.isMaximized(), fullscreen: typeof full === 'boolean' ? full : w.isFullScreen() }); };
    w.on('maximize', () => push()); w.on('unmaximize', () => push()); w.on('enter-full-screen', () => push(true)); w.on('leave-full-screen', () => push(false));
  });

  // ---- JARVIS on a TV / second monitor ----
  // A draw-only window, full screen on the chosen display. The main window keeps the microphone
  // and sends it frames; a click on the TV orb comes back to the main window as "talk".
  let stageWin = null;
  const stageState = () => { if (win && !win.isDestroyed()) win.webContents.send('jarvis:stage', { type: 'state', open: !!stageWin }); };
  // a real folder picker (knowledge base, projects)
  ipcMain.handle('jarvis:pick-folder', async (e, title) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: String(title || 'انتخاب پوشه').slice(0, 80), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('jarvis:displays', () => {
    const { screen } = require('electron'), prim = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({ id: d.id, label: d.label || `صفحه‌ی ${i + 1}`, primary: d.id === prim, w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) }));
  });
  ipcMain.on('jarvis:stage', (e, o) => {
    if (!win || e.sender !== win.webContents) return;
    if (o.action === 'close') { if (stageWin) stageWin.close(); return; }
    const { screen } = require('electron'), all = screen.getAllDisplays();
    const d = all.find(x => x.id === o.displayId) || all.find(x => x.id !== screen.getPrimaryDisplay().id) || all[0];
    if (stageWin) { stageWin.setFullScreen(false); stageWin.setBounds(d.bounds); stageWin.setFullScreen(true); stageWin.focus(); return; }
    stageWin = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, fullscreen: true, backgroundColor: '#020A12', title: 'JARVIS', show: false, autoHideMenuBar: true,
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    stageWin.loadURL(`${serverOrigin}/stage.html`);
    stageWin.once('ready-to-show', () => { stageWin.show(); stageState(); });
    stageWin.on('closed', () => { stageWin = null; stageState(); });
    win.once('closed', () => { if (stageWin && !stageWin.isDestroyed()) stageWin.close(); });
  });
  ipcMain.on('jarvis:stage-frame', (e, f) => {
    if (!stageWin || stageWin.isDestroyed() || !win || e.sender !== win.webContents || !f || typeof f !== 'object') return;
    stageWin.webContents.send('jarvis:stage-frame', f);
  });
  ipcMain.on('jarvis:stage-input', (e, a) => {
    if (!stageWin || e.sender !== stageWin.webContents) return;
    if (a === 'close') stageWin.close();
    else if (win && !win.isDestroyed()) win.webContents.send('jarvis:stage', { type: 'talk' });
  });

  app.on('second-instance', () => showWin());
  app.on('window-all-closed', () => { if (!tray || quitting) app.quit(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(start).catch(err => {
    log('startup failed', err && err.stack || err);
    dialog.showErrorBox('JARVIS', `برنامه اجرا نشد.\n\n${err && err.message || err}\n\nجزئیات: ${logFile}`);
    app.quit();
  });
}
