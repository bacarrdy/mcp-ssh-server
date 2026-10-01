import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio advertises the package version and tools without reading credentials or opening sockets", { timeout: 10000 }, async (t) => {
  const entry = process.env.SSH_MCP_TEST_ENTRY || fileURLToPath(new URL("../build/index.js", import.meta.url));
  const packageFile = new URL("../package.json", pathToFileURL(entry));
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", fileURLToPath(new URL("./discovery-guard.mjs", import.meta.url)), entry],
    env: { PATH: process.env.PATH, SSH_MCP_ALLOWED_HOSTS: "none.invalid", SSH_MCP_STRICT_HOST_CHECK: "true" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "ssh-release-readiness-test", version: "1" });
  const requestOptions = { timeout: 3000 };
  try {
    await client.connect(transport, requestOptions);
    assert.equal(client.getServerVersion().name, pkg.name);
    assert.equal(client.getServerVersion().version, pkg.version);
    const { tools } = await client.listTools(undefined, requestOptions);
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      "ssh_connect", "ssh_disconnect", "ssh_list_connections", "ssh_exec", "ssh_system_info",
      "sftp_ls", "sftp_read", "sftp_write", "sftp_mkdir", "sftp_rm", "sftp_mv", "sftp_stat",
      "ssh_keygen", "ssh_port_forward",
    ].sort());
    const result = await client.callTool({ name: "ssh_list_connections", arguments: {} }, undefined, requestOptions);
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "No active connections. Use ssh_connect to open one.");
    t.diagnostic(JSON.stringify({ serverInfo: client.getServerVersion(), toolCount: tools.length, activeConnections: 0 }));
  } catch (error) {
    throw new Error(`${error.message}\nServer stderr: ${stderr}`, { cause: error });
  } finally {
    await client.close();
  }
  assert.match(stderr, /^SSH MCP server running\nSSH_MCP_DISCOVERY_GUARD \{"credentialReads":0,"networkAttempts":0\}\n$/);
});
