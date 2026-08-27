/**
 * The upstream identity providers this app offers for sign-in (via the broker).
 *
 * Source of truth for BOTH the server (`server.ts`, one `genericOAuth` provider
 * per entry) and the client (`client.ts` / sign-in buttons). Kept in its own
 * dependency-free module so the client can import it without pulling the
 * server-only Better Auth instance (and `pg`) into the browser bundle.
 *
 * Each app federates to the shared **auth broker** (`GROK_AUTH_ISSUER`), which
 * holds the real Google/X secrets. The app never sees them — it only knows its
 * own per-app client id/secret and which upstream to ask the broker for (`idp`).
 *
 * To add an upstream (e.g. GitHub) once the broker supports it: add one entry
 * here (`{ providerId: "grok-github", idp: "github", label: "GitHub" }`). The
 * `providerId` is this app's local id and the OAuth callback path segment
 * (`/api/auth/oauth2/callback/<providerId>`); `idp` is the hint the broker reads
 * to pick the upstream (Better Auth's id for X is still `twitter`).
 */
export type GrokProvider = {
  /** This app's local provider id; also the callback path segment. */
  providerId: string;
  /** Upstream hint the broker forwards to (Better Auth social id). */
  idp: string;
  /** Human label for the sign-in button. */
  label: string;
  /**
   * OIDC scopes asked of the Grok broker (not X/Google's native list).
   * X is identity-only — no email. Google still needs email for a real address.
   */
  scopes: readonly string[];
  /**
   * Force the upstream account chooser. Omitted on X so returning visitors
   * reuse the broker session instead of hitting the X permission wall again.
   */
  prompt?: "login";
};

export const GROK_PROVIDERS: readonly GrokProvider[] = [
  {
    providerId: "grok-google",
    idp: "google",
    label: "Google",
    scopes: ["openid", "profile", "email"],
    prompt: "login",
  },
  {
    providerId: "grok-x",
    idp: "twitter",
    label: "X",
    // Identity only. The broker still asks X for users.read + tweet.read
    // (X requires tweet.read to resolve /2/users/me) — we do not add email
    // or any write/follow/DM scopes on our side.
    scopes: ["openid", "profile"],
  },
];
