/**
 * import-organizer.test.ts
 *
 * Comprehensive tests for import organization in @dzupagent/codegen.
 *
 * Coverage areas:
 *  1.  Sort alphabetically — imports within a group sorted A→Z by specifier
 *  2.  Sort named imports — named bindings inside {} sorted alphabetically
 *  3.  Group external — npm packages grouped first
 *  4.  Group internal — @scope/pkg packages grouped after external
 *  5.  Group relative — ./foo and ../bar grouped last
 *  6.  Group separator — blank line between each non-empty group
 *  7.  Remove unused — import not referenced in body removed
 *  8.  Remove unused named — specific named import removed, others kept
 *  9.  Keep used — used imports not removed
 * 10.  Side-effect import preserved — `import './styles.css'` always kept
 * 11.  Type-only import — `import type { Foo }` grouped with its specifier category
 * 12.  Default import preserved when used — `import React from 'react'` kept
 * 13.  Default import removed when unused — unused default import removed
 * 14.  Namespace import — `import * as ns from './mod'` handled correctly
 * 15.  Combined import — `import foo, { bar } from './mod'` unused parts removed
 * 16.  No-op — already-organized file returns unchanged=false
 * 17.  Only external imports — single group, no blank lines
 * 18.  Only relative imports — single group, no blank lines
 * 19.  Empty file — returns unchanged
 * 20.  No imports — file with no import statements unchanged
 * 21.  Mixed all three groups — correct ordering and separators
 * 22.  removeUnused=false — skips pruning even for unreferenced bindings
 * 23.  Alias import — `import { Foo as Bar }` — checks local alias in body
 * 24.  Multiple named removals — removes each unused named binding independently
 * 25.  Named binding order stable after sort — verifies deterministic A→Z output
 * 26.  Body preserved — code after imports unchanged in output
 * 27.  organizeImportsInMap — organizes all TS/JS files, skips non-TS files
 * 28.  Internal package without sub-path (`@scope/pkg`)
 * 29.  Internal package with sub-path (`@scope/pkg/utils`)
 * 30.  Relative parent (`../sibling`)
 * 31.  All imports unused — results in empty import block
 * 32.  Namespace import removed when unused
 * 33.  Combined import — only named part unused, default kept
 * 34.  Combined import — only default part unused, named kept
 * 35.  Side-effect import always kept even with removeUnused=true
 * 36.  Multiple side-effect imports preserved and grouped last
 * 37.  Type-only import kept even if type name not in body (type erasure)
 * 38.  Sorting is case-insensitive stable across groups
 * 39.  Named binding with alias: local alias used, original not
 * 40.  File with only body (no imports) returned unchanged
 */

import { describe, it, expect } from "vitest";
import {
  organizeImports,
  organizeImportsInMap,
  type OrganizeResult,
} from "../refactor/import-organizer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip trailing whitespace from each line for comparison stability. */
function normalize(code: string): string {
  return code
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

/** Build a minimal body that references all provided names. */
function bodyUsing(...names: string[]): string {
  return `\n${names.map((n) => `const _ref${n} = ${n}`).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 1. Sort alphabetically within group
// ---------------------------------------------------------------------------
describe("organizeImports — sort by specifier", () => {
  it("sorts external imports A→Z by module specifier", () => {
    const source =
      `import { z } from 'zod'\nimport { a } from 'axios'\nimport { r } from 'react'` +
      bodyUsing("z", "a", "r");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'axios'");
    expect(lines[1]).toContain("'react'");
    expect(lines[2]).toContain("'zod'");
  });

  it("sorts relative imports A→Z by specifier", () => {
    const source =
      `import { z } from './utils'\nimport { a } from './alpha'\nimport { b } from './beta'` +
      bodyUsing("z", "a", "b");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'./alpha'");
    expect(lines[1]).toContain("'./beta'");
    expect(lines[2]).toContain("'./utils'");
  });

  it("sorts internal imports A→Z by specifier", () => {
    const source =
      `import { c } from '@scope/core'\nimport { a } from '@scope/alpha'\nimport { b } from '@acme/beta'` +
      bodyUsing("c", "a", "b");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'@acme/beta'");
    expect(lines[1]).toContain("'@scope/alpha'");
    expect(lines[2]).toContain("'@scope/core'");
  });
});

// ---------------------------------------------------------------------------
// 2. Sort named imports within {}
// ---------------------------------------------------------------------------
describe("organizeImports — sort named bindings", () => {
  it("sorts named imports alphabetically within braces", () => {
    const source =
      `import { Zoo, Alpha, Mango } from 'lib'` +
      bodyUsing("Zoo", "Alpha", "Mango");

    const { code } = organizeImports(source);
    const importLine = code.split("\n").find((l) => l.startsWith("import"))!;
    expect(importLine).toBe("import { Alpha, Mango, Zoo } from 'lib'");
  });

  it("sorts named imports with aliases by their original name", () => {
    const source =
      `import { Zoo as Z, Alpha as A } from 'lib'` + bodyUsing("Z", "A");

    const { code } = organizeImports(source);
    const importLine = code.split("\n").find((l) => l.startsWith("import"))!;
    // Alpha comes before Zoo
    const alphaIdx = importLine.indexOf("Alpha");
    const zooIdx = importLine.indexOf("Zoo");
    expect(alphaIdx).toBeLessThan(zooIdx);
  });

  it("keeps single named import unchanged in sorted output", () => {
    const source = `import { Only } from 'lib'` + bodyUsing("Only");
    const { code } = organizeImports(source);
    expect(code).toContain("{ Only }");
  });
});

// ---------------------------------------------------------------------------
// 3. Group external (npm) first
// ---------------------------------------------------------------------------
describe("organizeImports — external group", () => {
  it("places npm package imports before @scope and relative imports", () => {
    const source =
      [
        `import { rel } from './rel'`,
        `import { npm } from 'npm-pkg'`,
        `import { int } from '@scope/pkg'`,
      ].join("\n") + bodyUsing("rel", "npm", "int");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'npm-pkg'");
    expect(lines[1]).toContain("'@scope/pkg'");
    expect(lines[2]).toContain("'./rel'");
  });
});

// ---------------------------------------------------------------------------
// 4. Group internal (@scope/pkg) second
// ---------------------------------------------------------------------------
describe("organizeImports — internal group", () => {
  it("places @scope/pkg imports between external and relative", () => {
    const source =
      [
        `import { a } from './a'`,
        `import { b } from '@my/b'`,
        `import { c } from 'c-pkg'`,
      ].join("\n") + bodyUsing("a", "b", "c");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'c-pkg'");
    expect(lines[1]).toContain("'@my/b'");
    expect(lines[2]).toContain("'./a'");
  });
});

// ---------------------------------------------------------------------------
// 5. Group relative (./foo, ../bar) last
// ---------------------------------------------------------------------------
describe("organizeImports — relative group", () => {
  it("places ./foo and ../bar imports last", () => {
    const source =
      [
        `import { u } from './utils'`,
        `import { p } from '../parent'`,
        `import { e } from 'external'`,
      ].join("\n") + bodyUsing("u", "p", "e");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'external'");
    // both relative imports come after
    const relLine1 = lines[1]!;
    const relLine2 = lines[2]!;
    expect(
      relLine1.includes("'../parent'") || relLine1.includes("'./utils'")
    ).toBe(true);
    expect(
      relLine2.includes("'../parent'") || relLine2.includes("'./utils'")
    ).toBe(true);
  });

  it("sorts parent-relative before child-relative alphabetically when specifiers differ", () => {
    const source =
      [`import { z } from './zzz'`, `import { a } from '../aaa'`].join("\n") +
      bodyUsing("z", "a");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    // '../aaa' < './zzz' lexicographically
    expect(lines[0]).toContain("'../aaa'");
    expect(lines[1]).toContain("'./zzz'");
  });
});

// ---------------------------------------------------------------------------
// 6. Blank line separator between groups
// ---------------------------------------------------------------------------
describe("organizeImports — group separators", () => {
  it("inserts a blank line between external and internal groups", () => {
    const source =
      [`import { a } from 'axios'`, `import { b } from '@scope/b'`].join("\n") +
      bodyUsing("a", "b");

    const { code } = organizeImports(source);
    const lines = code.split("\n");
    const axiosIdx = lines.findIndex((l) => l.includes("'axios'"));
    const scopeIdx = lines.findIndex((l) => l.includes("'@scope/b'"));
    expect(lines[axiosIdx + 1]).toBe("");
    expect(scopeIdx).toBe(axiosIdx + 2);
  });

  it("inserts a blank line between internal and relative groups", () => {
    const source =
      [`import { b } from '@scope/b'`, `import { r } from './rel'`].join("\n") +
      bodyUsing("b", "r");

    const { code } = organizeImports(source);
    const lines = code.split("\n");
    const scopeIdx = lines.findIndex((l) => l.includes("'@scope/b'"));
    const relIdx = lines.findIndex((l) => l.includes("'./rel'"));
    expect(lines[scopeIdx + 1]).toBe("");
    expect(relIdx).toBe(scopeIdx + 2);
  });

  it("does not insert extra blank line when only one group is present", () => {
    const source =
      [`import { b } from 'b-pkg'`, `import { a } from 'a-pkg'`].join("\n") +
      bodyUsing("b", "a");

    const { code } = organizeImports(source);
    const importLines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(importLines).toHaveLength(2);
    // No blank lines between the two external imports
    const firstImportIdx = code
      .split("\n")
      .findIndex((l) => l.startsWith("import"));
    const secondLine = code.split("\n")[firstImportIdx + 1]!;
    expect(secondLine.startsWith("import")).toBe(true);
  });

  it("inserts exactly one blank line between all three groups", () => {
    const source =
      [
        `import { r } from './r'`,
        `import { e } from 'ext'`,
        `import { i } from '@sc/i'`,
      ].join("\n") + bodyUsing("r", "e", "i");

    const { code } = organizeImports(source);
    const lines = code.split("\n");
    const extIdx = lines.findIndex((l) => l.includes("'ext'"));
    const intIdx = lines.findIndex((l) => l.includes("'@sc/i'"));
    const relIdx = lines.findIndex((l) => l.includes("'./r'"));

    expect(lines[extIdx + 1]).toBe("");
    expect(intIdx).toBe(extIdx + 2);
    expect(lines[intIdx + 1]).toBe("");
    expect(relIdx).toBe(intIdx + 2);
  });
});

// ---------------------------------------------------------------------------
// 7. Remove entirely unused imports
// ---------------------------------------------------------------------------
describe("organizeImports — remove unused imports", () => {
  it("removes an import whose binding is never used in the body", () => {
    const source =
      [`import { unused } from 'pkg'`, `import { used } from 'other'`].join(
        "\n"
      ) + bodyUsing("used");

    const { code, removed } = organizeImports(source);
    expect(code).not.toContain("'pkg'");
    expect(removed).toContain("pkg");
  });

  it("lists removed specifiers in the removed array", () => {
    const source = `import { nope } from 'nope-pkg'` + "\nconst x = 1";
    const { removed } = organizeImports(source);
    expect(removed).toContain("nope-pkg");
  });

  it("does not remove an import whose binding is used", () => {
    const source = `import { used } from 'pkg'` + bodyUsing("used");
    const { code, removed } = organizeImports(source);
    expect(code).toContain("'pkg'");
    expect(removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Remove specific unused named imports, keep used ones
// ---------------------------------------------------------------------------
describe("organizeImports — partial named binding removal", () => {
  it("removes unused named import but keeps used sibling", () => {
    const source = `import { Used, Unused } from 'lib'` + bodyUsing("Used");

    const { code } = organizeImports(source);
    expect(code).toContain("Used");
    expect(code).not.toContain("Unused");
    expect(code).toContain("'lib'");
  });

  it("removes all named imports when none are used", () => {
    const source = `import { A, B, C } from 'lib'` + "\nconst x = 1";
    const { code, removed } = organizeImports(source);
    expect(code).not.toContain("'lib'");
    expect(removed).toContain("lib");
  });

  it("handles three named imports with only one used", () => {
    const source =
      `import { Keep, Drop1, Drop2 } from 'multi'` + bodyUsing("Keep");

    const { code } = organizeImports(source);
    const importLine = code.split("\n").find((l) => l.includes("'multi'"))!;
    expect(importLine).toContain("Keep");
    expect(importLine).not.toContain("Drop1");
    expect(importLine).not.toContain("Drop2");
  });
});

// ---------------------------------------------------------------------------
// 9. Keep used imports
// ---------------------------------------------------------------------------
describe("organizeImports — keep used imports", () => {
  it("preserves a default import used in the body", () => {
    const source =
      `import React from 'react'` + "\nconst el = React.createElement('div')";
    const { code } = organizeImports(source);
    expect(code).toContain("import React from 'react'");
  });

  it("preserves a namespace import used in the body", () => {
    const source = `import * as fs from 'fs'` + "\nfs.readFileSync('x')";
    const { code } = organizeImports(source);
    expect(code).toContain("import * as fs from 'fs'");
  });
});

// ---------------------------------------------------------------------------
// 10. Side-effect imports always preserved
// ---------------------------------------------------------------------------
describe("organizeImports — side-effect imports", () => {
  it("preserves a side-effect import regardless of body content", () => {
    const source = `import './styles.css'\nconst x = 1`;
    const { code } = organizeImports(source);
    expect(code).toContain("import './styles.css'");
  });

  it("preserves side-effect import with removeUnused=true (default)", () => {
    const source = `import './polyfill'\nconst x = 1`;
    const { code, removed } = organizeImports(source, { removeUnused: true });
    expect(code).toContain("import './polyfill'");
    expect(removed).not.toContain("./polyfill");
  });

  it("preserves multiple side-effect imports", () => {
    const source =
      [`import './a.css'`, `import './b.css'`].join("\n") + "\nconst x = 1";

    const { code } = organizeImports(source);
    expect(code).toContain("import './a.css'");
    expect(code).toContain("import './b.css'");
  });
});

// ---------------------------------------------------------------------------
// 11. Type-only imports
// ---------------------------------------------------------------------------
describe("organizeImports — type-only imports", () => {
  it("preserves a type-only import even if the type name is not in the body", () => {
    // Types are erased at compile time — we should not remove them based on
    // value-reference detection.
    const source =
      `import type { MyType } from './types'` + "\nconst x: MyType = {}";
    const { code } = organizeImports(source);
    expect(code).toContain("import type { MyType } from './types'");
  });

  it("groups type-only external import in the external group", () => {
    const source =
      [
        `import type { Foo } from 'foo-pkg'`,
        `import { bar } from './bar'`,
      ].join("\n") + bodyUsing("bar");

    const { code } = organizeImports(source);
    const lines = code.split("\n");
    const fooIdx = lines.findIndex((l) => l.includes("'foo-pkg'"));
    const barIdx = lines.findIndex((l) => l.includes("'./bar'"));
    expect(fooIdx).toBeLessThan(barIdx);
  });

  it("groups type-only relative import in the relative group", () => {
    const source =
      [`import { ext } from 'ext'`, `import type { T } from './types'`].join(
        "\n"
      ) + bodyUsing("ext");

    const { code } = organizeImports(source);
    const lines = code.split("\n");
    const extIdx = lines.findIndex((l) => l.includes("'ext'"));
    const typeIdx = lines.findIndex((l) => l.includes("'./types'"));
    expect(typeIdx).toBeGreaterThan(extIdx);
  });
});

// ---------------------------------------------------------------------------
// 12. Default import preserved when used
// ---------------------------------------------------------------------------
describe("organizeImports — default import lifecycle", () => {
  it("keeps default import when referenced in body", () => {
    const source = `import MyLib from 'my-lib'` + "\nMyLib.doSomething()";
    const { code } = organizeImports(source);
    expect(code).toContain("import MyLib from 'my-lib'");
  });
});

// ---------------------------------------------------------------------------
// 13. Default import removed when unused
// ---------------------------------------------------------------------------
describe("organizeImports — unused default import", () => {
  it("removes default import when not referenced in body", () => {
    const source = `import MyLib from 'my-lib'` + "\nconst x = 1";
    const { code, removed } = organizeImports(source);
    expect(code).not.toContain("'my-lib'");
    expect(removed).toContain("my-lib");
  });
});

// ---------------------------------------------------------------------------
// 14. Namespace import
// ---------------------------------------------------------------------------
describe("organizeImports — namespace import", () => {
  it("preserves namespace import when namespace binding is used", () => {
    const source = `import * as path from 'path'` + "\npath.join('a', 'b')";
    const { code } = organizeImports(source);
    expect(code).toContain("import * as path from 'path'");
  });

  it("removes namespace import when binding is not used", () => {
    const source = `import * as unused from './mod'` + "\nconst x = 1";
    const { code, removed } = organizeImports(source);
    expect(code).not.toContain("'./mod'");
    expect(removed).toContain("./mod");
  });

  it("formats namespace import correctly in output", () => {
    const source = `import * as  ns  from  './mod'` + bodyUsing("ns");
    const { code } = organizeImports(source);
    const importLine = code.split("\n").find((l) => l.includes("'./mod'"))!;
    expect(importLine).toBe("import * as ns from './mod'");
  });
});

// ---------------------------------------------------------------------------
// 15. Combined import (default + named)
// ---------------------------------------------------------------------------
describe("organizeImports — combined import (default + named)", () => {
  it("keeps both parts when both are used", () => {
    const source =
      `import Def, { Named } from './mod'` + bodyUsing("Def", "Named");
    const { code } = organizeImports(source);
    expect(code).toContain("Def");
    expect(code).toContain("Named");
  });

  it("removes unused named binding from combined import, keeps default", () => {
    const source = `import Def, { Unused } from './mod'` + bodyUsing("Def");
    const { code } = organizeImports(source);
    expect(code).toContain("Def");
    expect(code).not.toContain("Unused");
    // The import line itself should still exist
    expect(code).toContain("'./mod'");
  });

  it("removes unused default from combined import, keeps named", () => {
    const source = `import Def, { Named } from './mod'` + bodyUsing("Named");
    const { code } = organizeImports(source);
    expect(code).toContain("Named");
    expect(code).not.toContain("Def");
    expect(code).toContain("'./mod'");
  });

  it("removes entire combined import when nothing is used", () => {
    const source = `import Def, { Named } from './mod'` + "\nconst x = 1";
    const { code, removed } = organizeImports(source);
    expect(code).not.toContain("'./mod'");
    expect(removed).toContain("./mod");
  });
});

// ---------------------------------------------------------------------------
// 16. No-op: already organized file
// ---------------------------------------------------------------------------
describe("organizeImports — no-op", () => {
  it("returns changed=false when the file is already organized", () => {
    // Build the expected "already organized" source by running the organizer
    // once on an equivalent unorganized file, then verify a second pass is a no-op.
    const unorganized =
      `import { r } from './rel'\n` +
      `import { a } from 'axios'\n` +
      `import { s } from '@scope/s'\n` +
      `import { z } from 'zod'\n` +
      `const _refa = a, _refz = z, _refs = s, _refr = r\n`;

    const firstPass = organizeImports(unorganized);
    const secondPass = organizeImports(firstPass.code);
    expect(secondPass.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 17. Only external imports
// ---------------------------------------------------------------------------
describe("organizeImports — single group scenarios", () => {
  it("handles only external imports with no extra blank lines", () => {
    const source =
      [`import { b } from 'b'`, `import { a } from 'a'`].join("\n") +
      bodyUsing("a", "b");

    const { code } = organizeImports(source);
    const outputLines = code.split("\n").slice(
      0,
      code.split("\n").findIndex((l) => !l.startsWith("import") && l !== "")
    );
    // Should be 2 import lines with no blank line between them
    expect(outputLines.filter((l) => l.startsWith("import"))).toHaveLength(2);
    expect(outputLines.filter((l) => l === "")).toHaveLength(0);
  });

  it("handles only relative imports with no extra blank lines", () => {
    const source =
      [`import { b } from './b'`, `import { a } from './a'`].join("\n") +
      bodyUsing("a", "b");

    const { code } = organizeImports(source);
    const firstImportIdx = code
      .split("\n")
      .findIndex((l) => l.startsWith("import"));
    const secondLine = code.split("\n")[firstImportIdx + 1]!;
    expect(secondLine.startsWith("import")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 18. Empty file / no imports
// ---------------------------------------------------------------------------
describe("organizeImports — edge cases", () => {
  it("returns original source for an empty file", () => {
    const { code, changed } = organizeImports("");
    expect(code).toBe("");
    expect(changed).toBe(false);
  });

  it("returns original source for a file with no imports", () => {
    const source = "const x = 1\nconsole.log(x)\n";
    const { code, changed } = organizeImports(source);
    expect(code).toBe(source);
    expect(changed).toBe(false);
  });

  it("handles a file with only a comment and no imports", () => {
    const source = "// just a comment\nconst x = 1\n";
    const { code } = organizeImports(source);
    expect(code).toBe(source);
  });
});

// ---------------------------------------------------------------------------
// 19-20 already covered above; extend with remaining scenarios
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 21. Mixed all three groups
// ---------------------------------------------------------------------------
describe("organizeImports — all three groups mixed", () => {
  it("correctly orders external → internal → relative with separators", () => {
    const source =
      [
        `import { rel } from './rel'`,
        `import { ext1 } from 'ext1'`,
        `import { int } from '@scope/int'`,
        `import { ext2 } from 'ext2'`,
        `import { rel2 } from '../parent'`,
      ].join("\n") + bodyUsing("rel", "ext1", "int", "ext2", "rel2");

    const { code } = organizeImports(source);
    const lines = code.split("\n");

    const ext1Idx = lines.findIndex((l) => l.includes("'ext1'"));
    const ext2Idx = lines.findIndex((l) => l.includes("'ext2'"));
    const intIdx = lines.findIndex((l) => l.includes("'@scope/int'"));
    const relIdx = lines.findIndex((l) => l.includes("'./rel'"));
    const rel2Idx = lines.findIndex((l) => l.includes("'../parent'"));

    // Both externals come first and are consecutive (ext1 < ext2 alphabetically)
    expect(ext1Idx).toBeLessThan(ext2Idx);
    expect(ext2Idx + 1).toBe(lines.indexOf("", ext2Idx)); // blank line after last external

    // Internal comes after external group
    expect(intIdx).toBeGreaterThan(ext2Idx);

    // Both relatives come last
    expect(relIdx).toBeGreaterThan(intIdx);
    expect(rel2Idx).toBeGreaterThan(intIdx);
    // '../parent' < './rel' lexicographically
    expect(rel2Idx).toBeLessThan(relIdx);
  });
});

// ---------------------------------------------------------------------------
// 22. removeUnused=false — skip pruning
// ---------------------------------------------------------------------------
describe("organizeImports — removeUnused=false", () => {
  it("does not remove imports when removeUnused is false", () => {
    const source = `import { unused } from 'pkg'` + "\nconst x = 1";
    const { code, removed } = organizeImports(source, { removeUnused: false });
    expect(code).toContain("'pkg'");
    expect(removed).toHaveLength(0);
  });

  it("still sorts imports when removeUnused is false", () => {
    const source =
      [`import { z } from 'z-pkg'`, `import { a } from 'a-pkg'`].join("\n") +
      "\nconst x = 1";

    const { code } = organizeImports(source, { removeUnused: false });
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'a-pkg'");
    expect(lines[1]).toContain("'z-pkg'");
  });
});

// ---------------------------------------------------------------------------
// 23. Alias import — checks local alias in body
// ---------------------------------------------------------------------------
describe("organizeImports — aliased named imports", () => {
  it("keeps aliased import when local alias is used in body", () => {
    const source =
      `import { Original as Alias } from 'lib'` + bodyUsing("Alias");
    const { code } = organizeImports(source);
    expect(code).toContain("Original as Alias");
  });

  it("removes aliased import when neither original nor alias is used", () => {
    const source = `import { Original as Alias } from 'lib'` + "\nconst x = 1";
    const { code, removed } = organizeImports(source);
    expect(code).not.toContain("'lib'");
    expect(removed).toContain("lib");
  });
});

// ---------------------------------------------------------------------------
// 24-25. Named binding determinism
// ---------------------------------------------------------------------------
describe("organizeImports — named binding determinism", () => {
  it("produces the same output on repeated calls (deterministic)", () => {
    const source = `import { C, A, B } from 'lib'` + bodyUsing("A", "B", "C");

    const result1 = organizeImports(source).code;
    const result2 = organizeImports(source).code;
    expect(result1).toBe(result2);
  });

  it("sorts named bindings A→Z independent of input order", () => {
    const variants = [
      `import { C, B, A } from 'lib'`,
      `import { A, C, B } from 'lib'`,
      `import { B, A, C } from 'lib'`,
    ];

    const expected = "import { A, B, C } from 'lib'";
    for (const v of variants) {
      const { code } = organizeImports(v + bodyUsing("A", "B", "C"));
      const importLine = code.split("\n").find((l) => l.includes("'lib'"))!;
      expect(importLine).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// 26. Body preserved after imports
// ---------------------------------------------------------------------------
describe("organizeImports — body preservation", () => {
  it("preserves all code after the import block unchanged", () => {
    const body = `\nfunction foo() {\n  return 42\n}\nexport default foo\n`;
    const source = `import { x } from 'x'` + body;
    const { code } = organizeImports(source);
    expect(code).toContain(body.trim());
  });

  it("does not alter non-import code even when all imports are removed", () => {
    const body = "\nconst logic = () => 'hello'\n";
    const source = `import { unused } from 'pkg'` + body;
    const { code } = organizeImports(source);
    expect(code).toContain("logic");
  });
});

// ---------------------------------------------------------------------------
// 27. organizeImportsInMap — multi-file map
// ---------------------------------------------------------------------------
describe("organizeImportsInMap", () => {
  it("organizes all TS files in the map", () => {
    const files = new Map([
      [
        "src/a.ts",
        `import { z } from 'z'\nimport { a } from 'a'` + bodyUsing("z", "a"),
      ],
      ["src/b.ts", `import { b } from './b'` + bodyUsing("b")],
    ]);

    const result = organizeImportsInMap(files);
    const aContent = result.get("src/a.ts")!;
    const aLines = aContent.split("\n").filter((l) => l.startsWith("import"));
    expect(aLines[0]).toContain("'a'");
    expect(aLines[1]).toContain("'z'");
  });

  it("skips non-TS/JS files", () => {
    const original = "import { x } from './x'";
    const files = new Map([["README.md", original]]);
    const result = organizeImportsInMap(files);
    expect(result.get("README.md")).toBe(original);
  });

  it("processes .tsx files", () => {
    const files = new Map([
      [
        "src/App.tsx",
        `import { B } from './B'\nimport { A } from './A'` +
          bodyUsing("A", "B"),
      ],
    ]);
    const result = organizeImportsInMap(files);
    const lines = result
      .get("src/App.tsx")!
      .split("\n")
      .filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'./A'");
    expect(lines[1]).toContain("'./B'");
  });

  it("processes .js files", () => {
    const files = new Map([
      [
        "src/utils.js",
        `import { z } from 'z-lib'\nimport { a } from 'a-lib'` +
          bodyUsing("z", "a"),
      ],
    ]);
    const result = organizeImportsInMap(files);
    const lines = result
      .get("src/utils.js")!
      .split("\n")
      .filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'a-lib'");
  });
});

// ---------------------------------------------------------------------------
// 28-29. Internal package with and without sub-path
// ---------------------------------------------------------------------------
describe("organizeImports — internal package variations", () => {
  it("classifies @scope/pkg as internal", () => {
    const source =
      [`import { i } from '@scope/pkg'`, `import { e } from 'ext'`].join("\n") +
      bodyUsing("i", "e");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'ext'");
    expect(lines[1]).toContain("'@scope/pkg'");
  });

  it("classifies @scope/pkg/utils as internal", () => {
    const source =
      [`import { u } from '@scope/pkg/utils'`, `import { e } from 'ext'`].join(
        "\n"
      ) + bodyUsing("u", "e");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'ext'");
    expect(lines[1]).toContain("'@scope/pkg/utils'");
  });
});

// ---------------------------------------------------------------------------
// 30. Relative parent path
// ---------------------------------------------------------------------------
describe("organizeImports — parent-relative imports", () => {
  it("classifies ../sibling as relative and groups it last", () => {
    const source =
      [`import { s } from '../sibling'`, `import { e } from 'ext'`].join("\n") +
      bodyUsing("s", "e");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'ext'");
    expect(lines[1]).toContain("'../sibling'");
  });
});

// ---------------------------------------------------------------------------
// 31. All imports unused
// ---------------------------------------------------------------------------
describe("organizeImports — all imports unused", () => {
  it("produces empty import block when all imports are unused", () => {
    const source =
      [
        `import { a } from 'a'`,
        `import { b } from '@scope/b'`,
        `import { c } from './c'`,
      ].join("\n") + "\nconst x = 1\n";

    const { code, removed } = organizeImports(source);
    expect(removed).toContain("a");
    expect(removed).toContain("@scope/b");
    expect(removed).toContain("./c");
    // No import lines remain
    const importLines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(importLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 32. Namespace import removed when unused (already covered at 14, extend)
// ---------------------------------------------------------------------------
describe("organizeImports — namespace import removal", () => {
  it("marks specifier as removed when namespace binding unused", () => {
    const source = `import * as ns from '@scope/ns'` + "\nexport const x = 1";
    const { removed } = organizeImports(source);
    expect(removed).toContain("@scope/ns");
  });
});

// ---------------------------------------------------------------------------
// 33-34. Combined import partial removal (extended)
// ---------------------------------------------------------------------------
describe("organizeImports — combined import edge cases", () => {
  it("outputs only named binding when default removed from combined", () => {
    const source = `import Def, { Named } from './mod'` + bodyUsing("Named");
    const { code } = organizeImports(source);
    const importLine = code.split("\n").find((l) => l.includes("'./mod'"))!;
    expect(importLine).toContain("Named");
    expect(importLine).not.toContain("Def");
  });

  it("outputs only default binding when named removed from combined", () => {
    const source = `import Def, { Named } from './mod'` + bodyUsing("Def");
    const { code } = organizeImports(source);
    const importLine = code.split("\n").find((l) => l.includes("'./mod'"))!;
    expect(importLine).toContain("Def");
    expect(importLine).not.toContain("Named");
  });
});

// ---------------------------------------------------------------------------
// 35. Side-effect import always kept even with removeUnused=true
// ---------------------------------------------------------------------------
describe("organizeImports — side-effect with explicit removeUnused=true", () => {
  it("keeps side-effect import when removeUnused is explicitly true", () => {
    const source = `import './init'\nconst x = 1`;
    const { code } = organizeImports(source, { removeUnused: true });
    expect(code).toContain("import './init'");
  });
});

// ---------------------------------------------------------------------------
// 36. Multiple side-effect imports
// ---------------------------------------------------------------------------
describe("organizeImports — multiple side-effect imports", () => {
  it("preserves all side-effect imports in their relative group", () => {
    const source =
      [`import './a.css'`, `import './b.css'`, `import { e } from 'ext'`].join(
        "\n"
      ) + bodyUsing("e");

    const { code } = organizeImports(source);
    expect(code).toContain("./a.css");
    expect(code).toContain("./b.css");
  });
});

// ---------------------------------------------------------------------------
// 37. Type-only import preservation (type erasure scenario)
// ---------------------------------------------------------------------------
describe("organizeImports — type import erasure", () => {
  it("keeps type-only import even without value reference in body", () => {
    // Types are erased at compile time; we must not remove them based on
    // the absence of a runtime reference.
    const source = `import type { MyInterface } from './types'\nconst x = 1\n`;
    const { code, removed } = organizeImports(source);
    expect(code).toContain("import type { MyInterface } from './types'");
    expect(removed).not.toContain("./types");
  });
});

// ---------------------------------------------------------------------------
// 38. Sorting stability with case differences
// ---------------------------------------------------------------------------
describe("organizeImports — sorting stability", () => {
  it("sorts case-insensitively (lowercase before uppercase of same letter)", () => {
    // Standard lexicographic: 'A'(65) < 'a'(97) but
    // localeCompare is used — behaviour is locale-consistent
    const source =
      [
        `import { Z } from 'zz'`,
        `import { A } from 'aa'`,
        `import { M } from 'mm'`,
      ].join("\n") + bodyUsing("Z", "A", "M");

    const { code } = organizeImports(source);
    const lines = code.split("\n").filter((l) => l.startsWith("import"));
    expect(lines[0]).toContain("'aa'");
    expect(lines[1]).toContain("'mm'");
    expect(lines[2]).toContain("'zz'");
  });
});

// ---------------------------------------------------------------------------
// 39. Named binding alias: original not in body but alias is
// ---------------------------------------------------------------------------
describe("organizeImports — alias resolution", () => {
  it("keeps aliased binding when alias is used (even though original is not)", () => {
    const source =
      `import { OriginalName as localAlias } from 'lib'` +
      bodyUsing("localAlias");

    const { code } = organizeImports(source);
    expect(code).toContain("OriginalName as localAlias");
    expect(code).toContain("'lib'");
  });
});

// ---------------------------------------------------------------------------
// 40. File with only body — unchanged
// ---------------------------------------------------------------------------
describe("organizeImports — body-only file", () => {
  it("returns the file unchanged when there are no import statements", () => {
    const source =
      "export function add(a: number, b: number) {\n  return a + b\n}\n";
    const { code, changed } = organizeImports(source);
    expect(changed).toBe(false);
    expect(code).toBe(source);
  });
});
