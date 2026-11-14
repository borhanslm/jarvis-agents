// Minimal, explicit bridge between the panel and the desktop shell.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  isDesktop: true,
  setTheme: theme => ipcRenderer.send('jarvis:set-theme', ['light', 'system'].includes(theme) ? theme : 'dark'),
  applySettings: () => ipcRenderer.send('jarvis:desktop-settings'),
  appInfo: () => ipcRenderer.invoke('jarvis:app-info'),
  updateAction: a => ipcRenderer.send('jarvis:update', a === 'install' ? 'install' : 'check'),
  onUpdate: cb => ipcRenderer.on('jarvis:update-state', (_e, s) => cb(s || {})),
  // custom title bar
  minimize: () => ipcRenderer.send('jarvis:win', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('jarvis:win', 'toggle-max'),
  close: () => ipcRenderer.send('jarvis:win', 'close'),
  windowState: () => ipcRenderer.invoke('jarvis:win-state'),
  onWindowState: cb => ipcRenderer.on('jarvis:win-state', (_e, s) => cb({ maximized: !!(s && s.maximized) })),
});
