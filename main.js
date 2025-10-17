// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 900,
    webPreferences: {
      nodeIntegration: true,      // matches the renderer code below
      contextIsolation: false
    },
    autoHideMenuBar: true,
    title: 'Image Compressor'
  });

  mainWindow.loadFile('index.html');
}

function setupHandlers() {
  ipcMain.removeHandler('select-file');
  ipcMain.removeHandler('compress-image');
  ipcMain.removeHandler('save-compressed');

  // 1) Pick input file
  ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  // 2) Compress to a TEMP preview file (no Save dialog yet)
  ipcMain.handle('compress-image', async (event, inputPath, quality, format) => {
    return new Promise(async (resolve, reject) => {
      try {
        // Build temp output path
        const tmpDir = os.tmpdir();
        const tmpName = `${path.basename(inputPath, path.extname(inputPath))}_preview.${format}`;
        const tempOutput = path.join(tmpDir, tmpName);

        // Find compress.exe (dev vs packaged)
        let compressorPath = app.isPackaged
          ? path.join(process.resourcesPath, 'compress.exe')
          : path.join(__dirname, 'compress.exe');

        if (!fs.existsSync(compressorPath)) {
          const alt = [
            path.join(__dirname, 'compress.exe'),
            path.join(process.resourcesPath, 'compress.exe'),
            path.join(path.dirname(process.execPath), 'compress.exe'),
            path.join(path.dirname(process.execPath), 'resources', 'compress.exe'),
            path.join(path.dirname(process.execPath), 'resources', 'app.asar.unpacked', 'compress.exe'),
          ].find(p => fs.existsSync(p));
          if (alt) compressorPath = alt;
        }

        if (!fs.existsSync(compressorPath)) {
          return reject({
            success: false,
            error: 'compress.exe not found in expected locations.'
          });
        }

        // Spawn compressor: <input> <output> <quality in [0,1]>
        const child = spawn(compressorPath, [inputPath, tempOutput, quality.toString()]);
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => {
          const t = d.toString();
          stdout += t;
          event.sender.send('compression-progress', t);
        });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('close', (code) => {
          if (code !== 0) {
            return reject({
              success: false,
              error: stderr || `Compression failed (exit ${code})`,
              log: stdout
            });
          }

          try {
            const inputSize = fs.statSync(inputPath).size;
            const outputSize = fs.statSync(tempOutput).size;
            resolve({
              success: true,
              tempOutput,
              inputSize,
              outputSize,
              log: stdout
            });
          } catch (err) {
            reject({
              success: false,
              error: 'Output file not created: ' + err.message,
              log: stdout
            });
          }
        });

        child.on('error', (err) => {
          reject({ success: false, error: 'Failed to start compress.exe: ' + err.message });
        });
      } catch (e) {
        reject({ success: false, error: e.message || String(e) });
      }
    });
  });

  // 3) If user clicks Save, open Save As… and copy the preview file
  ipcMain.handle('save-compressed', async (event, tempPath, suggestedName, format) => {
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save compressed image as…',
        defaultPath: path.join(app.getPath('pictures'), suggestedName || path.basename(tempPath)),
        filters: [{ name: 'Images', extensions: [format] }]
      });
      if (canceled || !filePath) return { success: false, canceled: true };

      fs.copyFileSync(tempPath, filePath);
      return { success: true, savedPath: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

app.whenReady().then(() => {
  setupHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
