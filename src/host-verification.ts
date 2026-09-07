import { createHash } from "node:crypto";
import { isIP } from "node:net";

type HostKeyPins = ReadonlyMap<string, readonly string[]>;

function hostKeyTarget(host: string, port: number): string {
  const hostname = host.toLowerCase().replace(/^\[([^\]]+)\]$/, "$1");
  if (!hostname || /[\s/\\@?#\[\]*]/.test(hostname)
      || (hostname.includes(":") && isIP(hostname) !== 6)) {
    throw new Error("Invalid SSH host for host key verification");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH port must be an integer from 1 to 65535");
  }
  return `${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

function normalizedFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value)) {
    throw new Error("SSH_MCP_HOST_KEY_PINS requires SHA256 host key fingerprints");
  }
  const digest = value.slice("SHA256:".length).replace(/=$/, "");
  if (Buffer.from(digest, "base64").toString("base64").replace(/=$/, "") !== digest) {
    throw new Error("SSH_MCP_HOST_KEY_PINS contains an invalid SHA256 fingerprint");
  }
  return `SHA256:${digest}`;
}

export function parseHostKeyPins(raw: string | undefined): HostKeyPins {
  const pins = new Map<string, readonly string[]>();
  if (!raw?.trim()) return pins;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SSH_MCP_HOST_KEY_PINS must be a JSON object keyed by host:port");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SSH_MCP_HOST_KEY_PINS must be a JSON object keyed by host:port");
  }
  for (const [target, value] of Object.entries(parsed)) {
    const parts = /^(\[[^\]]+\]|[^:\s]+):([0-9]+)$/.exec(target);
    if (!parts) {
      throw new Error("SSH_MCP_HOST_KEY_PINS keys must include an exact host and port");
    }
    const key = hostKeyTarget(parts[1], Number(parts[2]));
    const fingerprints: unknown[] = Array.isArray(value) ? value : [value];
    if (fingerprints.length === 0 || pins.has(key)) {
      throw new Error("SSH_MCP_HOST_KEY_PINS contains an empty or duplicate target");
    }
    pins.set(key, fingerprints.map(normalizedFingerprint));
  }
  return pins;
}

export function hostKeyVerifier(
  host: string,
  port: number,
  strict: boolean,
  pins: HostKeyPins,
): ((key: Buffer) => boolean) | undefined {
  const target = hostKeyTarget(host, port);
  const expected = pins.get(target);
  if (!expected) {
    if (strict) {
      throw new Error(`No trusted SSH host key for ${target}. Configure SSH_MCP_HOST_KEY_PINS before connecting.`);
    }
    return undefined;
  }
  return (key) => {
    if (!Buffer.isBuffer(key)) return false;
    const digest = createHash("sha256").update(key).digest("base64").replace(/=$/, "");
    return expected.includes(`SHA256:${digest}`);
  };
}
