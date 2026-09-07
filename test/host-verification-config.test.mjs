import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { hostKeyVerifier, parseHostKeyPins } from "../build/host-verification.js";

const publicKey = Buffer.from("test host public key");
const pin = "SHA256:" + createHash("sha256").update(publicKey).digest("base64").replace(/=$/, "");

test("malformed trust configuration fails closed", () => {
  for (const raw of [
    "not JSON", "null", "[]", '{"server":[]}',
    JSON.stringify({ "server:22": [] }),
    JSON.stringify({ "server:22": "SHA256:invalid" }),
    JSON.stringify({ "server:22": "MD5:00:00" }),
    JSON.stringify({ "server:22": null }),
    JSON.stringify({ "server:22": [pin, "SHA256:invalid"] }),
    JSON.stringify({ "server:0": pin }),
    JSON.stringify({ "server:65536": pin }),
    JSON.stringify({ "*.example.com:22": pin }),
    JSON.stringify({ "SERVER:22": pin, "server:22": pin }),
  ]) {
    assert.throws(() => parseHostKeyPins(raw));
  }
});

test("hostname case, IPv6 brackets and optional base64 padding preserve configured trust", () => {
  const pins = parseHostKeyPins(JSON.stringify({
    "SERVER.EXAMPLE:22": pin + "=",
    "[::1]:2222": [pin],
  }));
  assert.equal(hostKeyVerifier("server.example", 22, true, pins)(publicKey), true);
  assert.equal(hostKeyVerifier("::1", 2222, true, pins)(publicKey), true);
  assert.equal(hostKeyVerifier("[::1]", 2222, true, pins)(publicKey), true);
  assert.equal(hostKeyVerifier("::1", 2222, true, pins)(Buffer.from("substituted key")), false);
  assert.throws(() => hostKeyVerifier("::1", 22, true, pins), /No trusted SSH host key/);
  assert.throws(() => hostKeyVerifier("other.example", 22, true, pins), /No trusted SSH host key/);
});
