import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

// Every fixture uses fresh loopback SSH/TCP servers and synthetic credentials.
// The child must exit normally, preserve a second SSH session, and never need
// the global uncaught-error fallback to survive refused/reset forwarded sockets.
const script = `
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import ssh2 from 'ssh2';
const ssh = await import(process.env.SSH_MCP_TEST_MODULE || './build/ssh.js');
async function main() {
const key = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
const peers = [];
let unforwarded = 0;
const server = new ssh2.Server({ hostKeys: [key.private] }, client => {
  peers.push(client);
  client.on('error', () => {});
  client.on('authentication', context => context.accept());
  client.on('ready', () => {
    client.on('session', accept => {
      const session = accept();
      session.on('exec', accept => {
        const stream = accept(); stream.write('still-alive'); stream.exit(0); stream.end();
      });
    });
    client.on('tcpip', accept => {
      const stream = accept();
      stream.on('error', () => {});
      stream.write('tunnel-open');
    });
    client.on('request', (accept, reject, name) => {
      if (name === 'tcpip-forward') accept();
      else if (name === 'cancel-tcpip-forward') { unforwarded++; accept(); }
      else reject();
    });
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const options = {host:'127.0.0.1', port:server.address().port, username:'test', password:'synthetic'};
const first = await ssh.connect({...options, name:'forward'});
const second = await ssh.connect({...options, name:'other'});
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const closedPort = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const mode = process.env.SSH_TEST_FORWARD_TYPE;
const type = mode === 'remote' ? 'remote' : 'local';
const bindPort = type === 'remote' ? 35479 : closedPort;
let acceptedSocket, acceptedChannel;
const originalCreateServer = net.createServer;
const entry = ssh.getConnection(first.connectionId);
const originalForwardOut = entry.client.forwardOut;
if (type === 'local') {
  net.createServer = (listener) => originalCreateServer(socket => {
    acceptedSocket = socket;
    listener(socket);
  });
  entry.client.forwardOut = function (...args) {
    const callback = args.pop();
    return originalForwardOut.call(this, ...args, (err, stream) => {
      callback(err, stream);
      acceptedChannel = stream;
    });
  };
}
try {
  await ssh.portForward({connectionId:first.connectionId, type, bindAddr:'127.0.0.1', bindPort, destAddr:'127.0.0.1', destPort:closedPort});
} finally {
  net.createServer = originalCreateServer;
}
if (type === 'remote') {
  const err = await new Promise(resolve => peers[0].forwardOut('127.0.0.1', bindPort, '127.0.0.1', 12345, (err, stream) => {
    if (err) resolve(err);
    else {
      stream.on('error', () => {});
      stream.on('close', () => resolve(undefined));
    }
  }));
  assert.ok(err, 'closed local destination did not reject remote channel');
} else {
  const socket = net.createConnection(bindPort, '127.0.0.1');
  socket.on('error', () => {});
  const closed = once(socket, 'close');
  const marker = await new Promise(resolve => {
    let received = '';
    socket.on('data', chunk => {
      received += chunk.toString();
      if (received.length >= 'tunnel-open'.length) resolve(received);
    });
  });
  assert.equal(marker, 'tunnel-open');
  const target = mode === 'local-channel' ? acceptedChannel : acceptedSocket;
  assert.ok(target, 'the forwarding endpoint was not accepted');
  target.emit('error', Object.assign(new Error('synthetic forwarded reset'), { code: 'ECONNRESET' }));
  await closed;
  entry.client.forwardOut = originalForwardOut;
}
assert.equal((await ssh.exec(first.connectionId, 'echo still-alive', 2000)).stdout, 'still-alive');
const result = await ssh.exec(second.connectionId, 'echo still-alive', 2000);
assert.equal(result.stdout, 'still-alive');
await ssh.disconnect(first.connectionId);
if (type === 'remote') {
  for (let i=0; i<20 && !unforwarded; i++) await new Promise(resolve=>setTimeout(resolve, 10));
  assert.equal(unforwarded, 1, 'remote listener was not cancelled');
}
assert.equal((await ssh.exec(second.connectionId, 'echo still-alive', 2000)).stdout, 'still-alive');
await ssh.disconnect();
for (const peer of peers) peer.end();
server.close();
process.stdout.write(JSON.stringify({mode, preservedOtherSession:true, unforwarded}));
process.exit(0);
}
await main().catch(error => { console.error(error.stack); process.exit(1); });
`;

for (const type of ["remote", "local-socket", "local-channel"]) {
  test(`${type} forwarding error preserves SSH sessions without uncaught errors`, { timeout: 10000 }, async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH, SSH_TEST_FORWARD_TYPE: type, SSH_MCP_ALLOWED_HOSTS: "127.0.0.1", SSH_MCP_STRICT_HOST_CHECK: "false", ...(process.env.SSH_MCP_TEST_MODULE ? {SSH_MCP_TEST_MODULE:process.env.SSH_MCP_TEST_MODULE} : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    const [code] = await once(child, "close").finally(() => clearTimeout(timer));
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /uncaught|unhandled/i);
    assert.equal(JSON.parse(stdout).preservedOtherSession, true);
  });
}
