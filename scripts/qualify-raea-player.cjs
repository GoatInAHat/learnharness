const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { desktopAPIHeaders } = require('../electron/desktop-api.cjs');

const origin = process.env.LH_VIDEO_TEST_ORIGIN;
const capability = process.env.LH_VIDEO_TEST_CAPABILITY;
const profile = join(process.env.LH_VIDEO_TEST_PROFILE, 'electron');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ requestHeaders: desktopAPIHeaders(details, origin, capability, [win]) });
  });
  await win.loadURL(origin);
  const outcome = await win.webContents.executeJavaScript(`(async () => {
    const video = document.getElementById('media');
    const wait = event => new Promise((resolve, reject) => {
      video.addEventListener(event, resolve, { once: true });
      video.addEventListener('error', () => reject(Error('Media error ' + video.error?.code)), { once: true });
      setTimeout(() => reject(Error('Timed out waiting for ' + event)), 5000);
    });
    if (video.readyState < 1) await wait('loadedmetadata');
    const seek = wait('seeked');
    video.currentTime = 3;
    await seek;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0);
    const pixels = context.getImageData(129, 195, 175, 49).data;
    let lightPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 205 && pixels[i + 1] > 205 && pixels[i + 2] > 205 && pixels[i + 3] === 255) lightPixels++;
    }
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, seek: video.currentTime, lightPixels };
  })()`);
  assert(Math.abs(outcome.duration - 4) < 0.05, `unexpected duration ${outcome.duration}`);
  assert.equal(outcome.width, 896);
  assert.equal(outcome.height, 504);
  assert(Math.abs(outcome.seek - 3) < 0.05, `unexpected seek position ${outcome.seek}`);
  assert(outcome.lightPixels > 8, 'the diagram label did not render above its shape');
  console.log(JSON.stringify(outcome));
  app.exit(0);
}

run().catch(error => {
  console.error(error);
  app.exit(1);
});
