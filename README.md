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

## How it works

This server uses the [ssh2](https://github.com/mscdex/ssh2) library (pure JavaScript) for all SSH operations. No native SSH binary is needed — it works identically across all platforms.

**Typical flow:**

1. AI calls `ssh_connect` with host and credentials (key or password)
2. Gets back a `connectionId` for all subsequent operations
3. Runs commands with `ssh_exec`, transfers files with `sftp_*` tools
4. Connection stays open until `ssh_disconnect` or 30 min idle timeout

## Requirements

- Node.js 18 or newer

## Getting started

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
<summary>VS Code (Copilot)</summary>

Install using the VS Code CLI:

```bash
code --add-mcp '{"name":"ssh","command":"npx","args":["-y","mcp-server-ssh"]}'
```

Or add to your VS Code MCP config manually using the standard config above.

</details>

<details>
<summary>Windsurf</summary>

Follow the [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/mcp). Use the standard config above.

</details>

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

## License

[MIT](LICENSE)
