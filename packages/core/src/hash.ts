import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function cacheTokenFor(workspaceId: string, revision: number, projectKey = ""): string {
  const sig = sha256Hex(`${workspaceId}:${revision}:${projectKey}`).slice(0, 8);
  return `bb-r${revision}-${sig}`;
}

export function hashApiKey(plaintext: string): string {
  return sha256Hex(`bothy-board-key:${plaintext}`);
}

export function newApiKey(): { plaintext: string; hash: string; prefix: string } {
  return mintKey("bb_live_");
}

export function newPat(): { plaintext: string; hash: string; prefix: string } {
  return mintKey("bb_pat_");
}

function mintKey(prefixKind: "bb_live_" | "bb_pat_"): {
  plaintext: string;
  hash: string;
  prefix: string;
} {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let raw = "";
  for (const b of bytes) raw += b.toString(16).padStart(2, "0");
  const plaintext = `${prefixKind}${raw}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, 18),
  };
}
