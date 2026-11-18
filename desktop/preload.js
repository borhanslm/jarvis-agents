// Minimal, explicit bridge between the panel and the desktop shell.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  isDesktop: true,
  setTheme: theme => ipcRenderer.send('jarvis:set-theme', ['light', 'system'].includes(theme) ? theme : 'dark'),
  applySettings: () => ipcRenderer.send('jarvis:desktop-settings'),
  appInfo: () => ipcRenderer.invoke('jarvis:app-info'),
  updateAction: a => ipcRenderer.send('jarvis:update', ['install', 'now'].includes(a) ? a : 'check'),
  onUpdate: cb => ipcRenderer.on('jarvis:update-state', (_e, s) => cb(s || {})),
  // voice assistant state / spoken reply (tray tooltip + notification while the window is hidden)
  voice: ev => ipcRenderer.send('jarvis:voice', { state: String(ev && ev.state || ''), label: String(ev && ev.label || '').slice(0, 80), reply: ev && ev.reply ? String(ev.reply).slice(0, 400) : '' }),
  // custom title bar
  minimize: () => ipcRenderer.send('jarvis:win', 'minimize'),
  pickFolder: title => ipcRenderer.invoke('jarvis:pick-folder', title),
  toggleMaximize: () => ipcRenderer.send('jarvis:win', 'toggle-max'),
  toggleFullscreen: () => ipcRenderer.send('jarvis:win', 'toggle-full'),
  close: () => ipcRenderer.send('jarvis:win', 'close'),
  windowState: () => ipcRenderer.invoke('jarvis:win-state'),
  onVisible: cb => ipcRenderer.on('jarvis:visible', (_e, v) => cb(!!v)),
  onWindowState: cb => ipcRenderer.on('jarvis:win-state', (_e, s) => cb({ maximized: !!(s && s.maximized), fullscreen: !!(s && s.fullscreen) })),
  // JARVIS on a TV / second monitor ("stage"): a draw-only full-screen window on another display
  displays: () => ipcRenderer.invoke('jarvis:displays'),
  stage: o => ipcRenderer.send('jarvis:stage', { action: o && o.action === 'close' ? 'close' : 'open', displayId: Number(o && o.displayId) || 0 }),
  stageFrame: f => ipcRenderer.send('jarvis:stage-frame', f),
  onStage: cb => ipcRenderer.on('jarvis:stage', (_e, ev) => cb(ev || {})),
  onStageFrame: cb => ipcRenderer.on('jarvis:stage-frame', (_e, f) => cb(f || {})),
  stageInput: a => ipcRenderer.send('jarvis:stage-input', a === 'close' ? 'close' : 'talk'),
});
