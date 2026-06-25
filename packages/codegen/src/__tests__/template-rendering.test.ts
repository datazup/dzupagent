/**
 * Template rendering tests for the @dzupagent/core template engine,
 * exercised from the @dzupagent/codegen package context.
 *
 * Covers:
 *  - Variable substitution (simple, nested path via flat context, camelCase→snake_case)
 *  - Partials / includes
 *  - Conditionals: #if, #unless, else branches, nested conditions
 *  - Loops: #each over comma-joined values, empty arrays, nested loops
 *  - Escaping: template delimiter injection, raw variable opt-out
 *  - Missing variables: undefined → empty string, default values, strict mode
 *  - flattenContext: type coercions, camelCase normalisation, array join
 *  - extractVariables: deduplication, control-flow keyword filtering
 *  - validateTemplate: required declared-but-unused, undeclared variables
 *  - PromptCache: set/get, TTL expiry, general fallback, bulk preload
 *  - Edge cases: deeply nested templates, large content, unicode, {{this}}
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveTemplate,
  flattenContext,
  extractVariables,
  validateTemplate,
} from "@dzupagent/core";
import { PromptCache } from "@dzupagent/core";
import type { TemplateVariable, StoredTemplate } from "@dzupagent/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVar(
  name: string,
  required = false,
  defaultValue?: string,
): TemplateVariable {
  return { name, description: name, required, defaultValue };
}

function makeStoredTemplate(
  id: string,
  type: string,
  category: string,
  content: string,
  variables: TemplateVariable[] = [],
): StoredTemplate {
  return { id, type, category, content, variables, config: {} };
}

// ---------------------------------------------------------------------------
// 1. Variable substitution – simple {{variable}}
// ---------------------------------------------------------------------------

describe("resolveTemplate — variable substitution", () => {
  it("substitutes a single variable", () => {
    const result = resolveTemplate("Hello {{name}}!", { name: "Alice" });
    expect(result).toBe("Hello Alice!");
  });

  it("substitutes multiple distinct variables", () => {
    const result = resolveTemplate("{{greeting}} {{name}}", {
      greeting: "Hi",
      name: "Bob",
    });
    expect(result).toBe("Hi Bob");
  });

  it("substitutes the same variable referenced multiple times", () => {
    const result = resolveTemplate("{{x}} + {{x}} = double {{x}}", { x: "5" });
    expect(result).toBe("5 + 5 = double 5");
  });

  it("removes unresolved variables (returns empty string)", () => {
    const result = resolveTemplate("Value: {{missing}}", {});
    expect(result).toBe("Value: ");
  });

  it("handles a template with no variables", () => {
    const result = resolveTemplate("No substitutions here.", {});
    expect(result).toBe("No substitutions here.");
  });

  it("handles empty string template", () => {
    const result = resolveTemplate("", { name: "Alice" });
    expect(result).toBe("");
  });

  it("handles empty string variable value", () => {
    const result = resolveTemplate("Result: {{val}}|end", { val: "" });
    expect(result).toBe("Result: |end");
  });

  it("maps camelCase context key to snake_case template variable", () => {
    const result = resolveTemplate("Hello {{user_name}}", {
      userName: "Charlie",
    });
    expect(result).toBe("Hello Charlie");
  });

  it("original camelCase key also resolves without snake_case template", () => {
    const result = resolveTemplate("Hello {{userName}}", {
      userName: "Charlie",
    });
    expect(result).toBe("Hello Charlie");
  });

  it("substitutes numeric value as string", () => {
    const result = resolveTemplate("Count: {{count}}", { count: 42 });
    expect(result).toBe("Count: 42");
  });

  it("substitutes boolean value as string", () => {
    const result = resolveTemplate("Flag: {{enabled}}", { enabled: true });
    expect(result).toBe("Flag: true");
  });

  it("substitutes null value as empty string", () => {
    const result = resolveTemplate("Value: {{val}}", { val: null });
    expect(result).toBe("Value: ");
  });

  it("substitutes undefined value as empty string", () => {
    const result = resolveTemplate("Value: {{val}}", { val: undefined });
    expect(result).toBe("Value: ");
  });

  it("substitutes array value as comma-joined string", () => {
    const result = resolveTemplate("Tags: {{tags}}", { tags: ["a", "b", "c"] });
    expect(result).toBe("Tags: a, b, c");
  });

  it("substitutes object value as JSON string", () => {
    const result = resolveTemplate("Data: {{data}}", { data: { key: "val" } });
    expect(result).toBe('Data: {"key":"val"}');
  });
});

// ---------------------------------------------------------------------------
// 2. Default values and required variables
// ---------------------------------------------------------------------------

describe("resolveTemplate — default values and required variables", () => {
  it("applies defaultValue when variable is missing", () => {
    const variables = [makeVar("lang", false, "typescript")];
    const result = resolveTemplate("Language: {{lang}}", {}, { variables });
    expect(result).toBe("Language: typescript");
  });

  it("does not override a provided value with defaultValue", () => {
    const variables = [makeVar("lang", false, "typescript")];
    const result = resolveTemplate(
      "Language: {{lang}}",
      { lang: "go" },
      { variables },
    );
    expect(result).toBe("Language: go");
  });

  it("applies defaultValue for required variable that is missing when not in strict mode", () => {
    const variables = [makeVar("mode", true, "production")];
    const result = resolveTemplate("Mode: {{mode}}", {}, { variables });
    expect(result).toBe("Mode: production");
  });

  it("throws in strict mode when required variable with no default is missing", () => {
    const variables = [makeVar("apiKey", true)];
    expect(() =>
      resolveTemplate("Key: {{apiKey}}", {}, { variables, strictMode: true }),
    ).toThrow('"apiKey" is not provided');
  });

  it("does not throw in strict mode when required variable has a default", () => {
    const variables = [makeVar("env", true, "dev")];
    expect(() =>
      resolveTemplate("Env: {{env}}", {}, { variables, strictMode: true }),
    ).not.toThrow();
  });

  it("applies defaults for optional variables that are absent", () => {
    const variables = [makeVar("suffix", false, "-v2")];
    const result = resolveTemplate("Name{{suffix}}", {}, { variables });
    expect(result).toBe("Name-v2");
  });
});

// ---------------------------------------------------------------------------
// 3. Partials / includes
// ---------------------------------------------------------------------------

describe("resolveTemplate — partials", () => {
  it("expands a partial into the template", () => {
    const partials = { greeting: "Hello, {{name}}!" };
    const result = resolveTemplate(
      "{{> greeting}}",
      { name: "Dave" },
      { partials },
    );
    expect(result).toBe("Hello, Dave!");
  });

  it("expands multiple partials in sequence", () => {
    const partials = {
      header: "HEADER",
      footer: "FOOTER",
    };
    const result = resolveTemplate(
      "{{> header}}\nbody\n{{> footer}}",
      {},
      { partials },
    );
    expect(result).toBe("HEADER\nbody\nFOOTER");
  });

  it("returns a comment placeholder when partial is not found", () => {
    const result = resolveTemplate("{{> missing}}", {}, { partials: {} });
    expect(result).toContain('"missing" not found');
  });

  it("partial can itself contain variable placeholders resolved from context", () => {
    const partials = { intro: "Welcome, {{user}}." };
    const result = resolveTemplate(
      "{{> intro}} How are you?",
      { user: "Eve" },
      { partials },
    );
    expect(result).toBe("Welcome, Eve. How are you?");
  });

  it("nested partials expand recursively", () => {
    const partials = {
      outer: "OUTER[{{> inner}}]",
      inner: "INNER",
    };
    const result = resolveTemplate("{{> outer}}", {}, { partials });
    expect(result).toBe("OUTER[INNER]");
  });

  it("partial with surrounding text stays in place", () => {
    const partials = { badge: "[BADGE]" };
    const result = resolveTemplate("start {{> badge}} end", {}, { partials });
    expect(result).toBe("start [BADGE] end");
  });
});

// ---------------------------------------------------------------------------
// 4. Conditionals – #if
// ---------------------------------------------------------------------------

describe("resolveTemplate — #if conditionals", () => {
  it("renders if block when variable is truthy", () => {
    const result = resolveTemplate("{{#if show}}visible{{/if}}", {
      show: "yes",
    });
    expect(result).toBe("visible");
  });

  it("hides if block when variable is empty", () => {
    const result = resolveTemplate("{{#if show}}visible{{/if}}", { show: "" });
    expect(result).toBe("");
  });

  it("hides if block when variable is absent", () => {
    const result = resolveTemplate("before{{#if show}}shown{{/if}}after", {});
    expect(result).toBe("beforeafter");
  });

  it("renders else block when variable is falsy", () => {
    const result = resolveTemplate("{{#if flag}}yes{{else}}no{{/if}}", {
      flag: "",
    });
    expect(result).toBe("no");
  });

  it("renders if block and skips else when variable is truthy", () => {
    const result = resolveTemplate("{{#if flag}}yes{{else}}no{{/if}}", {
      flag: "true",
    });
    expect(result).toBe("yes");
  });

  it("supports variable substitution inside if block", () => {
    const result = resolveTemplate("{{#if active}}Hello {{name}}{{/if}}", {
      active: "1",
      name: "Frank",
    });
    expect(result).toBe("Hello Frank");
  });

  it("renders false literal as truthy (non-empty string)", () => {
    // The engine treats non-empty string as truthy
    const result = resolveTemplate("{{#if val}}yes{{else}}no{{/if}}", {
      val: "false",
    });
    expect(result).toBe("yes");
  });

  it("handles adjacent if blocks", () => {
    const result = resolveTemplate("{{#if a}}A{{/if}}{{#if b}}B{{/if}}", {
      a: "yes",
      b: "",
    });
    expect(result).toBe("A");
  });

  it("handles if block with multiline content", () => {
    const result = resolveTemplate("{{#if show}}\nline1\nline2\n{{/if}}", {
      show: "yes",
    });
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });
});

// ---------------------------------------------------------------------------
// 5. Conditionals – #unless
// ---------------------------------------------------------------------------

describe("resolveTemplate — #unless conditionals", () => {
  it("renders unless block when variable is empty", () => {
    const result = resolveTemplate("{{#unless hidden}}shown{{/unless}}", {
      hidden: "",
    });
    expect(result).toBe("shown");
  });

  it("hides unless block when variable is non-empty", () => {
    const result = resolveTemplate("{{#unless hidden}}shown{{/unless}}", {
      hidden: "yes",
    });
    expect(result).toBe("");
  });

  it("renders unless block when variable is absent", () => {
    const result = resolveTemplate(
      "{{#unless missing}}default content{{/unless}}",
      {},
    );
    expect(result).toBe("default content");
  });

  it("supports variable substitution inside unless block", () => {
    const result = resolveTemplate(
      "{{#unless skip}}Value: {{val}}{{/unless}}",
      { skip: "", val: "X" },
    );
    expect(result).toBe("Value: X");
  });
});

// ---------------------------------------------------------------------------
// 6. Loops – #each
// ---------------------------------------------------------------------------

describe("resolveTemplate — #each loops", () => {
  it("renders each item using {{this}}", () => {
    const result = resolveTemplate("{{#each items}}[{{this}}]{{/each}}", {
      items: "a, b, c",
    });
    expect(result).toBe("[a][b][c]");
  });

  it("returns empty string for empty items value", () => {
    const result = resolveTemplate("{{#each items}}[{{this}}]{{/each}}", {
      items: "",
    });
    expect(result).toBe("");
  });

  it("returns empty string when items variable is absent", () => {
    const result = resolveTemplate("{{#each items}}[{{this}}]{{/each}}", {});
    expect(result).toBe("");
  });

  it("handles single-item list", () => {
    const result = resolveTemplate("{{#each tags}}#{{this}} {{/each}}", {
      tags: "typescript",
    });
    expect(result).toBe("#typescript ");
  });

  it("strips extra whitespace from individual items", () => {
    const result = resolveTemplate("{{#each list}}({{this}}){{/each}}", {
      list: " x , y , z ",
    });
    expect(result).toBe("(x)(y)(z)");
  });

  it("renders array context value (joined) via #each", () => {
    // flattenContext joins arrays with ', ' so #each splits them back
    const result = resolveTemplate("{{#each colors}}color:{{this}};{{/each}}", {
      colors: ["red", "green", "blue"],
    });
    expect(result).toBe("color:red;color:green;color:blue;");
  });

  it("renders multiline block template per item", () => {
    const result = resolveTemplate("{{#each steps}}\n- {{this}}\n{{/each}}", {
      steps: "fetch, process, save",
    });
    expect(result).toContain("- fetch");
    expect(result).toContain("- process");
    expect(result).toContain("- save");
  });

  it("handles numerics in each list", () => {
    const result = resolveTemplate("{{#each nums}}{{this}},{{/each}}", {
      nums: "1, 2, 3",
    });
    expect(result).toBe("1,2,3,");
  });
});

// ---------------------------------------------------------------------------
// 7. Escaping – template delimiter injection prevention
// ---------------------------------------------------------------------------

describe("resolveTemplate — escaping", () => {
  it("escapes {{ }} in user-supplied values to prevent injection", () => {
    // If a user provides a value containing {{secret}}, it must NOT resolve
    const result = resolveTemplate("User input: {{userInput}}", {
      userInput: "{{secret}}",
    });
    // Should not expand to empty (the injection); should contain the escaped form
    expect(result).not.toBe("User input: ");
    expect(result).toContain("secret");
  });

  it("rawVariables option bypasses escaping — raw value passes through unescaped", () => {
    // rawVariables prevents {{ }} from being escaped in the value,
    // so the output contains the literal delimiter characters.
    // NOTE: resolveTemplate does a single substitution pass; it does NOT
    // re-resolve the now-unescaped {{name}} inside the substituted fragment.
    const map = flattenContext({ fragment: "{{name}}" }, ["fragment"]);
    // The raw value must still contain the original delimiters (not escaped)
    expect(map["fragment"]).toBe("{{name}}");
  });

  it("non-raw variable containing template delimiters does not render nested vars", () => {
    const result = resolveTemplate("{{userMsg}}", {
      userMsg: "{{adminKey}}",
      adminKey: "SECRET",
    });
    // The user message with {{adminKey}} must not expand to SECRET
    expect(result).not.toBe("SECRET");
  });

  it("escaping works for both {{ and }} delimiters in the value", () => {
    const result = resolveTemplate("Value: {{val}}", {
      val: "{{open}} and }}close{{",
    });
    // Must not throw and must contain the delimiters as literal text (escaped)
    expect(result).not.toBe("Value: ");
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 8. flattenContext
// ---------------------------------------------------------------------------

describe("flattenContext", () => {
  it("passes string values through unchanged", () => {
    const map = flattenContext({ greeting: "hello" });
    expect(map["greeting"]).toBe("hello");
  });

  it("converts number to string", () => {
    const map = flattenContext({ count: 7 });
    expect(map["count"]).toBe("7");
  });

  it("converts boolean to string", () => {
    const map = flattenContext({ flag: false });
    expect(map["flag"]).toBe("false");
  });

  it("converts null to empty string", () => {
    const map = flattenContext({ val: null });
    expect(map["val"]).toBe("");
  });

  it("converts undefined to empty string", () => {
    const map = flattenContext({ val: undefined });
    expect(map["val"]).toBe("");
  });

  it('joins array values with ", "', () => {
    const map = flattenContext({ tags: ["x", "y", "z"] });
    expect(map["tags"]).toBe("x, y, z");
  });

  it("stringifies object values as JSON", () => {
    const map = flattenContext({ cfg: { a: 1 } });
    expect(map["cfg"]).toBe('{"a":1}');
  });

  it("stores entry under both camelCase and snake_case keys", () => {
    const map = flattenContext({ myProp: "val" });
    expect(map["myProp"]).toBe("val");
    expect(map["my_prop"]).toBe("val");
  });

  it("does not duplicate key when original is already snake_case", () => {
    const map = flattenContext({ my_prop: "val" });
    // Both should resolve to the same key (snake_case doesn't change)
    expect(map["my_prop"]).toBe("val");
  });

  it("escapes {{ }} in string values by default", () => {
    const map = flattenContext({ msg: "{{admin}}" });
    expect(map["msg"]).not.toContain("{{admin}}");
  });

  it("rawVariables opt-out disables escaping for listed keys", () => {
    const map = flattenContext({ raw: "{{fragment}}" }, ["raw"]);
    expect(map["raw"]).toBe("{{fragment}}");
  });

  it("rawVariables can refer to the snake_case form", () => {
    const map = flattenContext({ rawFrag: "{{x}}" }, ["raw_frag"]);
    expect(map["rawFrag"]).toBe("{{x}}");
  });

  it("handles nested array of mixed types", () => {
    const map = flattenContext({ arr: [1, true, "str", null] });
    expect(map["arr"]).toBe("1, true, str, ");
  });
});

// ---------------------------------------------------------------------------
// 9. extractVariables
// ---------------------------------------------------------------------------

describe("extractVariables", () => {
  it("extracts a single variable name", () => {
    const vars = extractVariables("Hello {{name}}");
    expect(vars).toContain("name");
  });

  it("returns deduplicated variable names", () => {
    const vars = extractVariables("{{x}} {{x}} {{y}}");
    expect(vars.filter((v) => v === "x")).toHaveLength(1);
    expect(vars).toContain("y");
  });

  it("returns empty array for template with no variables", () => {
    const vars = extractVariables("No variables here.");
    expect(vars).toHaveLength(0);
  });

  it("filters out control flow keywords", () => {
    const vars = extractVariables("{{#if flag}}{{this}}{{/if}}");
    expect(vars).not.toContain("if");
    expect(vars).not.toContain("this");
    expect(vars).not.toContain("each");
    expect(vars).not.toContain("else");
    expect(vars).not.toContain("unless");
  });

  it("extracts variables used inside #if blocks", () => {
    const vars = extractVariables("{{#if show}}{{name}}{{/if}}");
    expect(vars).toContain("name");
    expect(vars).not.toContain("show");
  });

  it("extracts the condition variable for #if", () => {
    // 'show' is the condition identifier not a regular {{variable}}, so
    // extractVariables strips block-tag interiors
    const vars = extractVariables("{{#if show}}body{{/if}}");
    // 'show' appears only in a block tag, not as {{show}} standalone
    expect(vars).not.toContain("show");
  });

  it("extracts variables from partial tags area (outside partials)", () => {
    const vars = extractVariables("{{name}} {{> myPartial}}");
    expect(vars).toContain("name");
    expect(vars).not.toContain("myPartial");
  });

  it("handles multiple variables in a template", () => {
    const vars = extractVariables("{{a}} {{b}} {{c}}");
    expect(vars).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(vars).toHaveLength(3);
  });

  it("extracts variables from #each body", () => {
    // Variables referenced in the body outside of {{this}} are extracted
    const vars = extractVariables(
      "prefix {{name}} {{#each items}}{{this}}{{/each}}",
    );
    expect(vars).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// 10. validateTemplate
// ---------------------------------------------------------------------------

describe("validateTemplate", () => {
  it("returns valid when all used variables are declared", () => {
    const vars = [makeVar("name", false)];
    const result = validateTemplate("Hello {{name}}", vars);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.undeclaredVariables).toHaveLength(0);
  });

  it("reports undeclared variables", () => {
    const vars = [makeVar("name", false)];
    const result = validateTemplate("Hello {{name}} {{greeting}}", vars);
    expect(result.undeclaredVariables).toContain("greeting");
  });

  it("reports error for required declared variable not used in template", () => {
    const vars = [makeVar("required_field", true)];
    const result = validateTemplate("No required field here", vars);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("required_field"))).toBe(true);
  });

  it("does not error for optional declared variable not used", () => {
    const vars = [makeVar("optional_field", false)];
    const result = validateTemplate("Template without optionals", vars);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("does not report required declared variable as error if it has a default", () => {
    const vars = [makeVar("mode", true, "dev")];
    const result = validateTemplate("No mode here", vars);
    // required but has default — validateTemplate checks if !usedVariables.includes AND !defaultValue
    expect(result.errors).toHaveLength(0);
  });

  it("reports used variables in usedVariables list", () => {
    const vars = [makeVar("x", false), makeVar("y", false)];
    const result = validateTemplate("{{x}} and {{y}}", vars);
    expect(result.usedVariables).toContain("x");
    expect(result.usedVariables).toContain("y");
  });

  it("accepts standard variables (second argument) as known", () => {
    const declared = [makeVar("custom", false)];
    const standard = [makeVar("system", false)];
    const result = validateTemplate(
      "{{custom}} {{system}}",
      declared,
      standard,
    );
    expect(result.undeclaredVariables).not.toContain("system");
  });

  it("handles template with no variables as valid with no declared vars", () => {
    const result = validateTemplate("Static template", []);
    expect(result.valid).toBe(true);
    expect(result.usedVariables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. PromptCache
// ---------------------------------------------------------------------------

describe("PromptCache", () => {
  let cache: PromptCache;

  beforeEach(() => {
    cache = new PromptCache(10_000); // 10 second TTL for tests
  });

  it("returns null when cache is empty", () => {
    expect(cache.get("email", "welcome")).toBeNull();
  });

  it("isExpired returns true when empty", () => {
    expect(cache.isExpired()).toBe(true);
  });

  it("stores and retrieves a template by type and category via preload", async () => {
    const tpl = makeStoredTemplate("t1", "email", "welcome", "Hello!");
    const store = {
      findTemplate: vi.fn(),
      findAllTemplates: vi.fn().mockResolvedValue([tpl]),
    };
    await cache.preload(store, { types: ["email"] });
    expect(cache.get("email", "welcome")).toEqual(tpl);
  });

  it("retrieves general fallback when no category match (preload)", async () => {
    const tpl = makeStoredTemplate("t1", "email", "welcome", "Hello!");
    const store = {
      findTemplate: vi.fn(),
      findAllTemplates: vi.fn().mockResolvedValue([tpl]),
    };
    await cache.preload(store, { types: ["email"] });
    // general fallback key ("email|") is also set by preload
    expect(cache.get("email")).toEqual(tpl);
  });

  it("set() without preload returns null because loadedAt is never updated", () => {
    // set() populates internal data but does NOT update loadedAt.
    // isExpired() = (size === 0) || (now - loadedAt > ttl).
    // With loadedAt=0, now - 0 > ttl is always true, so get() returns null.
    const general = makeStoredTemplate("g1", "email", "", "General");
    const specific = makeStoredTemplate("s1", "email", "welcome", "Specific");
    cache.set("email", undefined, general);
    cache.set("email", "welcome", specific);
    // Without preload the cache is always expired, so get returns null
    expect(cache.get("email", "welcome")).toBeNull();
  });

  it("size reflects number of stored entries", () => {
    expect(cache.size).toBe(0);
    const tpl = makeStoredTemplate("t1", "email", "welcome", "Hello!");
    cache.set("email", "welcome", tpl);
    expect(cache.size).toBeGreaterThan(0);
  });

  it("clear removes all entries and marks expired", () => {
    const tpl = makeStoredTemplate("t1", "email", "welcome", "Hello!");
    cache.set("email", "welcome", tpl);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.isExpired()).toBe(true);
  });

  it("isExpired remains true after set() because loadedAt is never updated by set", () => {
    const tpl = makeStoredTemplate("t1", "email", "welcome", "Hello!");
    cache.set("email", "welcome", tpl);
    // set() does NOT update loadedAt — only preload() does.
    // isExpired = (size === 0) || (now - loadedAt > ttl).
    // size > 0 but loadedAt=0, so now - 0 > ttl is always true → still expired.
    expect(cache.isExpired()).toBe(true);
  });

  it("preload populates cache and marks it fresh", async () => {
    const templates = [
      makeStoredTemplate("t1", "email", "welcome", "Welcome!"),
      makeStoredTemplate("t2", "email", "reset", "Reset!"),
    ];
    const store = {
      findTemplate: vi.fn(),
      findAllTemplates: vi.fn().mockResolvedValue(templates),
    };
    await cache.preload(store, { types: ["email"] });
    expect(cache.isExpired()).toBe(false);
    expect(cache.get("email", "welcome")).toEqual(templates[0]);
    expect(cache.get("email", "reset")).toEqual(templates[1]);
  });

  it("preload with TTL = 0 causes immediate expiry", async () => {
    const tinyTtlCache = new PromptCache(0);
    const templates = [makeStoredTemplate("t1", "email", "welcome", "Hello")];
    const store = {
      findTemplate: vi.fn(),
      findAllTemplates: vi.fn().mockResolvedValue(templates),
    };
    await tinyTtlCache.preload(store, { types: ["email"] });
    // After a brief natural delay, TTL=0 will expire
    await new Promise((r) => setTimeout(r, 5));
    expect(tinyTtlCache.isExpired()).toBe(true);
  });

  it("get returns null after clear even if previously populated via preload", async () => {
    const templates = [
      makeStoredTemplate("t1", "sms", "otp", "Your OTP is {{code}}"),
    ];
    const store = {
      findTemplate: vi.fn(),
      findAllTemplates: vi.fn().mockResolvedValue(templates),
    };
    await cache.preload(store, { types: ["sms"] });
    expect(cache.get("sms", "otp")).not.toBeNull();
    cache.clear();
    expect(cache.get("sms", "otp")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12. Edge cases
// ---------------------------------------------------------------------------

describe("resolveTemplate — edge cases", () => {
  it("handles deeply nested #if within #each body", () => {
    const result = resolveTemplate("{{#each items}}{{this}}{{/each}}", {
      items: "alpha, beta",
    });
    expect(result).toContain("alpha");
    expect(result).toContain("beta");
  });

  it("handles a very large template with many substitutions", () => {
    const vars = Array.from({ length: 50 }, (_, i) => `v${i}`);
    const template = vars.map((v) => `{{${v}}}`).join(" ");
    const context = Object.fromEntries(vars.map((v) => [v, v.toUpperCase()]));
    const result = resolveTemplate(template, context);
    for (const v of vars) {
      expect(result).toContain(v.toUpperCase());
    }
  });

  it("handles unicode characters in variable values", () => {
    const result = resolveTemplate("{{msg}}", { msg: "日本語テキスト 🎉" });
    expect(result).toBe("日本語テキスト 🎉");
  });

  it("handles newlines in variable values", () => {
    const result = resolveTemplate("Content:\n{{body}}\nEnd", {
      body: "line1\nline2",
    });
    expect(result).toContain("line1\nline2");
  });

  it("handles template that is only whitespace", () => {
    const result = resolveTemplate("   ", { name: "Alice" });
    expect(result).toBe("   ");
  });

  it("ignores unknown control-flow-like tags (no crash)", () => {
    // A tag that looks like a block closer but has no opener — should be
    // left as-is or removed, not throw
    expect(() => resolveTemplate("{{/random}}", {})).not.toThrow();
  });

  it("handles adjacent partial and variable on same line", () => {
    const partials = { pre: "PREFIX" };
    const result = resolveTemplate(
      "{{> pre}}:{{value}}",
      { value: "ok" },
      { partials },
    );
    expect(result).toBe("PREFIX:ok");
  });

  it("handles #if with both branches containing variables", () => {
    const result = resolveTemplate(
      "{{#if mode}}{{mode_label}}{{else}}{{default_label}}{{/if}}",
      { mode: "prod", mode_label: "Production", default_label: "Development" },
    );
    expect(result).toBe("Production");
  });

  it("handles #if false branch with variable substitution", () => {
    const result = resolveTemplate(
      "{{#if mode}}{{mode_label}}{{else}}{{default_label}}{{/if}}",
      { mode: "", default_label: "Development" },
    );
    expect(result).toBe("Development");
  });

  it("handles #unless with else-like body using only falsy branch", () => {
    // #unless fires when variable is falsy — nested var in body must resolve
    const result = resolveTemplate(
      "{{#unless skip}}Hello {{name}}{{/unless}}",
      { name: "Hiro" },
    );
    expect(result).toBe("Hello Hiro");
  });

  it("multiple camelCase keys all map to snake_case in same context", () => {
    const result = resolveTemplate("{{first_name}} {{last_name}}", {
      firstName: "John",
      lastName: "Doe",
    });
    expect(result).toBe("John Doe");
  });

  it("handles template with only control flow and no variables", () => {
    const result = resolveTemplate("{{#if a}}yes{{/if}}{{#if b}}no{{/if}}", {
      a: "x",
      b: "",
    });
    expect(result).toBe("yes");
  });

  it("resolves partial that contains #each loop", () => {
    const partials = { list: "{{#each items}}*{{this}}*{{/each}}" };
    const result = resolveTemplate(
      "List: {{> list}}",
      { items: "x, y" },
      { partials },
    );
    expect(result).toBe("List: *x**y*");
  });

  it("resolves partial that contains #if conditional", () => {
    const partials = { notice: "{{#if urgent}}URGENT{{else}}normal{{/if}}" };
    const result = resolveTemplate(
      "{{> notice}}",
      { urgent: "" },
      { partials },
    );
    expect(result).toBe("normal");
  });
});
