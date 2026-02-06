import ssh2 from "ssh2";
import type { KeyPairResult } from "./types.js";

const { utils } = ssh2;

type KeyType = "ed25519" | "rsa" | "ecdsa";

const DEFAULT_RSA_BITS = 4096;
const DEFAULT_ECDSA_BITS = 256;

export function generateKeyPair(opts: {
  type?: KeyType;
  bits?: number;
  comment?: string;
  passphrase?: string;
}): KeyPairResult {
  const keyType = opts.type ?? "ed25519";

  const options: Record<string, unknown> = {};
  if (opts.comment) options.comment = opts.comment;
  if (opts.passphrase) {
    options.passphrase = opts.passphrase;
    options.cipher = "aes256-cbc";
  }

  let bits: number | undefined;

  switch (keyType) {
    case "ed25519":
      break;
    case "rsa":
      bits = opts.bits ?? DEFAULT_RSA_BITS;
      options.bits = bits;
      break;
    case "ecdsa":
      bits = opts.bits ?? DEFAULT_ECDSA_BITS;
      if (![256, 384, 521].includes(bits)) {
        throw new Error(
          `ECDSA bits must be 256, 384, or 521. Got: ${bits}`
        );
      }
      options.bits = bits;
      break;
    default:
      throw new Error(
        `Unsupported key type: ${keyType}. Use ed25519, rsa, or ecdsa.`
      );
  }

  const keyPair = utils.generateKeyPairSync(
    keyType as Parameters<typeof utils.generateKeyPairSync>[0],
    options as Parameters<typeof utils.generateKeyPairSync>[1]
  );

  return {
    publicKey: keyPair.public,
    privateKey: keyPair.private,
    type: keyType,
    bits,
    comment: opts.comment,
  };
}
