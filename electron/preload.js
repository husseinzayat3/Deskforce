// The only things the page may ask the desktop shell to do.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openProject: project => ipcRenderer.invoke('open-project', project),
});
