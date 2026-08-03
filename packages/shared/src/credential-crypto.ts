// At-rest crypto for the credentials.auth column — shared between every
// component that touches the blob (issue #187):
//
//   - packages/services (CF)         encrypts/decrypts via the credential
//                                    repo using WebCryptoAesGcm(secret,
//                                    "credentials.auth")
//   - apps/main-node (self-host)     same wiring through the Node factory
//   - apps/oma-vault (self-host)     reads the column DIRECTLY from the
//                                    shared db to inject outbound headers,
//                                    so it must decrypt with the exact same
//                                    key derivation
//
// The wire format here is intentionally byte-identical to the
// WebCryptoAesGcm class in @duyet/oma-integrations-adapters-{cf,node}
// (SHA-256(`${secret}|${label}`) → AES-256-GCM key; base64url(iv||ct), no
// padding) so ciphertexts written by either implementation decrypt with
// the other. An interop test pins this
// (apps/main-node/test/credential-crypto.test.ts). Pure Web Crypto — runs
// on Workers and Node ≥20 alike.
//
// Decrypt is *legacy-plaintext tolerant*: rows written before at-rest
// encryption was wired hold `JSON.stringify(auth)` verbatim, which always
// starts with "{" — a character that can never appear in base64url. Those
// rows read back unchanged (lazy migration: any update re-encrypts).

const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32; // AES-256

/** Same derivation label the CF deployment uses (packages/services
 *  mintCrypto) so each subsystem derives a distinct AES key off the shared
 *  PLATFORM_ROOT_SECRET. */
export const CREDENTIALS_CRYPTO_LABEL = "credentials.auth";

/** Derivation label for the cross-instance federation registry's stored
 *  remote API keys (issue #132). Distinct from CREDENTIALS_CRYPTO_LABEL so a
 *  federation ciphertext can never be decrypted with the credentials key and
 *  vice-versa. */
export const FEDERATION_CRYPTO_LABEL = "federation.api_key";

/** Derivation label for a tenant's own Telegram bot token stored by the
 *  Telegram integration (`mode: "own_bot"`). Distinct from every other label
 *  so a bot-token ciphertext can only ever be read with the Telegram key. */
export const TELEGRAM_CRYPTO_LABEL = "telegram.bot_token";

export interface CredentialBlobCrypto {
  encrypt(plaintext: string): Promise<string>;
  decrypt(stored: string): Promise<string>;
}

/** True when a stored `auth` value predates at-rest encryption — the repo
 *  always stored `JSON.stringify(auth)`, so legacy rows start with "{",
 *  which is not a valid base64url character. */
export function isLegacyPlaintextAuth(stored: string): boolean {
  return stored.trimStart().startsWith("{");
}

/**
 * Build the credentials.auth crypto: AES-256-GCM keyed off
 * PLATFORM_ROOT_SECRET under the "credentials.auth" label, decrypt-tolerant
 * of legacy plaintext rows.
 */
export function buildCredentialCrypto(platformRootSecret: string): CredentialBlobCrypto {
  return buildLabeledCrypto(platformRootSecret, CREDENTIALS_CRYPTO_LABEL);
}

/**
 * Generic AES-256-GCM at-rest crypto keyed off PLATFORM_ROOT_SECRET under an
 * arbitrary `label` — the primitive `buildCredentialCrypto` specializes. Use
 * a distinct label per subsystem so keys never collide (e.g.
 * FEDERATION_CRYPTO_LABEL). Wire format + legacy-plaintext tolerance are
 * identical to `buildCredentialCrypto`.
 */
export function buildLabeledCrypto(
  platformRootSecret: string,
  label: string,
): CredentialBlobCrypto {
  if (!platformRootSecret) {
    throw new Error("buildLabeledCrypto: platformRootSecret must be non-empty");
  }
  let keyPromise: Promise<CryptoKey> | null = null;
  const getKey = (): Promise<CryptoKey> => {
    if (!keyPromise) {
      keyPromise = (async () => {
        const seed = new TextEncoder().encode(
          `${platformRootSecret}|${label}`,
        );
        const digest = await crypto.subtle.digest("SHA-256", seed);
        return crypto.subtle.importKey(
          "raw",
          digest.slice(0, KEY_BYTES),
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      })();
    }
    return keyPromise;
  };

  return {
    async encrypt(plaintext: string): Promise<string> {
      const key = await getKey();
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
      );
      const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.byteLength);
      return base64UrlEncode(combined);
    },
    async decrypt(stored: string): Promise<string> {
      if (isLegacyPlaintextAuth(stored)) return stored;
      const key = await getKey();
      const combined = base64UrlDecode(stored);
      if (combined.byteLength <= IV_BYTES) {
        throw new Error("credential-crypto: ciphertext too short");
      }
      const iv = combined.slice(0, IV_BYTES);
      const data = combined.slice(IV_BYTES);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
      return new TextDecoder().decode(plaintext);
    },
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
