import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("release version validation", () => {
  test("previews the date/build release without modifying any manifest", () => {
    const fixture = mkdtempSync(join(tmpdir(), "fhold-release-preview-"));
    mkdirSync(join(fixture, ".github"));
    writeFileSync(join(fixture, ".github/release-manifest.json"), JSON.stringify({ manifests: ["package.json"], compose: ["stack.yml"] }));
    const previous = JSON.stringify({ version: "0.1.2610081904-beta.2" });
    writeFileSync(join(fixture, "package.json"), previous);
    writeFileSync(join(fixture, "stack.yml"), 'image: fwdslsh/fhold-assistant:${FH_ASSISTANT_VERSION:-0.1.2610081904-beta.2}\n');
    const result = spawnSync(process.execPath, [join(ROOT, "scripts/bump-release.mjs")], {
      cwd: fixture,
      env: { ...process.env, STAMP: "false", VERSION: "0.2.2610081-beta.1" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.2.2610081-beta.1 (STAMP=false");
    expect(result.stdout).toContain("stack.yml");
    expect(readFileSync(join(fixture, "package.json"), "utf8")).toBe(previous);
  });
  test("rejects shell-bearing explicit versions before stamping", () => {
    const result = spawnSync(process.execPath, ["scripts/bump-release.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        STAMP: "false",
        VERSION: "1.2.3-$(id)",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot parse VERSION");
  });
});
