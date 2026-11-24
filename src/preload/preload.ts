import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LonghandApi } from '../shared/types';

function on<T>(channel: string) {
  return (cb: (p: T) => void) => {
    const fn = (_e: IpcRendererEvent, p: T) => cb(p);
    ipcRenderer.on(channel, fn);
    return () => {
      ipcRenderer.off(channel, fn);
    };
  };
}

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api: LonghandApi = {
  getSnapshot: invoke('getSnapshot') as LonghandApi['getSnapshot'],
  onSnapshot: on('snapshot'),
  updateSettings: invoke('updateSettings') as LonghandApi['updateSettings'],
  setApiKey: invoke('setApiKey') as LonghandApi['setApiKey'],
  updateCustomizations: invoke('updateCustomizations') as LonghandApi['updateCustomizations'],
  openExternal: invoke('openExternal') as LonghandApi['openExternal'],
  requestPermission: invoke('requestPermission') as LonghandApi['requestPermission'],
  refreshPermissions: invoke('refreshPermissions') as LonghandApi['refreshPermissions'],

  listHistory: invoke('listHistory') as LonghandApi['listHistory'],
  deleteHistory: invoke('deleteHistory') as LonghandApi['deleteHistory'],
  clearHistory: invoke('clearHistory') as LonghandApi['clearHistory'],
  copyText: invoke('copyText') as LonghandApi['copyText'],
  readAudio: invoke('readAudio') as LonghandApi['readAudio'],
  saveAudioAs: invoke('saveAudioAs') as LonghandApi['saveAudioAs'],
  onHistoryChanged: on('history-changed'),
  redoHistory: invoke('redoHistory') as LonghandApi['redoHistory'],
  editHistory: invoke('editHistory') as LonghandApi['editHistory'],

  testLlm: invoke('testLlm') as LonghandApi['testLlm'],
  testAsr: invoke('testAsr') as LonghandApi['testAsr'],
  restartAsr: invoke('restartAsr') as LonghandApi['restartAsr'],
  downloadModel: invoke('downloadModel') as LonghandApi['downloadModel'],
  cancelModelDownload: invoke('cancelModelDownload') as LonghandApi['cancelModelDownload'],
  importModel: invoke('importModel') as LonghandApi['importModel'],
  importConnection: invoke('importConnection') as LonghandApi['importConnection'],
  exportConnection: invoke('exportConnection') as LonghandApi['exportConnection'],

  recordShortcut: invoke('recordShortcut') as LonghandApi['recordShortcut'],
  onShortcutKeys: on('shortcut-keys'),
  onHotkeyTest: on('hotkey-test'),
  hotkeyTest: invoke('hotkeyTest') as LonghandApi['hotkeyTest'],

  listMicrophones: invoke('listMicrophones') as LonghandApi['listMicrophones'],
  testMicrophone: invoke('testMicrophone') as LonghandApi['testMicrophone'],
  onMicLevel: on('mic-level'),

  undoLearnedWord: invoke('undoLearnedWord') as LonghandApi['undoLearnedWord'],

  onFloaterState: on('floater:state'),
  onLevel: on('floater:level'),
  onHud: on('floater:hud'),
  onHudDismiss: on('floater:hud-dismiss'),
  onPlaySound: on('floater:sound'),
  floaterAction: (action, arg) => ipcRenderer.send('floaterAction', action, arg),
  setMouseInteractive: (interactive) => ipcRenderer.send('setMouseInteractive', interactive),
  hudMute: (key) => ipcRenderer.send('hudMute', key),

  onNavigate: on('nav'),
  completeOnboarding: invoke('completeOnboarding') as LonghandApi['completeOnboarding'],
};

contextBridge.exposeInMainWorld('longhand', api);
