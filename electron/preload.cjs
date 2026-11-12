const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const listener = () => fn();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const onText = (channel) => (fn) => {
  const listener = (_e, text) => fn(text);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('listny', {
  // pill
  onStart: on('rec:start'),
  onStop: on('rec:stop'),
  onCancel: on('rec:cancel'),
  pillReady: () => ipcRenderer.send('pill:ready'),
  processAudio: (payload) => ipcRenderer.invoke('audio:process', payload),
  transcribePiece: (audio) => ipcRenderer.invoke('audio:piece', audio),
  getPillSettings: () => ipcRenderer.invoke('pill:settings'),
  sendPcm: (pcm) => ipcRenderer.send('rec:pcm', pcm),
  micLive: (timing) => ipcRenderer.send('rec:mic-live', timing),
  onPartial: onText('live:partial'),
  onCommitted: onText('live:committed'),
  recordingFailed: (message) => ipcRenderer.send('rec:failed', message),
  discardRecording: () => ipcRenderer.send('rec:discard'),
  // hub
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  onSettingsChanged: on('settings:changed'),
  captureHotkey: (capturing) => ipcRenderer.send('hotkey:capture', capturing),
  setKey: (provider, value) => ipcRenderer.invoke('key:set', { provider, value }),
  getHistory: () => ipcRenderer.invoke('history:get'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  retry: (id) => ipcRenderer.invoke('history:retry', id),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  onHistoryChanged: on('history:changed'),
});
