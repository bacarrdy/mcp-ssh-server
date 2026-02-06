import ssh2 from "ssh2";
const { Client } = ssh2;
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectionEntry, ExecResult, ForwardInfo } from "./types.js";
import net from "node:net";

const IDLE_TIMEOUT = parseInt(
  process.env.SSH_MCP_IDLE_TIMEOUT || "1800000",
  10
);
const EXEC_TIMEOUT = parseInt(process.env.SSH_MCP_EXEC_TIMEOUT || "30000", 10);
const ALLOWED_HOSTS = process.env.SSH_MCP_ALLOWED_HOSTS
  ? process.env.SSH_MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim())
  : null;
const STRICT_HOST_CHECK = process.env.SSH_MCP_STRICT_HOST_CHECK === "true";

const connections = new Map<string, ConnectionEntry>();
const forwards = new Map<string, ForwardInfo & { server?: net.Server }>();
let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleTimer() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of connections) {
      if (now - entry.lastUsedAt.getTime() > IDLE_TIMEOUT) {
        entry.client.end();
        connections.delete(id);
      }
    }
    if (connections.size === 0 && idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }, 60000);
}

function resolveKey(keyPath?: string): Buffer | undefined {
  const paths = keyPath
    ? [keyPath]
    : [
        join(homedir(), ".ssh", "id_ed25519"),
        join(homedir(), ".ssh", "id_rsa"),
        join(homedir(), ".ssh", "id_ecdsa"),
      ];
  for (const p of paths) {
    try {
      return readFileSync(p);
    } catch {
      continue;
    }
  }
  return undefined;
}

function makeConnectionId(host: string, port: number, name?: string): string {
  return name || `${host}:${port}`;
}

function checkHost(host: string): void {
  if (!ALLOWED_HOSTS) return;
  const allowed = ALLOWED_HOSTS.some((pattern) => {
    if (pattern.startsWith("*.")) {
      return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
    }
    return host === pattern;
  });
  if (!allowed) {
    throw new Error(
      `Host "${host}" is not in SSH_MCP_ALLOWED_HOSTS. Allowed: ${ALLOWED_HOSTS.join(", ")}`
    );
  }
}

function touch(id: string): ConnectionEntry {
  const entry = connections.get(id);
  if (!entry) throw new Error(`No connection with id "${id}"`);
  entry.lastUsedAt = new Date();
  return entry;
}

export async function connect(opts: {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
  name?: string;
}): Promise<{ connectionId: string; host: string; port: number; username: string }> {
  const host = opts.host;
  const port = opts.port ?? 22;
  const username =
    opts.username || process.env.SSH_MCP_DEFAULT_USERNAME || "root";
  const id = makeConnectionId(host, port, opts.name);

  checkHost(host);

  // Reuse existing live connection
  const existing = connections.get(id);
  if (existing) {
    try {
      // Test if alive
      await exec(id, "echo __alive__", 5000);
      existing.lastUsedAt = new Date();
      return {
        connectionId: id,
        host: existing.host,
        port: existing.port,
        username: existing.username,
      };
    } catch {
      existing.client.end();
      connections.delete(id);
    }
  }

  const client = new Client();

  // Resolve authentication
  let privateKey: Buffer | string | undefined;
  if (opts.privateKey) {
    privateKey = opts.privateKey;
  } else if (opts.privateKeyPath) {
    privateKey = readFileSync(opts.privateKeyPath);
  } else if (!opts.password) {
    const defaultKeyPath = process.env.SSH_MCP_DEFAULT_KEY;
    privateKey = resolveKey(defaultKeyPath);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.end();
      reject(new Error(`Connection to ${host}:${port} timed out after 15s`));
    }, 15000);

    client.on("ready", () => {
      clearTimeout(timeout);
      const entry: ConnectionEntry = {
        client,
        host,
        port,
        username,
        connectedAt: new Date(),
        lastUsedAt: new Date(),
      };
      connections.set(id, entry);
      startIdleTimer();
      resolve({ connectionId: id, host, port, username });
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      connections.delete(id);
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    client.on("end", () => {
      connections.delete(id);
    });

    const config: Record<string, unknown> = {
      host,
      port,
      username,
      readyTimeout: 15000,
    };

    if (privateKey) {
      config.privateKey = privateKey;
      if (opts.passphrase) config.passphrase = opts.passphrase;
    } else if (opts.password) {
      config.password = opts.password;
    } else {
      clearTimeout(timeout);
      reject(
        new Error(
          "No authentication method available. Provide password, privateKey, or privateKeyPath. " +
            "No default SSH key found at ~/.ssh/id_ed25519, ~/.ssh/id_rsa, or ~/.ssh/id_ecdsa."
        )
      );
      return;
    }

    if (!STRICT_HOST_CHECK) {
      config.hostVerifier = () => true;
    }

    client.connect(config as Parameters<typeof client.connect>[0]);
  });
}

export async function disconnect(id?: string): Promise<string[]> {
  const closed: string[] = [];
  if (id) {
    const entry = connections.get(id);
    if (entry) {
      entry.client.end();
      connections.delete(id);
      closed.push(id);
    }
    // Close related forwards
    for (const [fid, fwd] of forwards) {
      if (fwd.connectionId === id) {
        fwd.server?.close();
        forwards.delete(fid);
      }
    }
  } else {
    for (const [cid, entry] of connections) {
      entry.client.end();
      closed.push(cid);
    }
    connections.clear();
    for (const [fid, fwd] of forwards) {
      fwd.server?.close();
      forwards.delete(fid);
    }
    forwards.clear();
  }
  return closed;
}

export function listConnections(): Array<{
  id: string;
  host: string;
  port: number;
  username: string;
  connectedAt: string;
  lastUsedAt: string;
}> {
  return Array.from(connections.entries()).map(([id, entry]) => ({
    id,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    connectedAt: entry.connectedAt.toISOString(),
    lastUsedAt: entry.lastUsedAt.toISOString(),
  }));
}

export async function exec(
  connectionId: string,
  command: string,
  timeout?: number
): Promise<ExecResult> {
  const entry = touch(connectionId);
  const effectiveTimeout = timeout ?? EXEC_TIMEOUT;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Command timed out after ${effectiveTimeout}ms. Command: ${command.slice(0, 100)}`
        )
      );
    }, effectiveTimeout);

    entry.client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(new Error(`Exec failed: ${err.message}`));
        return;
      }

      let stdout = "";
      let stderr = "";

      stream.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        // Trim trailing newlines
        resolve({
          stdout: stdout.replace(/\n$/, ""),
          stderr: stderr.replace(/\n$/, ""),
          exitCode: code ?? 0,
        });
      });

      stream.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`Stream error: ${err.message}`));
      });
    });
  });
}

export async function portForward(opts: {
  connectionId: string;
  type: "local" | "remote";
  bindAddr?: string;
  bindPort: number;
  destAddr: string;
  destPort: number;
}): Promise<ForwardInfo> {
  const entry = touch(opts.connectionId);
  const bindAddr = opts.bindAddr || "127.0.0.1";
  const fwdId = `${opts.type}:${bindAddr}:${opts.bindPort}->${opts.destAddr}:${opts.destPort}`;

  if (forwards.has(fwdId)) {
    throw new Error(`Forward already exists: ${fwdId}`);
  }

  if (opts.type === "local") {
    // Local forward: listen locally, tunnel through SSH to dest
    const server = net.createServer((socket) => {
      entry.client.forwardOut(
        bindAddr,
        opts.bindPort,
        opts.destAddr,
        opts.destPort,
        (err, stream) => {
          if (err) {
            socket.end();
            return;
          }
          socket.pipe(stream).pipe(socket);
        }
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(opts.bindPort, bindAddr, () => resolve());
      server.on("error", reject);
    });

    const info: ForwardInfo & { server?: net.Server } = {
      id: fwdId,
      type: "local",
      bindAddr,
      bindPort: opts.bindPort,
      destAddr: opts.destAddr,
      destPort: opts.destPort,
      connectionId: opts.connectionId,
      server,
    };
    forwards.set(fwdId, info);
    return { ...info, server: undefined } as ForwardInfo;
  } else {
    // Remote forward: listen on remote, tunnel back to local dest
    await new Promise<void>((resolve, reject) => {
      entry.client.forwardIn(bindAddr, opts.bindPort, (err) => {
        if (err) reject(new Error(`Remote forward failed: ${err.message}`));
        else resolve();
      });
    });

    entry.client.on("tcp connection", (details, accept) => {
      const stream = accept();
      const socket = net.createConnection(opts.destPort, opts.destAddr);
      stream.pipe(socket).pipe(stream);
    });

    const info: ForwardInfo = {
      id: fwdId,
      type: "remote",
      bindAddr,
      bindPort: opts.bindPort,
      destAddr: opts.destAddr,
      destPort: opts.destPort,
      connectionId: opts.connectionId,
    };
    forwards.set(fwdId, info);
    return info;
  }
}

export function getConnection(id: string): ConnectionEntry {
  return touch(id);
}

// Cleanup on exit
process.on("exit", () => {
  for (const [, entry] of connections) {
    entry.client.end();
  }
  for (const [, fwd] of forwards) {
    fwd.server?.close();
  }
});
