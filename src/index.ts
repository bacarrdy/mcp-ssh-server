#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  connect,
  disconnect,
  listConnections,
  exec,
  portForward,
  getConnection,
} from "./ssh.js";
import * as sftp from "./sftp.js";
import { generateKeyPair } from "./keygen.js";

const server = new McpServer(
  { name: "mcp-server-ssh", version: "1.0.0" },
  {
    instructions: [
      "This MCP server provides SSH remote access: execute commands, transfer files via SFTP, and generate SSH key pairs.",
      "It works with ANY SSH-accessible server — not tied to any specific hosting provider.",
      "",
      "## Connection Workflow",
      "1. Call ssh_connect with host, username, and auth credentials (privateKey, privateKeyPath, or password).",
      "2. You get back a connectionId — use it for all subsequent operations.",
      "3. The connection stays open until you call ssh_disconnect, or it times out after 30 min idle.",
      "4. Multiple connections can be open simultaneously to different servers.",
      "",
      "## Authentication (in order of preference)",
      "1. **privateKey** — inline private key string (most portable across environments).",
      "2. **privateKeyPath** — path to private key file on the local machine.",
      "3. **Auto-detect** — if neither key nor password given, tries ~/.ssh/id_ed25519, ~/.ssh/id_rsa, ~/.ssh/id_ecdsa.",
      "4. **password** — SSH password auth (least secure, use only when keys aren't available).",
      "",
      "## Key Generation",
      "Use ssh_keygen to generate a new key pair. The keys are returned as strings — they are NOT saved to disk.",
      "You can then use the public key with hosting APIs (e.g., vpsnet-mcp's create_ssh_key + deploy_ssh_key),",
      "and the private key with ssh_connect's privateKey parameter.",
      "",
      "**IMPORTANT key type compatibility:**",
      "- For keys you'll use with ssh_connect's privateKey parameter, use **ecdsa** or **rsa** — these always work.",
      "- ed25519 keys require a native C++ addon that may not be available in all environments.",
      "- ed25519 is still fine for generating keys to deploy to servers (the public key format is universal).",
      "- If ssh_connect fails with 'Cannot parse privateKey' for ed25519, switch to ecdsa (bits: 256).",
      "- RSA 4096 works everywhere but is slower to generate. ECDSA 256 is the best balance of speed + compatibility.",
      "",
      "## Command Execution Tips",
      "- Use ssh_exec for single commands. Chain with && for sequential: 'apt update && apt install -y nginx'",
      "- For long-running commands, increase the timeout parameter (default: 30s).",
      "- Use ssh_system_info for a quick overview of a server (OS, memory, disk, uptime).",
      "- Commands run as the authenticated user (usually root for VPS).",
      "",
      "## SFTP File Operations",
      "- Use sftp_ls to browse directories, sftp_read/sftp_write for file content.",
      "- sftp_read defaults to UTF-8; use encoding='base64' for binary files.",
      "- sftp_write can create new files or overwrite existing ones.",
      "- sftp_mkdir with recursive=true creates parent directories.",
      "- sftp_rm with recursive=true removes directories and their contents.",
      "",
      "## Port Forwarding",
      "- Use ssh_port_forward for TCP tunneling through SSH.",
      "- type='local': listen locally, forward traffic through SSH to a remote destination.",
      "- type='remote': listen on the remote server, forward traffic back to a local destination.",
      "",
      "## Pairing with VPSnet.com (vpsnet-mcp)",
      "This server pairs perfectly with the vpsnet-mcp server for complete VPS provisioning + configuration:",
      "",
      "### Full workflow (order + connect + manage):",
      "1. Use vpsnet-mcp's get_order_plans → get_order_options to pick a plan",
      "2. Generate an SSH key: ssh_keygen(type='ecdsa', bits=256) — save the private key for step 5",
      "3. Upload public key to VPSnet: vpsnet-mcp's create_ssh_key(name, public_key) — note the key ID",
      "4. Order VPS: vpsnet-mcp's order_service(plan, os, sshKey=key_id, period, resources, payment)",
      "5. Wait 10-30 seconds for VPS to boot, then get IP from list_services",
      "6. Connect: ssh_connect(host=vps_ip, username='root', privateKey=private_key_from_step_2)",
      "7. Manage: ssh_exec to install software, sftp_write to upload configs, ssh_system_info for overview",
      "",
      "### Deploying key to existing VPS:",
      "1. Generate key: ssh_keygen(type='ecdsa', bits=256)",
      "2. Upload: vpsnet-mcp's create_ssh_key(name, public_key)",
      "3. Deploy: vpsnet-mcp's deploy_ssh_key(orderNo, ssh_key_id)",
      "4. Connect: ssh_connect(host=vps_ip, username='root', privateKey=private_key)",
      "",
      "### Important:",
      "- Use ecdsa or rsa keys (NOT ed25519) when connecting via ssh_connect's privateKey parameter",
      "- order_service uses 'sshKey' (camelCase) but deploy_ssh_key uses 'ssh_key' (snake_case)",
      "- After ordering, wait 10-30s before SSH — VPS needs time to boot",
      "",
      "Combined config example for Claude Desktop:",
      '  "vpsnet": { "command": "npx", "args": ["-y", "vpsnet-mcp"], "env": { "VPSNET_API_KEY": "..." } }',
      '  "ssh": { "command": "npx", "args": ["-y", "mcp-server-ssh"] }',
    ].join("\n"),
  }
);

// Helper for JSON tool responses
function text(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      { type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

// --- Connection Management ---

server.registerTool(
  "ssh_connect",
  {
    description:
      "Open a persistent SSH connection. Returns a connectionId for use with other tools. " +
      "Supports private key (inline or file path) and password authentication. " +
      "If no auth is provided, auto-detects ~/.ssh/id_ed25519, id_rsa, or id_ecdsa.",
    inputSchema: {
      host: z.string().describe("SSH server hostname or IP address"),
      port: z.number().optional().describe("SSH port (default: 22)"),
      username: z
        .string()
        .optional()
        .describe(
          "SSH username (default: SSH_MCP_DEFAULT_USERNAME env var, or 'root')"
        ),
      password: z
        .string()
        .optional()
        .describe("SSH password. Use privateKey or privateKeyPath instead when possible"),
      privateKey: z
        .string()
        .optional()
        .describe("Inline private key string (PEM format)"),
      privateKeyPath: z
        .string()
        .optional()
        .describe(
          "Path to private key file (default: auto-detects ~/.ssh/id_ed25519 etc.)"
        ),
      passphrase: z
        .string()
        .optional()
        .describe("Passphrase for encrypted private key"),
      name: z
        .string()
        .optional()
        .describe(
          "Custom connection ID/name. Defaults to 'host:port'. Useful for managing multiple connections to the same host"
        ),
    },
  },
  async ({ host, port, username, password, privateKey, privateKeyPath, passphrase, name }) => {
    const result = await connect({
      host,
      port,
      username,
      password,
      privateKey,
      privateKeyPath,
      passphrase,
      name,
    });
    return text(result);
  }
);

server.registerTool(
  "ssh_disconnect",
  {
    description:
      "Close an SSH connection by ID, or close all connections if no ID is provided.",
    inputSchema: {
      connectionId: z
        .string()
        .optional()
        .describe(
          "Connection ID to close. Omit to close ALL connections"
        ),
    },
  },
  async ({ connectionId }) => {
    const closed = await disconnect(connectionId);
    if (closed.length === 0) {
      return text(
        connectionId
          ? `No connection found with id "${connectionId}"`
          : "No active connections to close"
      );
    }
    return text({ closed, message: `Closed ${closed.length} connection(s)` });
  }
);

server.registerTool(
  "ssh_list_connections",
  {
    description: "List all active SSH connections with host, username, and timing info.",
    inputSchema: {},
  },
  async () => {
    const conns = listConnections();
    if (conns.length === 0) {
      return text("No active connections. Use ssh_connect to open one.");
    }
    return text(conns);
  }
);

// --- Command Execution ---

server.registerTool(
  "ssh_exec",
  {
    description:
      "Execute a command on a remote server via SSH. Returns stdout, stderr, and exit code. " +
      "Use && to chain commands. Increase timeout for long-running operations.",
    inputSchema: {
      connectionId: z
        .string()
        .describe("Connection ID from ssh_connect"),
      command: z.string().describe("Shell command to execute"),
      timeout: z
        .number()
        .optional()
        .describe(
          "Command timeout in milliseconds (default: 30000). Use higher values for apt install, builds, etc."
        ),
    },
  },
  async ({ connectionId, command, timeout }) => {
    const result = await exec(connectionId, command, timeout);
    return text(result);
  }
);

server.registerTool(
  "ssh_system_info",
  {
    description:
      "Get system overview: hostname, OS, kernel, uptime, CPU, memory, disk usage. " +
      "Convenience wrapper around ssh_exec that runs multiple info commands.",
    inputSchema: {
      connectionId: z
        .string()
        .describe("Connection ID from ssh_connect"),
    },
  },
  async ({ connectionId }) => {
    const cmd = [
      'echo "=== Hostname ===" && hostname',
      'echo "=== OS ===" && (cat /etc/os-release 2>/dev/null | grep -E "^(NAME|VERSION)=" || uname -a)',
      'echo "=== Kernel ===" && uname -r',
      'echo "=== Uptime ===" && uptime',
      'echo "=== CPU ===" && (nproc 2>/dev/null && cat /proc/cpuinfo 2>/dev/null | grep "model name" | head -1 || sysctl -n hw.ncpu 2>/dev/null)',
      'echo "=== Memory ===" && (free -h 2>/dev/null || vm_stat 2>/dev/null)',
      'echo "=== Disk ===" && df -h / 2>/dev/null',
    ].join(" && ");

    const result = await exec(connectionId, cmd, 15000);
    return text(result);
  }
);

// --- SFTP File Operations ---

server.registerTool(
  "sftp_ls",
  {
    description:
      "List directory contents on a remote server via SFTP. " +
      "Returns file names, types, sizes, permissions, and timestamps. Directories listed first.",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      path: z.string().describe("Remote directory path to list (e.g. '/var/www', '/root')"),
    },
  },
  async ({ connectionId, path }) => {
    const entry = getConnection(connectionId);
    const entries = await sftp.ls(entry, path);
    return text(entries);
  }
);

server.registerTool(
  "sftp_read",
  {
    description:
      "Read a file from a remote server via SFTP. " +
      "Defaults to UTF-8 text. Use encoding='base64' for binary files. " +
      "Max file size: 1MB by default (configurable via SSH_MCP_MAX_FILE_SIZE or maxSize parameter).",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      path: z.string().describe("Remote file path to read"),
      encoding: z
        .enum(["utf8", "base64"])
        .optional()
        .describe("File encoding (default: utf8). Use base64 for binary files"),
      maxSize: z
        .number()
        .optional()
        .describe("Max file size in bytes (default: 1048576 = 1MB)"),
    },
  },
  async ({ connectionId, path, encoding, maxSize }) => {
    const entry = getConnection(connectionId);
    const result = await sftp.read(entry, path, encoding, maxSize);
    return text(result);
  }
);

server.registerTool(
  "sftp_write",
  {
    description:
      "Write or create a file on a remote server via SFTP. " +
      "Overwrites existing files. Use encoding='base64' to write binary content.",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      path: z.string().describe("Remote file path to write"),
      content: z.string().describe("File content to write"),
      encoding: z
        .enum(["utf8", "base64"])
        .optional()
        .describe("Content encoding (default: utf8). Use base64 for binary data"),
      mode: z
        .number()
        .optional()
        .describe("File permissions as octal number (e.g. 0o644, 0o755)"),
    },
  },
  async ({ connectionId, path, content, encoding, mode }) => {
    const entry = getConnection(connectionId);
    const result = await sftp.write(entry, path, content, encoding, mode);
    return text(result);
  }
);

server.registerTool(
  "sftp_mkdir",
  {
    description:
      "Create a directory on a remote server via SFTP. " +
      "Set recursive=true to create parent directories (like mkdir -p).",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      path: z.string().describe("Remote directory path to create"),
      recursive: z
        .boolean()
        .optional()
        .describe("Create parent directories if they don't exist (default: false)"),
    },
  },
  async ({ connectionId, path, recursive }) => {
    const entry = getConnection(connectionId);
    await sftp.mkdir(entry, path, recursive);
    return text({ path, created: true, recursive: !!recursive });
  }
);

server.registerTool(
  "sftp_rm",
  {
    description:
      "Remove a file or directory on a remote server via SFTP. " +
      "For directories, set recursive=true (like rm -rf). Use with caution!",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      path: z.string().describe("Remote path to remove"),
      recursive: z
        .boolean()
        .optional()
        .describe("Remove directories and their contents recursively (default: false)"),
    },
  },
  async ({ connectionId, path, recursive }) => {
    const entry = getConnection(connectionId);
    await sftp.rm(entry, path, recursive);
    return text({ path, removed: true });
  }
);

server.registerTool(
  "sftp_mv",
  {
    description: "Move or rename a file/directory on a remote server via SFTP.",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      source: z.string().describe("Current remote path"),
      destination: z.string().describe("New remote path"),
    },
  },
  async ({ connectionId, source, destination }) => {
    const entry = getConnection(connectionId);
    await sftp.mv(entry, source, destination);
    return text({ source, destination, moved: true });
  }
);

server.registerTool(
  "sftp_stat",
  {
    description:
      "Get file/directory metadata: size, permissions, owner, timestamps, type.",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      path: z.string().describe("Remote path to inspect"),
    },
  },
  async ({ connectionId, path }) => {
    const entry = getConnection(connectionId);
    const result = await sftp.stat(entry, path);
    return text({ path, ...result });
  }
);

// --- Key Generation ---

server.registerTool(
  "ssh_keygen",
  {
    description:
      "Generate an SSH key pair (ed25519, rsa, or ecdsa). " +
      "Returns public and private keys as strings — does NOT save to disk. " +
      "Use the public key with hosting APIs and the private key with ssh_connect. " +
      "IMPORTANT: For keys used with ssh_connect, prefer ecdsa or rsa — ed25519 auth requires a native addon that may not be available.",
    inputSchema: {
      type: z
        .enum(["ed25519", "rsa", "ecdsa"])
        .optional()
        .describe("Key type (default: ed25519). ed25519 recommended for new keys"),
      bits: z
        .number()
        .optional()
        .describe(
          "Key size in bits. RSA: default 4096 (min 2048). ECDSA: 256, 384, or 521. Ignored for ed25519"
        ),
      comment: z
        .string()
        .optional()
        .describe("Comment to embed in the key (e.g. 'user@hostname')"),
      passphrase: z
        .string()
        .optional()
        .describe("Passphrase to encrypt the private key"),
    },
  },
  async ({ type, bits, comment, passphrase }) => {
    const result = generateKeyPair({ type, bits, comment, passphrase });
    return text(result);
  }
);

// --- Port Forwarding ---

server.registerTool(
  "ssh_port_forward",
  {
    description:
      "Create a TCP port tunnel through SSH. " +
      "type='local': listen on local machine, forward to remote destination (e.g. access remote DB locally). " +
      "type='remote': listen on remote server, forward to local destination (e.g. expose local service remotely).",
    inputSchema: {
      connectionId: z.string().describe("Connection ID from ssh_connect"),
      type: z
        .enum(["local", "remote"])
        .describe(
          "Tunnel type. 'local' = listen locally, forward to remote. 'remote' = listen remotely, forward to local"
        ),
      bindAddr: z
        .string()
        .optional()
        .describe("Address to bind the listener on (default: 127.0.0.1)"),
      bindPort: z.number().describe("Port to listen on"),
      destAddr: z
        .string()
        .describe("Destination address to forward traffic to"),
      destPort: z.number().describe("Destination port to forward traffic to"),
    },
  },
  async ({ connectionId, type, bindAddr, bindPort, destAddr, destPort }) => {
    const result = await portForward({
      connectionId,
      type,
      bindAddr,
      bindPort,
      destAddr,
      destPort,
    });
    return text(result);
  }
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SSH MCP server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
