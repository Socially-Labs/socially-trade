import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import { createApp } from '../dist/app.js';

test('API closes without waiting for a suspended WebSocket client handshake', async () => {
  const previous = process.env.USDG_MINT;
  delete process.env.USDG_MINT;
  const app = createApp(null);
  let socket;
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address();
    socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /v1/vaults/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    const [handshake] = await once(socket, 'data');
    assert.match(handshake.toString(), /101 Switching Protocols/);
    // Raw TCP never acknowledges WebSocket close, like a suspended phone.
    await Promise.race([app.close(), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('shutdown stalled')), 1500);
      timer.unref();
    })]);
    assert.equal(app.server.listening, false);
  } finally {
    socket?.destroy();
    await app.close();
    if (previous === undefined) delete process.env.USDG_MINT;
    else process.env.USDG_MINT = previous;
  }
});

test('watch child exits within deadline even if a cleanup hook never settles', { timeout: 3000 }, async t => {
  const source = `import { installShutdown } from ${JSON.stringify(new URL('../dist/shutdown.js', import.meta.url).href)};
    installShutdown(() => new Promise(() => {}), 80);
    setInterval(() => {}, 1000); console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  try {
    await once(child.stdout, 'data');
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 1);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});
