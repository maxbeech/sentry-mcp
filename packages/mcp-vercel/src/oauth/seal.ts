import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Everything this server remembers between requests, it hands to the caller
 * instead -- sealed.
 *
 * A Vercel function keeps nothing between invocations and this deployment has no
 * database, so a registered client, an authorization code, an access token and a
 * refresh token are each a self-contained AES-256-GCM blob: the token IS the
 * record. Encrypting, not merely signing, matters here: these carry Sentry's own
 * access and refresh tokens, and a code travels through a browser address bar
 * and into whatever logs it.
 *
 * The kind is bound in as authenticated data, so a code cannot be presented as
 * an access token or the reverse, and each blob carries its own expiry.
 *
 * What this cannot do is be used once. A code is valid until it expires (ten
 * minutes), and it is worthless without the PKCE verifier only the original
 * caller holds; a stateless server has no place to record that it was spent.
 */

export type SealKind = "client" | "state" | "code" | "access" | "refresh";

const PREFIX: Record<SealKind, string> = {
  client: "smcp_k1.",
  state: "smcp_s1.",
  code: "smcp_c1.",
  access: "smcp_a1.",
  refresh: "smcp_r1.",
};

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(`sentry-mcp-vercel:${secret}`).digest();
}

export function seal(
  kind: SealKind,
  payload: unknown,
  secret: string,
  ttlSeconds?: number,
): string {
  const body = JSON.stringify({
    k: kind,
    exp:
      ttlSeconds === undefined
        ? undefined
        : Math.floor(Date.now() / 1000) + ttlSeconds,
    p: payload,
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  cipher.setAAD(Buffer.from(kind));
  const ciphertext = Buffer.concat([
    cipher.update(body, "utf8"),
    cipher.final(),
  ]);
  return (
    PREFIX[kind] +
    Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")
  );
}

/** The payload, or undefined when the token is not of this kind, was altered, or has expired. */
export function open<T>(
  kind: SealKind,
  token: string,
  secret: string,
): T | undefined {
  if (!token.startsWith(PREFIX[kind])) return undefined;
  try {
    const raw = Buffer.from(token.slice(PREFIX[kind].length), "base64url");
    if (raw.length < 28) return undefined;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyFrom(secret),
      raw.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(kind));
    decipher.setAuthTag(raw.subarray(12, 28));
    const body = JSON.parse(
      Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    ) as { k: string; exp?: number; p: T };
    if (body.k !== kind) return undefined;
    if (body.exp !== undefined && body.exp < Math.floor(Date.now() / 1000))
      return undefined;
    return body.p;
  } catch {
    return undefined;
  }
}

/** True for a token this server issued, expired or not. A raw Sentry token never matches. */
export function isSealed(token: string): boolean {
  return /^smcp_[kscar]1\./.test(token);
}
