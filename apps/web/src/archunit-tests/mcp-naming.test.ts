/**
 * Cellix-style ArchUnit fitness tests for advertised MCP tool names.
 * Grok identifiers: ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOTHY_MCP_TOOL_RE, GROK_TOOL_NAME_RE } from "@bothy-board/core/scopes";
import { projectFiles } from "archunit";

const ADVERTISED_NAME = /\bname:\s*"([^"]+)"/g;

describe("MCP naming conventions", () => {
  test("mcp.ts tools/list names match Grok identifier regex", async () => {
    const violations: string[] = [];
    let matched = false;
    await projectFiles()
      .inPath("src/lib/bothy-board/mcp.ts")
      .should()
      .adhereTo((file) => {
        matched = true;
        let ok = true;
        for (const match of file.content.matchAll(ADVERTISED_NAME)) {
          const name = match[1];
          if (!/^bothy-board[._]/.test(name)) continue;
          if (!GROK_TOOL_NAME_RE.test(name) || !BOTHY_MCP_TOOL_RE.test(name)) {
            violations.push(`[${file.path}] advertised name "${name}"`);
            ok = false;
          }
        }
        return ok;
      }, "MCP tools/list names must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$ and bothy-board_<segment>+")
      .check();
    assert.equal(matched, true);
    assert.deepEqual(violations, []);
  });

  test("mcp.ts must not advertise dotted bothy-board.* tool names", async () => {
    const violations: string[] = [];
    let matched = false;
    await projectFiles()
      .inPath("src/lib/bothy-board/mcp.ts")
      .should()
      .adhereTo((file) => {
        matched = true;
        for (const match of file.content.matchAll(ADVERTISED_NAME)) {
          const name = match[1];
          if (name.startsWith("bothy-board.")) {
            violations.push(`[${file.path}] dotted advertised name "${name}"`);
            return false;
          }
        }
        return true;
      }, "tools/list must not expose dotted bothy-board.* names")
      .check();
    assert.equal(matched, true);
    assert.deepEqual(violations, []);
  });
});
