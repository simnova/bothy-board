/**
 * Cellix-style ArchUnit fitness tests for MCP tool names.
 * Grok identifiers: ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectFiles } from "archunit";
import { BOTHY_MCP_TOOL_RE, GROK_TOOL_NAME_RE, PAT_SCOPES } from "../scopes.ts";

const QUOTED_TOOL = /"(bothy-board[._][^"]+)"/g;
const COMMAND_TOOL = /\bbothy-board(?:[._][A-Za-z][A-Za-z0-9]*)+_?\b/g;

function isTestFile(path: string): boolean {
  return /\.test\.ts$/.test(path) || /archunit-tests\//.test(path);
}

describe("MCP naming conventions", () => {
  test("PAT_SCOPES tools are Grok-safe BothyBoard names", () => {
    const violations: string[] = [];
    for (const scope of PAT_SCOPES) {
      for (const tool of scope.tools) {
        if (!GROK_TOOL_NAME_RE.test(tool) || !BOTHY_MCP_TOOL_RE.test(tool)) {
          violations.push(`[scopes] ${scope.id} tool "${tool}"`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test("quoted bothy-board tool tokens in production TS are Grok-safe", async () => {
    const violations: string[] = [];
    let matched = false;
    await projectFiles()
      .inPath("src/**/*.ts")
      .should()
      .adhereTo((file) => {
        if (isTestFile(file.path)) return true;
        matched = true;
        let ok = true;
        for (const match of file.content.matchAll(QUOTED_TOOL)) {
          const token = match[1];
          if (token.includes(".")) continue;
          if (!GROK_TOOL_NAME_RE.test(token) || !BOTHY_MCP_TOOL_RE.test(token)) {
            violations.push(`[${file.path}] "${token}"`);
            ok = false;
          }
        }
        return ok;
      }, "Quoted MCP tool tokens must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$ and bothy-board_<segment>+")
      .check();
    assert.equal(matched, true);
    assert.deepEqual(violations, []);
  });

  test("spawn/resume commands mention Grok-safe tool names", async () => {
    const violations: string[] = [];
    let matched = false;
    await projectFiles()
      .inPath("src/sessions.ts")
      .should()
      .adhereTo((file) => {
        matched = true;
        let ok = true;
        for (const match of file.content.matchAll(COMMAND_TOOL)) {
          const token = match[0];
          if (token.includes(".")) continue;
          if (!BOTHY_MCP_TOOL_RE.test(token)) {
            violations.push(`[${file.path}] command token "${token}"`);
            ok = false;
          }
        }
        return ok;
      }, "spawnCommand / resumeCommand tool tokens must not trail underscore or use dots")
      .check();
    assert.equal(matched, true);
    assert.deepEqual(violations, []);
  });
});
