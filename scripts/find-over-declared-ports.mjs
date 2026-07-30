#!/usr/bin/env node
/**
 * Over-declared port scanner.
 *
 * Finds interfaces that declare far more members than their consumers actually
 * use. These are the cheapest possible type-error clusters to fix: narrowing the
 * port to what is really read deletes whole families of "missing property"
 * errors in tests and fakes, without touching production behaviour.
 *
 * Provenance: two of these were found by hand on 2026-07-29 and were the two
 * biggest single wins of that session --
 *   • AgentMemoryService aliased all 17 members of MemoryService; the loader
 *     calls 2   (-36 errors from one line)
 *   • agentAsTool demanded a full GenerateResult but reads only .content
 *     (-15 errors)
 * Both were found with the same manual diagnostic: compare the declared members
 * against the `obj.field` uses at the call sites. This automates that.
 *
 * VALIDATED: run against packages/agent, this ranks AgentMemoryService (2/18)
 * as the single widest gap in the package -- i.e. it independently rediscovers
 * the biggest hand-found win.
 *
 * RETURN-POSITION PORTS are measured too, which is how the second hand-found
 * case is now caught: `agentAsTool`'s `generate: (…) => Promise<GenerateResult>`
 * is reported at 3/11 members used. Only `Promise<T>`, `T[]`, `Array<T>` and
 * `Awaited<T>` are unwrapped, and only in RETURN position — reads are then
 * attributed to the awaited CALL RESULT, never to a container binding. That
 * distinction is what keeps `Map<string, T>` from reporting "uses get, set".
 *
 * REMAINING BLIND SPOTS:
 *   • a type reached only through a container in PARAMETER position
 *     (`items: Map<string, T>`) is still skipped by design — see above.
 *   • members read via computed access (`obj[k]`) are invisible, so a port
 *     driven entirely by dynamic keys can look narrower than it is.
 *   • a member used ONLY as a type (`typeof x.foo`) counts as unused.
 *
 * VALIDATION: both hand-found cases are regression-checked by widening the
 * (now narrowed) port and confirming the tool re-finds it —
 * `AgentMemoryService` 2/18 and `GenerateResult` 3/11.
 *
 * Usage:
 *   node find-over-declared-ports.mjs <tsconfig> [--min-declared N] [--max-used N]
 *        [--json] [--include <substr>]
 *
 * Exit code is always 0: this is a report, not a gate. An over-declared port is
 * a *candidate*, not automatically a defect -- a port may be deliberately wide
 * because it is a public contract. Read each hit before acting.
 */
import { Project, SyntaxKind } from "ts-morph";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  console.error(
    "usage: find-over-declared-ports.mjs <tsconfig> [--min-declared N] [--max-used N] [--json] [--include <substr>]"
  );
  process.exit(argv.length ? 0 : 1);
}

const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};

const tsconfig = path.resolve(argv[0]);
const MIN_DECLARED = Number(flag("--min-declared", 4));
const MAX_USED = Number(flag("--max-used", Infinity));
const INCLUDE = flag("--include", null);
const AS_JSON = argv.includes("--json");

const project = new Project({ tsConfigFilePath: tsconfig });

const sourceFiles = project
  .getSourceFiles()
  .filter((f) => !f.isDeclarationFile() && !f.getFilePath().includes("node_modules"));

/** Collect declared member names for an interface, including inherited ones. */
function declaredMembers(iface, seen = new Set()) {
  const key = iface.getName() + "@" + iface.getSourceFile().getFilePath();
  if (seen.has(key)) return new Set();
  seen.add(key);

  const names = new Set();
  for (const m of iface.getMembers()) {
    const n = m.getSymbol()?.getName();
    if (n && n !== "__call" && n !== "__index") names.add(n);
  }
  // Walk `extends` so a thin interface over a fat base is still scored fat.
  for (const ext of iface.getExtends?.() ?? []) {
    const sym = ext.getExpression().getSymbol();
    for (const decl of sym?.getDeclarations() ?? []) {
      if (decl.getKind() === SyntaxKind.InterfaceDeclaration) {
        for (const n of declaredMembers(decl, seen)) names.add(n);
      }
    }
  }
  return names;
}

/**
 * Is `typeRef` the return type of `fnNode`, possibly wrapped in Promise<>/[]?
 *
 * Deliberately narrow: only Promise<T>, T[] and Array<T> are unwrapped. A
 * `Map<string, T>` or `Record<k, T>` return is NOT a port in this sense --
 * consumers index the container first, so reads belong to the container.
 */
function isUnwrappedReturnType(fnNode, typeRef) {
  const ret = fnNode.getReturnTypeNode?.();
  if (!ret) return false;
  if (ret === typeRef) return true;

  let node = ret;
  for (let depth = 0; depth < 3; depth++) {
    if (node === typeRef) return true;
    if (node.getKind() === SyntaxKind.ArrayType) {
      node = node.getElementTypeNode();
      continue;
    }
    if (node.getKind() === SyntaxKind.TypeReference) {
      const n = node.getTypeName?.().getText?.();
      if (n === "Promise" || n === "Array" || n === "Awaited") {
        const args = node.getTypeArguments?.() ?? [];
        if (args.length !== 1) return false;
        node = args[0];
        continue;
      }
      return node === typeRef;
    }
    return false;
  }
  return false;
}

/**
 * Given a type reference that sits in a function's return position, return the
 * set of member names consumers actually read off the call result.
 *
 * Handles `const r = await ctx.generate(...)` / `r.content`,
 * `(await gen()).content`, `gen().then(r => r.content)` and destructuring.
 */
function returnPositionUses(typeRef, portName) {
  const out = new Set();

  // Find the function-ish node whose RETURN type this is, then the named
  // declaration that owns it. These are two different nodes for the common
  // `generate: (…) => Promise<T>` shape: the FunctionType carries the return
  // type, but only the enclosing PropertySignature carries the NAME whose
  // call sites we can look up. Resolving just the innermost match lands on
  // the FunctionType (which has no name) and silently finds nothing.
  const fn = typeRef.getFirstAncestor(
    (a) =>
      a.getKind() === SyntaxKind.FunctionType ||
      a.getKind() === SyntaxKind.MethodSignature ||
      a.getKind() === SyntaxKind.MethodDeclaration ||
      a.getKind() === SyntaxKind.FunctionDeclaration
  );
  if (!fn) return out;
  if (!isUnwrappedReturnType(fn, typeRef)) return out;

  // A FunctionType is anonymous — climb to the PropertySignature /
  // PropertyDeclaration / VariableDeclaration that names it.
  let owner = fn;
  if (fn.getKind() === SyntaxKind.FunctionType) {
    owner =
      fn.getFirstAncestor(
        (a) =>
          a.getKind() === SyntaxKind.PropertySignature ||
          a.getKind() === SyntaxKind.PropertyDeclaration ||
          a.getKind() === SyntaxKind.VariableDeclaration
      ) ?? null;
    if (!owner) return out;
  }

  const nameNode = owner.getNameNode?.();
  if (!nameNode) return out;

  let refs = [];
  try {
    refs = nameNode.findReferencesAsNodes();
  } catch {
    return out;
  }

  for (const ref of refs) {
    // Find the call expression this reference is the callee of.
    const call =
      ref.getParentIfKind(SyntaxKind.CallExpression) ??
      ref
        .getParentIfKind(SyntaxKind.PropertyAccessExpression)
        ?.getParentIfKind(SyntaxKind.CallExpression);
    if (!call) continue;

    // Unwrap `await call()` / `(await call())` so the result binding is found.
    let result = call;
    const awaited = call.getParentIfKind(SyntaxKind.AwaitExpression);
    if (awaited) result = awaited;
    const paren = result.getParentIfKind(SyntaxKind.ParenthesizedExpression);
    if (paren) result = paren;

    // (await call()).content
    const direct = result.getParentIfKind(SyntaxKind.PropertyAccessExpression);
    if (direct && direct.getExpression() === result) {
      out.add(direct.getName());
      continue;
    }

    // const r = await call();  /  const { content } = await call();
    const varDecl = result.getParentIfKind(SyntaxKind.VariableDeclaration);
    if (varDecl) {
      const bind = varDecl.getNameNode();
      if (bind.getKind() === SyntaxKind.ObjectBindingPattern) {
        for (const el of bind.getElements()) {
          const n = (el.getPropertyNameNode() ?? el.getNameNode()).getText?.();
          if (n) out.add(n);
        }
        continue;
      }
      if (bind.getKind() === SyntaxKind.Identifier) {
        let brs = [];
        try {
          brs = bind.findReferencesAsNodes();
        } catch {
          continue;
        }
        for (const br of brs) {
          const acc = br.getParentIfKind(SyntaxKind.PropertyAccessExpression);
          if (acc && acc.getExpression() === br) out.add(acc.getName());
        }
      }
      continue;
    }

    // call().then(r => r.content)
    const thenAccess = result.getParentIfKind(SyntaxKind.PropertyAccessExpression);
    if (thenAccess?.getName() === "then") {
      const thenCall = thenAccess.getParentIfKind(SyntaxKind.CallExpression);
      const cb = thenCall?.getArguments?.()[0];
      const param = cb?.getParameters?.()[0]?.getNameNode?.();
      if (param?.getKind() === SyntaxKind.ObjectBindingPattern) {
        for (const el of param.getElements()) {
          const n = (el.getPropertyNameNode() ?? el.getNameNode()).getText?.();
          if (n) out.add(n);
        }
      } else if (param?.getKind() === SyntaxKind.Identifier) {
        let brs = [];
        try {
          brs = param.findReferencesAsNodes();
        } catch {
          continue;
        }
        for (const br of brs) {
          const acc = br.getParentIfKind(SyntaxKind.PropertyAccessExpression);
          if (acc && acc.getExpression() === br) out.add(acc.getName());
        }
      }
    }
  }

  return out;
}

const results = [];

for (const file of sourceFiles) {
  // Type ALIASES matter as much as interfaces here: the widest real port found
  // by hand (AgentMemoryService, 17 declared / 2 used) is
  //   `type AgentMemoryService = NonNullable<DzupAgentConfig['memory']>`
  // Scanning only `getInterfaces()` silently misses every alias, which is
  // exactly the shape used to re-export a fat upstream type under a local name.
  // Resolve aliases through the type checker rather than syntactically so
  // NonNullable<...>, Pick<...>, indexed access etc. all yield real members.
  const ports = [...file.getInterfaces(), ...file.getTypeAliases()];

  for (const iface of ports) {
    const name = iface.getName();
    if (INCLUDE && !name.includes(INCLUDE)) continue;

    const isAlias = iface.getKind() === SyntaxKind.TypeAliasDeclaration;
    let declared;
    if (isAlias) {
      const t = iface.getType();
      // Unions/primitives/functions are not ports -- only object-ish types.
      if (t.isUnion() || t.isIntersection() ? false : !t.isObject()) continue;
      declared = new Set(
        t
          .getProperties()
          .map((p) => p.getName())
          .filter((n) => n && !n.startsWith("__"))
      );
    } else {
      declared = declaredMembers(iface);
    }
    if (declared.size < MIN_DECLARED) continue;

    const used = new Set();
    const consumers = new Set();
    let refCount = 0;

    let refs = [];
    try {
      refs = iface.getNameNode().findReferencesAsNodes();
    } catch {
      continue; // unresolvable reference graph -- skip rather than crash the run
    }

    for (const ref of refs) {
      const refFile = ref.getSourceFile();
      if (refFile.getFilePath() === file.getFilePath() && ref === iface.getNameNode())
        continue;
      refCount++;

      // The type reference sits on a parameter / variable / property. Find the
      // declaration it annotates, then collect `x.foo` reads of that binding.
      const typeRef = ref.getFirstAncestorByKind(SyntaxKind.TypeReference);
      // An `import { T }` reference has no enclosing TypeReference. Without
      // this guard the `decl.getTypeNode() !== typeRef` check below compares
      // undefined to undefined, matches, and treats the import statement as a
      // consumer annotation.
      if (!typeRef) continue;
      const decl =
        typeRef?.getFirstAncestor(
          (a) =>
            a.getKind() === SyntaxKind.Parameter ||
            a.getKind() === SyntaxKind.VariableDeclaration ||
            a.getKind() === SyntaxKind.PropertySignature ||
            a.getKind() === SyntaxKind.PropertyDeclaration
        ) ?? null;
      if (!decl) continue;

      // Only count a binding whose type IS this interface. If the reference is
      // nested inside a container or union -- Map<string, T>, T[], A | T,
      // Promise<T> -- then `binding.foo` reads belong to the *container*, not to
      // T. Measuring those attributes Map.get/Array.push to the interface and
      // produces nonsense hits (this cost a false positive on RunSummaryMetrics,
      // reported as using "length, push").
      if (decl.getTypeNode?.() !== typeRef) {
        // RETURN-POSITION PORT (was the documented blind spot).
        //
        // `generate: (…) => Promise<GenerateResult>` is not a direct annotation,
        // so the check above drops it -- yet this is the shape a port usually
        // takes, and it hid the second hand-found win (agentAsTool reads only
        // `.content` of its Promise<GenerateResult>).
        //
        // Only unwrap the *return type* of a function-ish declaration, and only
        // through Promise<T>/T[]. That is safe in a way the general container
        // case is not: we then attribute reads on the CALL RESULT, never on a
        // container binding, so `Map<string,T>` can't leak `.get`/`.set` in.
        for (const u of returnPositionUses(typeRef, name)) used.add(u);
        continue;
      }

      const nameNode = decl.getNameNode?.();
      if (!nameNode) continue;

      // Destructured binding: `const { content } = result` / `({ content }) => …`
      // Those names ARE the used members; there is no binding to chase.
      if (nameNode.getKind() === SyntaxKind.ObjectBindingPattern) {
        for (const el of nameNode.getElements()) {
          const prop = el.getPropertyNameNode() ?? el.getNameNode();
          const n = prop.getText?.();
          if (n) used.add(n);
        }
        consumers.add(
          path.relative(process.cwd(), refFile.getFilePath()) +
            ":" +
            decl.getStartLineNumber()
        );
        continue;
      }

      if (nameNode.getKind() !== SyntaxKind.Identifier) continue;

      consumers.add(
        path.relative(process.cwd(), refFile.getFilePath()) +
          ":" +
          decl.getStartLineNumber()
      );

      let bindingRefs = [];
      try {
        bindingRefs = nameNode.findReferencesAsNodes();
      } catch {
        continue;
      }
      for (const br of bindingRefs) {
        const access = br.getParentIfKind(SyntaxKind.PropertyAccessExpression);
        if (access && access.getExpression() === br) used.add(access.getName());
      }
    }

    if (refCount === 0) continue; // zero consumers is a different smell entirely
    if (used.size === 0) continue; // passed through, never destructured -- not measurable

    // Count only reads that correspond to a DECLARED member. A discriminated
    // union's consumers legitimately read members that live on sibling variants
    // rather than on this type, which otherwise yields used > declared and a
    // meaningless ratio.
    const usedDeclared = new Set([...used].filter((u) => declared.has(u)));
    if (usedDeclared.size === 0) continue;
    if (usedDeclared.size > MAX_USED) continue;

    const unused = [...declared].filter((d) => !usedDeclared.has(d));
    if (!unused.length) continue;

    results.push({
      interface: name,
      file: path.relative(process.cwd(), file.getFilePath()),
      line: iface.getStartLineNumber(),
      declared: declared.size,
      used: usedDeclared.size,
      ratio: +(usedDeclared.size / declared.size).toFixed(2),
      usedMembers: [...usedDeclared].sort(),
      unusedMembers: unused.sort(),
      consumers: [...consumers].slice(0, 5),
    });
  }
}

// Widest gap first -- that is where the biggest error cluster hides.
results.sort((a, b) => b.declared - b.used - (a.declared - a.used));

if (AS_JSON) {
  console.log(JSON.stringify({ tsconfig, count: results.length, results }, null, 2));
} else if (!results.length) {
  console.log("No over-declared ports found.");
} else {
  console.log(`Over-declared port candidates (${results.length}), widest gap first:\n`);
  for (const r of results.slice(0, 30)) {
    console.log(
      `  ${r.interface}  ${r.used}/${r.declared} members used  (${r.file}:${r.line})`
    );
    console.log(`     used:   ${r.usedMembers.join(", ") || "(none)"}`);
    const un = r.unusedMembers;
    console.log(
      `     unused: ${un.slice(0, 12).join(", ")}${un.length > 12 ? ` … +${un.length - 12} more` : ""}`
    );
    if (r.consumers.length) console.log(`     seen at: ${r.consumers[0]}`);
    console.log();
  }
  console.log(
    "A wide port is a candidate, not a verdict: public contracts are wide on purpose.\n" +
      "Narrowing one to what consumers actually read is what collapses test-fake error clusters."
  );
}
