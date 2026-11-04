import {
  generateKeyPairSync,
  sign,
  verify,
  createPublicKey,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root } from "./store.mjs";
const file = path.join(root, "verification-private.pem");
if (!existsSync(file)) {
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(
    file,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
}
const privateKey = readFileSync(file);
export const publicKey = createPublicKey(privateKey).export({
  type: "spki",
  format: "pem",
});
export const signManifest = (manifest) => ({
  manifest,
  signature: sign(null, Buffer.from(manifest), privateKey).toString("base64"),
  algorithm: "Ed25519",
});
export const verifyManifest = (record) =>
  verify(
    null,
    Buffer.from(record.manifest),
    publicKey,
    Buffer.from(record.signature, "base64"),
  );
