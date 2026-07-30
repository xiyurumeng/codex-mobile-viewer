import {
  createCipheriv, createDecipheriv, createHmac, generateKeyPairSync,
  pbkdf2Sync, randomBytes, sign, verify
} from "node:crypto";

const b64 = (value) => Buffer.from(value).toString("base64");
const fromB64 = (value) => Buffer.from(value, "base64");

export function derivePassphraseKey(passphrase, salt, iterations) {
  return pbkdf2Sync(passphrase.normalize("NFKC"), salt, iterations, 32, "sha256");
}

export function encryptAesGcm(plaintext, key, additionalData = "") {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (additionalData) cipher.setAAD(Buffer.from(additionalData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return { iv: b64(iv), ciphertext: b64(ciphertext), tag: b64(cipher.getAuthTag()) };
}

export function decryptAesGcm(envelope, key, additionalData = "") {
  const decipher = createDecipheriv("aes-256-gcm", key, fromB64(envelope.iv));
  if (additionalData) decipher.setAAD(Buffer.from(additionalData, "utf8"));
  decipher.setAuthTag(fromB64(envelope.tag));
  return Buffer.concat([decipher.update(fromB64(envelope.ciphertext)), decipher.final()]);
}

export function wrapContentKey(contentKey, passphrase, iterations) {
  const salt = randomBytes(16);
  const key = derivePassphraseKey(passphrase, salt, iterations);
  return { salt: b64(salt), iterations, ...encryptAesGcm(contentKey, key, "codex-mobile-viewer:key:v1") };
}

export function unwrapContentKey(envelope, passphrase) {
  const key = derivePassphraseKey(passphrase, fromB64(envelope.salt), envelope.iterations);
  return decryptAesGcm(envelope, key, "codex-mobile-viewer:key:v1");
}

export function anonymousName(contentKey, namespace, value) {
  return createHmac("sha256", contentKey).update(`${namespace}\0${value}`).digest("hex");
}

export function createSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

export function signBytes(bytes, privateKey) {
  return b64(sign(null, Buffer.from(bytes), privateKey));
}

export function verifyBytes(bytes, signature, publicKey) {
  return verify(null, Buffer.from(bytes), publicKey, fromB64(signature));
}
