#!/usr/bin/env node
/**
 * Stand-in for `codex app-server`.
 *
 * Speaks the same newline-delimited JSON-RPC dialect so the adapter's handshake
 * and process lifecycle are exercised for real — spawn, initialize, initialized,
 * request, and reap — without depending on a logged-in Codex CLI.
 *
 * Behaviour is selected by AUD_FAKE_MODE:
 *   ok            answer normally from AUD_FAKE_PAYLOAD
 *   slow          never answer the rateLimits request (timeout path)
 *   rpc-error     answer with a JSON-RPC error object
 *   crash         exit immediately after initialize
 *   garbage       emit non-JSON lines before the real answer
 *   no-initialize refuse to answer until `initialized` has been received
 */
import { readFileSync } from 'node:fs';

const mode = process.env.AUD_FAKE_MODE ?? 'ok';
const payload = process.env.AUD_FAKE_PAYLOAD
  ? JSON.parse(readFileSync(process.env.AUD_FAKE_PAYLOAD, 'utf8'))
  : { rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } } };

let initializedReceived = false;
let buffer = '';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.method === 'initialized') {
      initializedReceived = true;
      continue;
    }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          userAgent: 'fake/9.8.7 (test)',
          codexHome: '/tmp/fake',
          platformOs: 'linux',
          platformFamily: 'unix',
        },
      });
      if (mode === 'crash') process.exit(3);
      // An unsolicited notification: the client must ignore it, not mistake it
      // for a response.
      send({ jsonrpc: '2.0', method: 'account/rateLimitsUpdated', params: {} });
      continue;
    }

    if (msg.method === 'account/rateLimits/read') {
      if (mode === 'slow') continue;
      if (mode === 'no-initialize' && !initializedReceived) continue;
      if (mode === 'garbage') {
        process.stdout.write('this is not json\n');
        process.stdout.write('{"partial": \n');
      }
      if (mode === 'rpc-error') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'account not found for user@example.com' },
        });
        continue;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: payload });
    }
  }
});

// Keep the process alive until killed.
setInterval(() => {}, 1 << 30);
