import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// Discovery must work without touching SSH credentials or opening a TCP socket.
// Fail before a sensitive read or network attempt can reach the operating system.
const observed = { credentialReads: 0, networkAttempts: 0 };
function checkPath(path) {
  const name = path instanceof URL ? fileURLToPath(path) : String(path);
  if (/(^|[/\\])(?:\.ssh(?:[/\\]|$)|id_(?:rsa|ecdsa|ed25519|dsa)$|\.env(?:\..*)?$|\.envrc(?:\..*)?$|\.npmrc(?:\..*)?$|\.mcp\.json$)/.test(name)) {
    observed.credentialReads++;
    throw new Error("Discovery attempted to read a credential file");
  }
}
for (const name of ["readFileSync", "readFile", "openSync", "open"]) {
  const original = fs[name];
  fs[name] = function (path, ...args) {
    checkPath(path);
    return original.call(this, path, ...args);
  };
}
for (const name of ["readFile", "open"]) {
  const original = fs.promises[name];
  fs.promises[name] = async function (path, ...args) {
    checkPath(path);
    return original.call(this, path, ...args);
  };
}
net.Socket.prototype.connect = function () {
  observed.networkAttempts++;
  throw new Error("Discovery attempted to open a network socket");
};
syncBuiltinESMExports();
process.on("exit", () => {
  fs.writeSync(2, `SSH_MCP_DISCOVERY_GUARD ${JSON.stringify(observed)}\n`);
});
