import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const trustedKey = utils.generateKeyPairSync("ecdsa", { bits: 256 });
const otherKey = utils.generateKeyPairSync("ecdsa", { bits: 256 });
const fingerprint = (key) => "SHA256:" + createHash("sha256")
  .update(Buffer.from(key.public.split(" ")[1], "base64"))
  .digest("base64").replace(/=+$/, "");

async function localSSH(t, key) {
  const clients = new Set();
  const observed = { connections: 0, authentications: 0 };
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    observed.connections += 1;
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      observed.authentications += 1;
      if (ctx.method === "password" && ctx.password === "test-password") ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (accept) => {
        const stream = accept();
        stream.write("pin-ok\n");
        stream.exit(0);
        stream.end();
      });
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, observed };
}

const clientScript = `
  const ssh = await import('./build/ssh.js');
  const results = [];
  for (const opts of JSON.parse(process.env.SSH_TEST_CONNECTIONS)) {
    try {
      const connection = await ssh.connect({
        host: '127.0.0.1', username: 'test-user', password: 'test-password', ...opts,
      });
      const output = await ssh.exec(connection.connectionId, 'echo pin-ok', 2000);
      results.push({ connected: true, host: connection.host, port: connection.port, stdout: output.stdout });
    } catch (error) {
      results.push({ connected: false, error: error.message });
    }
  }
  await ssh.disconnect();
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
`;

async function runClient(connections, env = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", clientScript], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SSH_MCP_ALLOWED_HOSTS: "",
      SSH_MCP_HOST_KEY_PINS: "",
      SSH_MCP_STRICT_HOST_CHECK: "false",
      SSH_TEST_CONNECTIONS: JSON.stringify(connections),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill(), 8000);
  const [code] = await once(child, "close").finally(() => clearTimeout(timeout));
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test("strict checking rejects a substituted host key before authentication, then recovers", async (t) => {
  const substituted = await localSSH(t, otherKey);
  const trusted = await localSSH(t, trustedKey);
  const results = await runClient([{ port: substituted.port }, { port: trusted.port }], {
    SSH_MCP_STRICT_HOST_CHECK: "true",
    SSH_MCP_HOST_KEY_PINS: JSON.stringify({
      [`127.0.0.1:${substituted.port}`]: [fingerprint(trustedKey)],
      [`127.0.0.1:${trusted.port}`]: [fingerprint(trustedKey)],
    }),
  });
  assert.equal(results[0].connected, false, "a substituted SSH host key was accepted");
  assert.match(results[0].error, /host.*verif/i);
  assert.equal(substituted.observed.authentications, 0, "credentials reached an untrusted server");
  assert.equal(results[1].connected, true);
  assert.equal(results[1].stdout, "pin-ok");
  assert.ok(trusted.observed.authentications > 0);
});

test("strict checking without a pin rejects before opening a connection", async (t) => {
  const server = await localSSH(t, trustedKey);
  const [result] = await runClient([{ port: server.port }], { SSH_MCP_STRICT_HOST_CHECK: "true" });
  assert.equal(result.connected, false);
  assert.match(result.error, /SSH_MCP_HOST_KEY_PINS/);
  assert.equal(server.observed.connections, 0);
});

test("pins are scoped to the exact host and port", async (t) => {
  const server = await localSSH(t, trustedKey);
  const [result] = await runClient([{ port: server.port }], {
    SSH_MCP_STRICT_HOST_CHECK: "true",
    SSH_MCP_HOST_KEY_PINS: JSON.stringify({ "127.0.0.1:22": [fingerprint(trustedKey)] }),
  });
  assert.equal(result.connected, false);
  assert.equal(server.observed.connections, 0);
});

test("explicit pins remain enforced when strict checking is false", async (t) => {
  const server = await localSSH(t, otherKey);
  const [result] = await runClient([{ port: server.port }], {
    SSH_MCP_HOST_KEY_PINS: JSON.stringify({ [`127.0.0.1:${server.port}`]: fingerprint(trustedKey) }),
  });
  assert.equal(result.connected, false);
  assert.equal(server.observed.authentications, 0);
});

test("multiple trusted pins support key rotation and named connections reuse the same target", async (t) => {
  const server = await localSSH(t, trustedKey);
  const results = await runClient([{ port: server.port, name: "trusted" }, { port: server.port, name: "trusted" }], {
    SSH_MCP_STRICT_HOST_CHECK: "true",
    SSH_MCP_HOST_KEY_PINS: JSON.stringify({
      [`127.0.0.1:${server.port}`]: [fingerprint(otherKey), fingerprint(trustedKey)],
    }),
  });
  assert.equal(results.every((result) => result.connected && result.stdout === "pin-ok"), true);
  assert.equal(server.observed.connections, 1);
});

test("reusing a name cannot substitute a different pinned target", async (t) => {
  const first = await localSSH(t, trustedKey);
  const second = await localSSH(t, otherKey);
  const results = await runClient([{ port: first.port, name: "shared" }, { port: second.port, name: "shared" }], {
    SSH_MCP_STRICT_HOST_CHECK: "true",
    SSH_MCP_HOST_KEY_PINS: JSON.stringify({
      [`127.0.0.1:${first.port}`]: [fingerprint(trustedKey)],
      [`127.0.0.1:${second.port}`]: [fingerprint(otherKey)],
    }),
  });
  assert.equal(results[0].connected, true);
  assert.equal(results[1].connected, false);
  assert.match(results[1].error, /different SSH target/);
});

test("legacy connections without strict checking or pins remain compatible", async (t) => {
  const server = await localSSH(t, trustedKey);
  const [result] = await runClient([{ port: server.port }]);
  assert.equal(result.connected, true);
  assert.equal(result.stdout, "pin-ok");
});

test("malformed pin configuration stops startup before authentication", async (t) => {
  const server = await localSSH(t, trustedKey);
  await assert.rejects(runClient([{ port: server.port }], {
    SSH_MCP_HOST_KEY_PINS: "invalid-pin-configuration",
  }), /SSH_MCP_HOST_KEY_PINS/);
  assert.equal(server.observed.connections, 0);
});
