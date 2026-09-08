/** 预加载脚本：只暴露只读的应用信息，保持 contextIsolation。 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rwpDesktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
