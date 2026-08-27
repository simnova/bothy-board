import { BoardError } from "./errors.ts";

/** Merge-gate TREE prefixes. At least one required to Plant. */
export const TREE_PREFIXES = [
  "exists:",
  "min-bytes:",
  "run:",
  "changed:",
  "measured-before:",
  "live:",
] as const;

const NARRATIVE_PREFIXES = ["handoff:", "skeptic:", "handoffs:all-done"] as const;
const RUN_BINARIES = new Set(["pnpm", "node", "tsx", "git"]);
const RUN_METACHAR = /[;|&$`><\n\r]/;

export type FailedTreatment = { name: string; produced: string };

export type Card = {
  objective: string;
  doneWhen: string[];
  writeRoots: string[];
  lane: string | null;
  knownGood: string;
  failedTreatments: FailedTreatment[];
  outOfScope: string;
  notTested: string;
  /** Opaque extra headings (factory_step, unblocks, …) — dumped, not validated. */
  extra: Record<string, string>;
};

export function isTreeRule(line: string): boolean {
  const t = line.trim();
  return TREE_PREFIXES.some((p) => t.startsWith(p) || t.startsWith(`- ${p}`));
}

function stripBullet(line: string): string {
  return line.replace(/^\s*-\s+/, "").trim();
}

function treeKind(line: string): string | null {
  const t = stripBullet(line);
  for (const p of TREE_PREFIXES) if (t.startsWith(p)) return p;
  return null;
}

function isNarrative(line: string): boolean {
  const t = stripBullet(line);
  return NARRATIVE_PREFIXES.some((p) => t === p || t.startsWith(p));
}

function assertPathRule(line: string) {
  const t = stripBullet(line);
  if (t.includes("`")) {
    throw new BoardError("invalid_card", "done_when paths must not be markdown-wrapped.");
  }
  if (/\bit\.fails\b/i.test(t) && !t.includes("live:")) {
    throw new BoardError("invalid_card", "it.fails requires a live: TREE rule.");
  }
}

function assertRunRule(line: string) {
  const t = stripBullet(line);
  if (!t.startsWith("run:")) return;
  const rest = t.slice("run:".length).trim();
  if (RUN_METACHAR.test(rest)) {
    throw new BoardError("invalid_card", "run: does not allow shell metacharacters.");
  }
  const bin = rest.split(/\s+/)[0] ?? "";
  if (!RUN_BINARIES.has(bin)) {
    throw new BoardError(
      "invalid_card",
      `run: binary must be pnpm|node|tsx|git (got ${bin || "empty"}).`,
    );
  }
}

export function parseCard(
  body: string,
  fields?: Partial<{ [K in keyof Card]: Card[K] | undefined }>,
): Card {
  const card: Card = {
    objective: "",
    doneWhen: [],
    writeRoots: [],
    lane: null,
    knownGood: "",
    failedTreatments: [],
    outOfScope: "",
    notTested: "",
    extra: {},
  };
  const text = body ?? "";
  let section:
    | "none"
    | "done_when"
    | "out_of_scope"
    | "not_tested"
    | "failed_treatments"
    | "extra" = "none";
  let extraKey = "";
  const extraBuf: string[] = [];
  const flushExtra = () => {
    if (extraKey) card.extra[extraKey] = extraBuf.join("\n").trim();
    extraBuf.length = 0;
    extraKey = "";
  };

  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+$/, "");
    const heading = line.match(/^##\s+([a-z0-9_-]+)(?:\s*:\s*(.*))?$/i);
    if (heading) {
      flushExtra();
      const key = heading[1]?.toLowerCase().replaceAll("_", "-") ?? "";
      const rest = (heading[2] ?? "").trim();
      section = "none";
      if (key === "objective") {
        card.objective = rest;
        continue;
      }
      if (key === "lane") {
        card.lane = rest || null;
        continue;
      }
      if (key === "write-roots" || key === "write-root") {
        if (rest) card.writeRoots = rest.split(/[,\s]+/).filter(Boolean);
        continue;
      }
      if (key === "known-good") {
        card.knownGood = rest;
        continue;
      }
      if (key === "done_when" || key === "done-when") {
        section = "done_when";
        continue;
      }
      if (key === "out-of-scope") {
        section = "out_of_scope";
        if (rest) card.outOfScope = rest;
        continue;
      }
      if (key === "not-tested") {
        section = "not_tested";
        if (rest) card.notTested = rest;
        continue;
      }
      if (key === "failed-treatments") {
        section = "failed_treatments";
        continue;
      }
      section = "extra";
      extraKey = key;
      if (rest) extraBuf.push(rest);
      continue;
    }
    if (section === "done_when") {
      const t = stripBullet(line);
      if (!t) continue;
      card.doneWhen.push(t);
      continue;
    }
    if (section === "out_of_scope") {
      if (line.trim()) card.outOfScope = card.outOfScope ? `${card.outOfScope}\n${line}` : line;
      continue;
    }
    if (section === "not_tested") {
      if (line.trim()) card.notTested = card.notTested ? `${card.notTested}\n${line}` : line;
      continue;
    }
    if (section === "failed_treatments") {
      const m = stripBullet(line).match(/^([^:]+):\s*(.*)$/);
      if (m?.[1]) card.failedTreatments.push({ name: m[1].trim(), produced: (m[2] ?? "").trim() });
      continue;
    }
    if (section === "extra" && extraKey) extraBuf.push(line);
  }
  flushExtra();

  if (fields?.objective) card.objective = fields.objective;
  if (fields?.doneWhen?.length) card.doneWhen = fields.doneWhen;
  if (fields?.writeRoots?.length) card.writeRoots = fields.writeRoots;
  if (fields?.lane !== undefined) card.lane = fields.lane;
  if (fields?.knownGood) card.knownGood = fields.knownGood;
  if (fields?.outOfScope) card.outOfScope = fields.outOfScope;
  if (fields?.notTested) card.notTested = fields.notTested;
  if (fields?.failedTreatments?.length) card.failedTreatments = fields.failedTreatments;
  if (fields?.extra) card.extra = { ...card.extra, ...fields.extra };

  if (!card.objective && text.trim() && !/^## /m.test(text)) {
    card.objective = text.trim().split(/\n/)[0] ?? "";
  }
  return card;
}

export function serializeCard(card: Card): string {
  const lines: string[] = [];
  lines.push(`## objective: ${card.objective.trim()}`);
  if (card.lane) lines.push(`## lane: ${card.lane}`);
  if (card.writeRoots.length) lines.push(`## write-roots: ${card.writeRoots.join(",")}`);
  if (card.knownGood) lines.push(`## known-good: ${card.knownGood}`);
  if (card.failedTreatments.length) {
    lines.push("## failed-treatments:");
    for (const f of card.failedTreatments) lines.push(`- ${f.name}: ${f.produced}`);
  }
  lines.push("## done_when");
  for (const d of card.doneWhen) lines.push(`- ${stripBullet(d)}`);
  if (card.outOfScope) {
    lines.push("## out-of-scope");
    lines.push(card.outOfScope.trim());
  }
  if (card.notTested) {
    lines.push("## not-tested");
    lines.push(card.notTested.trim());
  }
  for (const [k, v] of Object.entries(card.extra).sort(([a], [b]) => a.localeCompare(b))) {
    if (!v) continue;
    if (v.includes("\n")) {
      lines.push(`## ${k}`);
      lines.push(v);
    } else {
      lines.push(`## ${k}: ${v}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export type CardGate = "create" | "plant";

export function assertCard(card: Card, gate: CardGate, title?: string): void {
  const titleOk = (title ?? "").trim().length > 0;
  const objective = card.objective.trim();
  if (!titleOk) throw new BoardError("invalid_card", "title required.");
  if (!objective) {
    throw new BoardError("invalid_card", "objective required — title-only cards are refused.");
  }
  if (gate === "create") return;

  const rules = card.doneWhen.map(stripBullet).filter(Boolean);
  if (!rules.length) {
    throw new BoardError("invalid_card", "Planted requires done_when TREE rules.");
  }
  let tree = 0;
  for (const r of rules) {
    assertPathRule(r);
    assertRunRule(r);
    if (treeKind(r)) {
      tree += 1;
      continue;
    }
    if (isNarrative(r)) continue;
    throw new BoardError("invalid_card", `done_when line is not a TREE or narrative prefix: ${r}`);
  }
  if (tree < 1) {
    throw new BoardError(
      "invalid_card",
      "Planted requires ≥1 TREE done_when (exists:/run:/changed:/live:/…).",
    );
  }
}

export function cardFromInput(input: {
  title?: string | undefined;
  body?: string | undefined;
  objective?: string | undefined;
  doneWhen?: string[] | undefined;
  writeRoots?: string[] | undefined;
  lane?: string | null | undefined;
  knownGood?: string | undefined;
  outOfScope?: string | undefined;
  notTested?: string | undefined;
  extra?: Record<string, string> | undefined;
}): Card {
  return parseCard(input.body ?? "", {
    objective: input.objective,
    doneWhen: input.doneWhen,
    writeRoots: input.writeRoots,
    lane: input.lane,
    knownGood: input.knownGood,
    outOfScope: input.outOfScope,
    notTested: input.notTested,
    extra: input.extra,
  });
}
