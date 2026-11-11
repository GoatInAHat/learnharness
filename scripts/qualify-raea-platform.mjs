import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const profile = mkdtempSync(join(tmpdir(), 'learnharness raea smoke '));
process.env.LH_DATA_DIR = join(profile, 'data');
process.env.LH_AUTH_FILE = join(profile, 'auth.json');
const { stores } = await import('../src/server/stores.ts');
const { runtimeInstalled, videoIsLive, cancelVideo } = await import('../src/server/video/render.ts');
const { GET, POST } = await import('../app/api/video/route.ts');
const require = createRequire(import.meta.url);
const electron = require('electron');

const title = 'Search a sorted list';
const makeScene = (heading, caption, x) => ({
  heading, caption, seconds: 2,
  elements: [
    { kind: 'text', x: x + 0.025, y: 0.355, width: 0.2, height: 0.16, color: 'white', text: 'midpoint' },
    { kind: 'rect', x, y: 0.33, width: 0.25, height: 0.19, color: 'blue' },
  ],
});
const input = { title, scenes: [
  makeScene('Start in the middle', 'Compare the target with the midpoint.', 0.39),
  makeScene('Discard half', 'Repeat the comparison in the remaining half.', 0.13),
] };
const chat = stores.chatStore.createChat(title);
const job = stores.jobStore.createJob({ kind: 'video', chatId: chat.id, toolCallId: 'qualification', input });
stores.jobStore.updateJob(job.id, { status: 'done', activity: 'ready to render' });
const api = `/api/video?id=${encodeURIComponent(job.id)}&chatId=${encodeURIComponent(chat.id)}`;
const media = `${api}&media=1`;
const testOrigin = 'http://localhost';
const post = download => POST(new Request(`${testOrigin}${api}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ download }),
}));

async function finishRender() {
  let activity;
  const deadline = Date.now() + 11 * 60 * 1000;
  while (Date.now() < deadline) {
    const record = stores.jobStore.getJob(job.id);
    assert(record, 'video job disappeared');
    if (record.activity !== activity) {
      activity = record.activity;
      console.log(activity);
    }
    if (record.status === 'done' && record.result?.video) return;
    if (record.status === 'error') throw new Error(record.error || 'Video job failed');
    await pause(500);
  }
  throw new Error('Timed out waiting for the renderer');
}

async function testPlayback() {
  // Use the app route and desktop request guard while keeping the test profile disposable.
  const capability = '1'.repeat(64);
  const rangeRequests = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><video id="media" controls muted preload="metadata" src="${media.replaceAll('&', '&amp;')}"></video>`);
        return;
      }
      if (req.url !== media || req.headers['x-learnharness-desktop'] !== capability) {
        res.writeHead(403).end();
        return;
      }
      const range = req.headers.range;
      if (range) rangeRequests.push(range);
      const response = await GET(new Request(`${testOrigin}${req.url}`, { headers: range ? { range } : undefined }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { res.end(); return; }
      const body = Readable.fromWeb(response.body);
      res.once('close', () => body.destroy());
      body.on('error', error => res.destroy(error));
      body.pipe(res);
    } catch (error) {
      res.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const script = fileURLToPath(new URL('./qualify-raea-player.cjs', import.meta.url));
    const args = process.platform === 'linux' ? ['--no-sandbox', script] : [script];
    await new Promise((resolve, reject) => {
      const child = spawn(electron, args, {
        stdio: 'inherit',
        env: { ...process.env, LH_VIDEO_TEST_ORIGIN: origin, LH_VIDEO_TEST_CAPABILITY: capability, LH_VIDEO_TEST_PROFILE: profile },
        signal: AbortSignal.timeout(35_000),
      });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Electron playback failed (${code})`)));
    });
    assert(rangeRequests.length > 0, 'Electron did not make a byte range request');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

try {
  assert(!runtimeInstalled(), 'test profile unexpectedly already has Raea');
  const capability = await GET(new Request(`${testOrigin}${api}`));
  assert.equal((await capability.json()).supported, true, 'platform not enabled');
  assert(!(await post(false)).ok, 'first render must request the download');
  const start = await post(true);
  assert(start.ok, await start.text());
  await finishRender();
  assert(runtimeInstalled(), 'runtime cache missing after render');

  const request = new Request(`${testOrigin}${media}`, { headers: { range: 'bytes=0-31' } });
  const part = await GET(request);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'video/mp4');
  const bytes = Buffer.from(await part.arrayBuffer());
  assert.equal(bytes.length, 32);
  assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
  await testPlayback();
  console.log(`Raea ${process.platform}/${process.arch}: official install, render, byte range, and Electron seek passed.`);
} finally {
  if (videoIsLive(job.id)) {
    cancelVideo(job.id, chat.id);
    for (let i = 0; i < 20 && videoIsLive(job.id); i++) await pause(100);
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
