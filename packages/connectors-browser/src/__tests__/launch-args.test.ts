import { describe, it, expect } from "vitest";
import {
  buildChromiumLaunchArgs,
  renderHostResolverRules,
} from "../browser/launch-args.js";

describe("renderHostResolverRules", () => {
  it("returns null when there is nothing to pin", () => {
    expect(renderHostResolverRules(undefined)).toBeNull();
    expect(renderHostResolverRules([])).toBeNull();
  });

  it("renders a single IPv4 pin", () => {
    expect(
      renderHostResolverRules([
        { host: "target.example.com", address: "93.184.216.34" },
      ])
    ).toBe("MAP target.example.com 93.184.216.34");
  });

  it("renders a pin with an explicit port", () => {
    expect(
      renderHostResolverRules([
        { host: "target.example.com", address: "93.184.216.34", port: 8443 },
      ])
    ).toBe("MAP target.example.com 93.184.216.34:8443");
  });

  it("brackets IPv6 replacements", () => {
    expect(
      renderHostResolverRules([
        { host: "target.example.com", address: "2606:2800:220:1:248:1893:25c8:1946" },
      ])
    ).toBe("MAP target.example.com [2606:2800:220:1:248:1893:25c8:1946]");
  });

  it("comma-joins multiple pins", () => {
    expect(
      renderHostResolverRules([
        { host: "a.example.com", address: "1.2.3.4" },
        { host: "b.example.com", address: "5.6.7.8", port: 443 },
      ])
    ).toBe("MAP a.example.com 1.2.3.4,MAP b.example.com 5.6.7.8:443");
  });

  it("accepts hyphenated hostnames", () => {
    expect(
      renderHostResolverRules([{ host: "my-app-01.example.com", address: "1.2.3.4" }])
    ).toBe("MAP my-app-01.example.com 1.2.3.4");
  });

  // --- fail-closed validation ------------------------------------------------

  it("rejects a hostname replacement (would reintroduce a second resolution)", () => {
    expect(() =>
      renderHostResolverRules([
        { host: "target.example.com", address: "attacker.example.com" },
      ])
    ).toThrow(/address must be an IPv4 or IPv6 literal/);
  });

  it("rejects wildcard host patterns", () => {
    expect(() =>
      renderHostResolverRules([{ host: "*", address: "1.2.3.4" }])
    ).toThrow(/not a plain hostname/);
    expect(() =>
      renderHostResolverRules([{ host: "*.example.com", address: "1.2.3.4" }])
    ).toThrow(/not a plain hostname/);
  });

  it("rejects rule injection through the host field", () => {
    // Without validation this would smuggle a second MAP rule into the flag.
    expect(() =>
      renderHostResolverRules([
        { host: "ok.example.com,MAP * 127.0.0.1", address: "1.2.3.4" },
      ])
    ).toThrow(/not a plain hostname/);
    expect(() =>
      renderHostResolverRules([
        { host: "ok.example.com 1.2.3.4,MAP evil.example.com", address: "1.2.3.4" },
      ])
    ).toThrow(/not a plain hostname/);
  });

  it("rejects an empty or over-long host", () => {
    expect(() =>
      renderHostResolverRules([{ host: "", address: "1.2.3.4" }])
    ).toThrow(/non-empty hostname/);
    expect(() =>
      renderHostResolverRules([
        { host: `${"a".repeat(60)}.`.repeat(5), address: "1.2.3.4" },
      ])
    ).toThrow(/non-empty hostname/);
  });

  it("rejects an out-of-range or non-integer port", () => {
    for (const port of [0, -1, 65536, 1.5]) {
      expect(() =>
        renderHostResolverRules([
          { host: "target.example.com", address: "1.2.3.4", port },
        ])
      ).toThrow(/port must be an integer in 1-65535/);
    }
  });

  it("throws on the whole set when any single rule is bad (never silently drops)", () => {
    expect(() =>
      renderHostResolverRules([
        { host: "good.example.com", address: "1.2.3.4" },
        { host: "bad.example.com", address: "not-an-ip" },
      ])
    ).toThrow(/address must be an IPv4 or IPv6 literal/);
  });
});

describe("buildChromiumLaunchArgs", () => {
  it("produces no arguments by default", () => {
    expect(buildChromiumLaunchArgs()).toEqual([]);
    expect(buildChromiumLaunchArgs({})).toEqual([]);
    expect(buildChromiumLaunchArgs({ hostResolverRules: [] })).toEqual([]);
  });

  it("renders the --host-resolver-rules flag", () => {
    expect(
      buildChromiumLaunchArgs({
        hostResolverRules: [
          { host: "target.example.com", address: "93.184.216.34" },
        ],
      })
    ).toEqual(["--host-resolver-rules=MAP target.example.com 93.184.216.34"]);
  });

  it("emits only flags it generated itself — there is no passthrough channel", () => {
    const args = buildChromiumLaunchArgs({
      hostResolverRules: [{ host: "target.example.com", address: "1.2.3.4" }],
    });
    expect(args).toHaveLength(1);
    for (const dangerous of [
      "--disable-web-security",
      "--no-sandbox",
      "--remote-debugging-port",
      "--user-data-dir",
    ]) {
      expect(args.join(" ")).not.toContain(dangerous);
    }
  });
});
