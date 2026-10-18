import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

test("MCP server exits cleanly when parent closes stdin pipe", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["./build/index.js"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait until the server announces readiness on stderr
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for server startup")), 3000);
    child.stderr.on("data", (chunk) => {
      if (chunk.toString().includes("SSH MCP server running")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  // Simulate parent MCP client disconnecting / closing stdio pipes
  child.stdin.end();
  child.stdout.destroy();
  child.stderr.destroy();

  const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
  const [code, signal] = await once(child, "close").finally(() => clearTimeout(killTimer));
  assert.equal(signal, null, "Server should exit on its own without SIGKILL");
  assert.equal(code, 0);
});

test("uncaughtException with closed stderr pipe does not cause EPIPE infinite loop", { timeout: 5000 }, async () => {
  const script = `
    await import('./build/ssh.js');
    process.stderr.write('Ready\\n');
    setTimeout(() => {
      Promise.reject(new Error('synthetic unhandled rejection after stderr closed'));
    }, 100);
    setTimeout(() => {
      process.exit(0);
    }, 300);
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });

  await once(child.stderr, "data");
  // Close parent's read end of stderr so writes to stderr inside child would EPIPE
  child.stderr.destroy();

  const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
  const [code, signal] = await once(child, "close").finally(() => clearTimeout(killTimer));
  assert.equal(signal, null, "Process should not hang or loop on broken stderr");
  assert.equal(code, 0);
});
