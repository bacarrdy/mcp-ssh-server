import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const hostKey = utils.generateKeyPairSync("ecdsa", { bits: 256 });
const fingerprint = "SHA256:" + createHash("sha256")
  .update(Buffer.from(hostKey.public.split(" ")[1], "base64")).digest("base64").replace(/=+$/, "");

// With an authenticated SSH session the process has live sockets and the idle
// timer, so it does not exit by itself when stdin ends: this is the case a
// no-session test cannot see.
test("closing the client's stdio ends the process and its authenticated SSH session", { timeout: 20000 }, async (t) => {
  const sessions = new Set();
  const fixture = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === "fixture-password" ? ctx.accept() : ctx.reject()));
    client.on("ready", () => sessions.add(client));
    client.on("close", () => sessions.delete(client));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const port = fixture.address().port;
  t.after(async () => {
    for (const client of sessions) client.end();
    await new Promise((resolve) => fixture.close(resolve));
  });

  const child = spawn(process.execPath, ["./build/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SSH_MCP_ALLOWED_HOSTS: "127.0.0.1",
      SSH_MCP_STRICT_HOST_CHECK: "true",
      SSH_MCP_HOST_KEY_PINS: JSON.stringify({ [`127.0.0.1:${port}`]: [fingerprint] }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  child.stderr.on("data", () => {});

  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message); waiting.delete(message.id);
    }
  });
  const request = (id, method, params) => new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const connected = await request(2, "tools/call", { name: "ssh_connect", arguments: { host: "127.0.0.1", port, username: "fixture", password: "fixture-password" } });
  assert.equal(connected.result?.isError ?? false, false, JSON.stringify(connected));
  assert.equal(sessions.size, 1, "the SSH session is authenticated before the client goes away");

  const started = Date.now();
  child.stdin.end();
  child.stdout.destroy();
  child.stderr.destroy();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const [code, signal] = await once(child, "close").finally(() => clearTimeout(killTimer));
  assert.equal(signal, null, "the server had to be killed: it kept running after its client closed stdio");
  assert.equal(code, 0);
  for (let i = 0; i < 40 && sessions.size > 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sessions.size, 0, "the authenticated SSH session is still open after the server exited");
  assert.ok(Date.now() - started < 5000);
});

// The client dies without closing the pipes (they stay open in another process):
// the server is re-parented (to PID 1 or to a subreaper such as systemd --user)
// and must notice that its parent is gone.
test("the server exits when its parent dies while the pipes stay open", { timeout: 30000 }, async (t) => {
  const launcher = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const server = spawn(process.execPath, ["./build/index.js"], { stdio: "inherit" });
    process.stderr.write("SERVER_PID " + server.pid + "\\n");
    setInterval(() => {}, 1000);
  `], { cwd: new URL("..", import.meta.url), stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  const pid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("launcher did not start the server: " + stderr)), 10000);
    launcher.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /SERVER_PID (\d+)/.exec(stderr);
      if (match && stderr.includes("SSH MCP server running")) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { if (alive()) process.kill(pid, "SIGKILL"); launcher.stdin.destroy(); launcher.stdout.destroy(); launcher.stderr.destroy(); });
  launcher.kill("SIGKILL"); // the pipes stay open: this test process still holds their other ends
  await once(launcher, "exit");
  for (let i = 0; i < 100 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false, "the orphaned server is still running");
});
