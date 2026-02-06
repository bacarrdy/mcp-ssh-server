# mcp-server-ssh

[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for SSH remote access. Gives AI assistants the ability to execute commands, transfer files via SFTP, generate SSH key pairs, and set up port forwarding on any SSH-accessible server.

## Features

- **15 tools** for complete remote server management
- Persistent connection pool with auto-reconnect and idle timeout
- Command execution with configurable timeouts
- Full SFTP support (read, write, list, mkdir, rm, mv, stat)
- SSH key pair generation (ed25519, RSA, ECDSA) without external binaries
- Local and remote TCP port forwarding
- Works on Linux, macOS, and Windows — no native SSH client required
- Zero required configuration — credentials provided per-connection

## Prerequisites

Before installing, ensure you have:

1. **Node.js 18 or newer**
   - Check: `node --version`
   - Linux/macOS: [nodejs.org](https://nodejs.org) or your package manager
   - Windows: `winget install OpenJS.NodeJS.LTS` or download from [nodejs.org](https://nodejs.org)
   - After installing Node.js, **restart your terminal/editor**

2. **For Claude Code (CLI or VS Code extension) users:**
   - Claude Code CLI installed globally: `npm install -g @anthropic-ai/claude-code`
   - Check: `claude --version`

## How it works

This server uses the [ssh2](https://github.com/mscdex/ssh2) library (pure JavaScript) for all SSH operations. No native SSH binary is needed — it works identically across all platforms.

**Typical flow:**

1. AI calls `ssh_connect` with host and credentials (key or password)
2. Gets back a `connectionId` for all subsequent operations
3. Runs commands with `ssh_exec`, transfers files with `sftp_*` tools
4. Connection stays open until `ssh_disconnect` or 30 min idle timeout

> **Important:** All commands executed via `ssh_exec` must be non-interactive. Do NOT run commands that require user input (e.g. `apt upgrade` without `-y`, interactive editors like `vim` or `nano`, `passwd` without piping input). Always use non-interactive flags: `apt install -y`, `DEBIAN_FRONTEND=noninteractive`, `yes |`, etc.

## Getting started

Choose your environment:

- [Claude Code (CLI)](#claude-code) — Terminal-based AI coding
- [Claude Code for VS Code](#claude-code-for-vs-code-extension) — VS Code extension
- [Claude Desktop](#claude-desktop) — Desktop app
- [VS Code with GitHub Copilot](#vs-code-with-github-copilot) — Copilot agent mode
- [Cline](#cline) / [Cursor](#cursor) / [Windsurf](#windsurf) / [Roo Code](#roo-code) / [Codex](#codex) — Other clients

The standard config works across most MCP clients:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-server-ssh"]
    }
  }
}
```

No environment variables are required. Authentication is provided per-connection via tool calls.

<details>
<summary>Claude Code</summary>

```bash
claude mcp add ssh -- npx -y mcp-server-ssh
```

</details>

<details>
<summary>Claude Code for VS Code Extension</summary>

> This section is for the **Claude Code VS Code extension**, not GitHub Copilot. If you use VS Code with GitHub Copilot, see the [VS Code with GitHub Copilot](#vs-code-with-github-copilot) section instead.

**Step 1:** Install Claude Code CLI globally (required for the extension):

```bash
npm install -g @anthropic-ai/claude-code
```

**Step 2:** Add the MCP server via CLI:

```bash
claude mcp add ssh -- npx -y mcp-server-ssh
```

**Step 3:** Restart VS Code completely (Ctrl+Shift+P > "Reload Window" or close and reopen).

**Step 4:** Verify by asking Claude: *"List SSH connections"*

> **Windows users:** Use PowerShell or CMD (not Git Bash) when running `claude mcp add` commands.

> The `code --add-mcp` command does **NOT** work with Claude Code extension — that's for VS Code Copilot only.

</details>

<details>
<summary>Claude Desktop</summary>

Follow the [MCP install guide](https://modelcontextprotocol.io/quickstart/user), use the standard config above.

</details>

<details>
<summary>Cline</summary>

Open Cline MCP settings and add to your `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "ssh": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-ssh"],
      "disabled": false
    }
  }
}
```

</details>

<details>
<summary>Codex</summary>

Use the Codex CLI:

```bash
codex mcp add ssh npx "mcp-server-ssh"
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.ssh]
command = "npx"
args = ["mcp-server-ssh"]
```

</details>

<details>
<summary>Cursor</summary>

Go to **Cursor Settings** > **MCP** > **Add new MCP Server**. Use command type with the command `npx -y mcp-server-ssh`. Or add manually to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-server-ssh"]
    }
  }
}
```

</details>

<details>
<summary>Roo Code</summary>

Open Roo Code MCP settings and add to `roo_mcp_settings.json`:

```json
{
  "mcpServers": {
    "ssh": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-server-ssh"],
      "disabled": false
    }
  }
}
```

</details>

<details>
<summary>VS Code with GitHub Copilot</summary>

Install using the VS Code CLI:

```bash
code --add-mcp '{"name":"ssh","command":"npx","args":["-y","mcp-server-ssh"]}'
```

Or add to your VS Code MCP config manually using the standard config above.

> This is for **GitHub Copilot** agent mode in VS Code. For the **Claude Code** extension, see the [Claude Code for VS Code Extension](#claude-code-for-vs-code-extension) section.

</details>

<details>
<summary>Windsurf</summary>

Follow the [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/mcp). Use the standard config above.

</details>

## Windows Users

- Use **PowerShell or CMD** (not Git Bash) for `claude mcp add` commands
- Config file location: `C:\Users\<YourUsername>\.claude.json`
- Install Node.js: `winget install OpenJS.NodeJS.LTS` or download from [nodejs.org](https://nodejs.org)
- After installing Node.js, **restart your terminal and VS Code**
- SSH keys are typically at `C:\Users\<YourUsername>\.ssh\`

## Environment variables

All optional. Credentials are provided per-connection via tool calls.

| Variable | Default | Description |
|----------|---------|-------------|
| `SSH_MCP_DEFAULT_USERNAME` | — | Default SSH username when not specified in ssh_connect |
| `SSH_MCP_DEFAULT_KEY` | `~/.ssh/id_ed25519` | Default private key path (auto-detects ed25519, rsa, ecdsa) |
| `SSH_MCP_IDLE_TIMEOUT` | `1800000` (30 min) | Connection idle timeout in milliseconds |
| `SSH_MCP_STRICT_HOST_CHECK` | `false` | Enable strict host key checking |
| `SSH_MCP_ALLOWED_HOSTS` | — | Comma-separated allowed host patterns (e.g. `*.example.com,10.0.0.*`) |
| `SSH_MCP_MAX_FILE_SIZE` | `1048576` (1MB) | Max file size for sftp_read |
| `SSH_MCP_EXEC_TIMEOUT` | `30000` (30s) | Default command execution timeout |

## Important: Non-Interactive Commands Only

All commands executed via `ssh_exec` **must be non-interactive**. The MCP server cannot handle commands that prompt for user input.

**Do:**
```bash
apt install -y nginx                    # -y flag for automatic yes
DEBIAN_FRONTEND=noninteractive apt upgrade -y
echo "newpassword" | passwd --stdin user  # pipe input
ssh-keygen -t ed25519 -f /root/.ssh/id -N ""  # empty passphrase flag
systemctl enable --now nginx
```

**Don't:**
```bash
apt upgrade              # prompts for confirmation
vim /etc/nginx.conf      # interactive editor
passwd root              # prompts for password
mysql_secure_installation  # interactive wizard
top                      # interactive display
```

For long-running commands, increase the `timeout` parameter (default: 30s).

## Tools

### Connection Management
| Tool | Description |
|------|-------------|
| `ssh_connect` | Open persistent SSH connection (password or key auth). Returns connectionId |
| `ssh_disconnect` | Close a connection by ID, or close all |
| `ssh_list_connections` | List active connections with host/username/timing |

### Command Execution
| Tool | Description |
|------|-------------|
| `ssh_exec` | Execute command, return stdout/stderr/exitCode. Configurable timeout |
| `ssh_system_info` | Quick server overview: OS, kernel, uptime, CPU, memory, disk |

### SFTP File Operations
| Tool | Description |
|------|-------------|
| `sftp_ls` | List directory contents with file metadata |
| `sftp_read` | Read remote file (text or base64). Max 1MB default |
| `sftp_write` | Write/create remote file |
| `sftp_mkdir` | Create directories (with recursive option) |
| `sftp_rm` | Remove file or directory (with recursive option) |
| `sftp_mv` | Move/rename file or directory |
| `sftp_stat` | Get file metadata (size, permissions, owner, timestamps) |

### Key Generation & Tunneling
| Tool | Description |
|------|-------------|
| `ssh_keygen` | Generate key pair (ed25519/rsa/ecdsa). Returns keys as strings, does NOT save to disk. For use with ssh_connect, prefer ecdsa/rsa |
| `ssh_port_forward` | Create local or remote TCP port tunnel |

## Pairing with vpsnet-mcp

This server pairs with [vpsnet-mcp](https://github.com/bacarrdy/vpsnet-mcp) for complete VPS provisioning + configuration:

1. Use **vpsnet-mcp** to order a VPS and get its IP address
2. Use **mcp-server-ssh** to connect, install software, deploy applications

Combined config:

```json
{
  "mcpServers": {
    "vpsnet": {
      "command": "npx",
      "args": ["-y", "vpsnet-mcp"],
      "env": {
        "VPSNET_API_KEY": "your_api_key_here"
      }
    },
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-server-ssh"]
    }
  }
}
```

**Example workflow:**

```
User: "Create a VPS and install nginx on it"

AI (using vpsnet-mcp):
1. get_order_plans → pick a plan
2. order_service → get VPS IP

AI (using mcp-server-ssh):
3. ssh_connect(host: "185.x.x.x", username: "root", password: "...")
4. ssh_exec("apt update && apt install -y nginx")
5. ssh_exec("systemctl enable --now nginx")
```

## Troubleshooting

### MCP tools not appearing in Claude Code VS Code extension

1. Install Claude Code CLI: `npm install -g @anthropic-ai/claude-code`
2. Verify: `claude --version` should show a version number
3. Add server via CLI: `claude mcp add ssh -- npx -y mcp-server-ssh`
4. **Completely restart VS Code** (not just reload window)
5. Check `~/.claude.json` for correct configuration

### `claude: command not found`

Install the Claude Code CLI globally:

```bash
npm install -g @anthropic-ai/claude-code
```

Verify your PATH includes npm global packages. On Windows, restart your terminal after installing.

### `Cannot parse privateKey` error with ed25519

The ssh2 library's ed25519 support requires a native addon that may not be available in all environments. Switch to ecdsa or rsa:

```
ssh_keygen(type: "ecdsa", bits: 256)
```

### Connection timeout or refused

- Verify the server is reachable: `ping <host>` or `telnet <host> 22`
- Check if SSH port is open (default: 22)
- For newly created VPS, wait 10-30 seconds for SSH daemon to start
- Check firewall rules on the server

## License

[MIT](LICENSE)
