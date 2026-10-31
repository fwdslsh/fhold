import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("release version validation", () => {
  test("0.4 MMNN stamping crosses from 0.3 and preserves schemas, channels and Compose", () => {
    const fixture = mkdtempSync(join(tmpdir(), "fhold-mmnn-release-"));
    try {
      mkdirSync(join(fixture, ".github"));
      writeFileSync(join(fixture, ".github/release-manifest.json"), JSON.stringify({ manifests: ["package.json"], compose: ["stack.yml"] }));
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "0.3.261013-beta", schemaVersion: 3 }));
      writeFileSync(join(fixture, "stack.yml"), 'image: fwdslsh/fhold-assistant:${FH_ASSISTANT_VERSION:-0.3.261012-beta}\n');
      const run = (value: string) => spawnSync(process.execPath, [join(ROOT, "scripts/bump-release.mjs")], { cwd: fixture, env: { ...process.env, SCOPE: "full", STAMP: "true", VERSION: value }, encoding: "utf8" });
      for (const value of ["0.4.1001-beta", "0.4.1002-rc", "0.4.1101", "0.4.1299", "0.5.101"]) {
        expect(run(value).status).toBe(0);
        expect(JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"))).toEqual({ version: value, schemaVersion: 3 });
        expect(readFileSync(join(fixture, "stack.yml"), "utf8")).toContain(value);
      }
      for (const value of ["0.5.101-beta", "0.5.0102", "0.5.1000", "0.5.261001"]) expect(run(value).status).toBe(1);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  test("monthly full stamping advances October daily defaults and preserves schemas", () => {
    const fixture = mkdtempSync(join(tmpdir(), "fhold-monthly-release-"));
    try {
      mkdirSync(join(fixture, ".github"));
      writeFileSync(join(fixture, ".github/release-manifest.json"), JSON.stringify({ manifests: ["package.json", "plugin.json"], compose: ["stack.yml"] }));
      for (const file of ["package.json", "plugin.json"]) writeFileSync(join(fixture, file), JSON.stringify({ version: "0.2.2610211-beta.13", schemaVersion: 3 }));
      writeFileSync(join(fixture, "stack.yml"), 'image: fwdslsh/fhold-assistant:${FH_ASSISTANT_VERSION:-0.2.2610211-beta.13}\n');
      const run = (value: string) => spawnSync(process.execPath, [join(ROOT, "scripts/bump-release.mjs")], { cwd: fixture, env: { ...process.env, STAMP: "true", VERSION: value }, encoding: "utf8" });
      expect(run("0.3.261000-beta").status).toBe(0);
      for (const file of ["package.json", "plugin.json"]) expect(JSON.parse(readFileSync(join(fixture, file), "utf8"))).toEqual({ version: "0.3.261000-beta", schemaVersion: 3 });
      expect(readFileSync(join(fixture, "stack.yml"), "utf8")).toContain("0.3.261000-beta");
      expect(run("0.3.261000-beta").status).toBe(0);
      expect(run("0.3.261000-rc").status).toBe(1);
      expect(JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")).version).toBe("0.3.261000-beta");
      expect(run("0.3.261001-rc").status).toBe(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  test("tooling stamping preserves runtime manifests and Compose defaults", () => {
    const fixture = mkdtempSync(join(tmpdir(), "fhold-release-preview-"));
    try {
      mkdirSync(join(fixture, ".github"));
      writeFileSync(join(fixture, ".github/release-manifest.json"), JSON.stringify({ manifests: ["package.json", "runtime.json"], toolingManifests: ["package.json"], compose: ["stack.yml"] }));
      const previous = JSON.stringify({ version: "0.2.2610112-beta.8" });
      writeFileSync(join(fixture, "package.json"), previous);
      writeFileSync(join(fixture, "runtime.json"), previous);
      writeFileSync(join(fixture, "stack.yml"), 'image: fwdslsh/fhold-assistant:${FH_ASSISTANT_VERSION:-0.2.2610112-beta.8}\n');
      const result = spawnSync(process.execPath, [join(ROOT, "scripts/bump-release.mjs")], { cwd: fixture, env: { ...process.env, SCOPE: "tools", STAMP: "true", VERSION: "0.2.2610121-beta.9" }, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")).version).toBe("0.2.2610121-beta.9");
      expect(readFileSync(join(fixture, "runtime.json"), "utf8")).toBe(previous);
      expect(readFileSync(join(fixture, "stack.yml"), "utf8")).toContain("beta.8");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
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
