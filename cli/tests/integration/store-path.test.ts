/**
 * Integration test for `sudocode store-path` — the read-only store probe the MCP
 * relies on. It must resolve git-awarely and create NOTHING.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist/cli.js"
);
const built = fs.existsSync(CLI);
const d = built ? describe : describe.skip;

function run(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

d("store-path (build the CLI before running: npm run build:cli)", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "store-path-")));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("reports not-initialized and creates nothing before init", () => {
    const { code, out } = run(repo, ["store-path", "--json"]);
    expect(code).toBe(0);
    const info = JSON.parse(out);
    expect(info.initialized).toBe(false);
    // Crucially: no store was minted as a side effect.
    expect(fs.existsSync(path.join(repo, ".git", "sudocode"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".sudocode"))).toBe(false);
  });

  it("reports the git-common store as initialized after init", () => {
    run(repo, ["init"]);
    const { out } = run(repo, ["store-path", "--json"]);
    const info = JSON.parse(out);
    expect(info.initialized).toBe(true);
    expect(info.source).toBe("git-common");
    expect(path.resolve(info.storeDir)).toBe(
      fs.realpathSync(path.join(repo, ".git", "sudocode"))
    );
  });
});
