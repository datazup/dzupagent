import { types as nodeTypes } from "node:util";

import {
  GOLDEN_TRACE_DECODE_LIMITS,
  type GoldenTraceDecodeLimits,
} from "./golden-trace-limits.js";
import { GoldenTraceValidationError } from "./golden-trace-validation-error.js";

export type ExactRecord = ReadonlyMap<string, unknown>;

type NumberConstraint =
  | "finite"
  | "integer"
  | "non-negative"
  | "non-negative-integer";

const MAX_DIAGNOSTIC_PATH_LENGTH = 160;

export class GoldenTraceDecodeContext {
  private readonly activeContainers = new WeakSet<object>();
  private visitedNodes = 0;

  constructor(
    readonly limits: Readonly<GoldenTraceDecodeLimits> =
      GOLDEN_TRACE_DECODE_LIMITS,
  ) {}

  record<T>(
    value: unknown,
    path: string,
    depth: number,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[],
    decode: (record: ExactRecord) => T,
  ): T {
    this.visitNode(value, path, depth);
    const object = this.requireOrdinaryRecord(value, path);
    this.enterContainer(object, path);

    try {
      const fields = this.inspectRecord(
        object,
        path,
        requiredKeys,
        optionalKeys,
      );
      return Object.freeze(decode(fields));
    } finally {
      this.activeContainers.delete(object);
    }
  }

  stringRecord(
    value: unknown,
    path: string,
    depth: number,
  ): Record<string, string> {
    this.visitNode(value, path, depth);
    const object = this.requireOrdinaryRecord(value, path);
    this.enterContainer(object, path);

    try {
      const descriptors = this.safeDescriptors(object, path);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > this.limits.maxCollectionItems) {
        fail("MAX_COLLECTION_ITEMS", path);
      }

      const clone: Record<string, string> = {};
      for (const key of keys) {
        if (typeof key !== "string") {
          fail("SYMBOL_KEY", path);
        }
        if (Buffer.byteLength(key, "utf8") > this.limits.maxStringBytes) {
          fail("MAX_STRING_BYTES", `${path}[*]`);
        }

        const descriptor = descriptors[key];
        if (descriptor === undefined) {
          fail("UNSAFE_INPUT", path);
        }
        const field = this.dataField(descriptor, path);
        const decoded = this.string(field, `${path}[*]`, depth + 1);
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: true,
          value: decoded,
          writable: true,
        });
      }
      return Object.freeze(clone);
    } finally {
      this.activeContainers.delete(object);
    }
  }

  array<T>(
    value: unknown,
    path: string,
    depth: number,
    decodeItem: (item: unknown, path: string, depth: number) => T,
  ): T[] {
    this.visitNode(value, path, depth);
    const array = this.requireOrdinaryArray(value, path);
    this.enterContainer(array, path);

    try {
      const descriptors = this.safeDescriptors(array, path);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        fail("SYMBOL_KEY", path);
      }

      const lengthDescriptor = descriptors["length"];
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable === true ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        fail("ARRAY_SHAPE", path);
      }
      const length = lengthDescriptor.value;
      if (length > this.limits.maxCollectionItems) {
        fail("MAX_COLLECTION_ITEMS", path);
      }
      if (keys.length !== length + 1) {
        fail("ARRAY_SHAPE", path);
      }

      const clone: T[] = [];
      for (let index = 0; index < length; index += 1) {
        const itemPath = `${path}[${index}]`;
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) {
          fail("ARRAY_SHAPE", itemPath);
        }
        const item = this.dataField(descriptor, itemPath);
        clone.push(decodeItem(item, itemPath, depth + 1));
      }

      return Object.freeze(clone) as T[];
    } finally {
      this.activeContainers.delete(array);
    }
  }

  string(
    value: unknown,
    path: string,
    depth: number,
    options: { readonly nonEmpty?: boolean } = {},
  ): string {
    this.visitNode(value, path, depth);
    if (typeof value !== "string") {
      fail("TYPE_STRING", path);
    }
    if (options.nonEmpty === true && value.length === 0) {
      fail("STRING_EMPTY", path);
    }
    if (Buffer.byteLength(value, "utf8") > this.limits.maxStringBytes) {
      fail("MAX_STRING_BYTES", path);
    }
    return value;
  }

  boolean(value: unknown, path: string, depth: number): boolean {
    this.visitNode(value, path, depth);
    if (typeof value !== "boolean") {
      fail("TYPE_BOOLEAN", path);
    }
    return value;
  }

  number(
    value: unknown,
    path: string,
    depth: number,
    constraint: NumberConstraint,
  ): number {
    this.visitNode(value, path, depth);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("TYPE_FINITE_NUMBER", path);
    }
    if (
      (constraint === "integer" ||
        constraint === "non-negative-integer") &&
      !Number.isSafeInteger(value)
    ) {
      fail("NUMBER_INTEGER", path);
    }
    if (
      (constraint === "non-negative" ||
        constraint === "non-negative-integer") &&
      value < 0
    ) {
      fail("NUMBER_RANGE", path);
    }
    return value;
  }

  literal<T extends string>(
    value: unknown,
    path: string,
    depth: number,
    allowed: readonly T[],
  ): T {
    const decoded = this.string(value, path, depth);
    if (!allowed.includes(decoded as T)) {
      fail("LITERAL", path);
    }
    return decoded as T;
  }

  runSpecHash(value: unknown, path: string, depth: number): `sha256:${string}` {
    const decoded = this.string(value, path, depth);
    if (!/^sha256:[a-f0-9]{64}$/u.test(decoded)) {
      fail("HASH_FORMAT", path);
    }
    return decoded as `sha256:${string}`;
  }

  required(record: ExactRecord, key: string, path: string): unknown {
    if (!record.has(key)) {
      fail("MISSING_KEY", `${path}.${key}`);
    }
    return record.get(key);
  }

  assertAbsent(record: ExactRecord, key: string, path: string): void {
    if (record.has(key)) {
      fail("UNION_FIELD", `${path}.${key}`);
    }
  }

  assertEncodedSize(value: object): void {
    if (encodedJsonBytes(value) > this.limits.maxEncodedBytes) {
      fail("MAX_ENCODED_BYTES", "$");
    }
  }

  private visitNode(value: unknown, path: string, depth: number): void {
    this.visitedNodes += 1;
    if (this.visitedNodes > this.limits.maxTotalNodes) {
      fail("MAX_TOTAL_NODES", path);
    }
    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      depth > this.limits.maxDepth
    ) {
      fail("MAX_DEPTH", path);
    }
  }

  private requireOrdinaryRecord(value: unknown, path: string): object {
    if (
      value === null ||
      typeof value !== "object" ||
      nodeTypes.isProxy(value) ||
      Array.isArray(value)
    ) {
      fail("TYPE_RECORD", path);
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      fail("OBJECT_PROTOTYPE", path);
    }
    return value;
  }

  private requireOrdinaryArray(value: unknown, path: string): unknown[] {
    if (
      value === null ||
      typeof value !== "object" ||
      nodeTypes.isProxy(value) ||
      !Array.isArray(value)
    ) {
      fail("TYPE_ARRAY", path);
    }
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("ARRAY_PROTOTYPE", path);
    }
    return value;
  }

  private inspectRecord(
    object: object,
    path: string,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[],
  ): Map<string, unknown> {
    const descriptors = this.safeDescriptors(object, path);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length > this.limits.maxCollectionItems) {
      fail("MAX_COLLECTION_ITEMS", path);
    }

    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const fields = new Map<string, unknown>();
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        fail("SYMBOL_KEY", path);
      }
      if (!allowed.has(key)) {
        fail("UNKNOWN_KEY", path);
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        fail("UNSAFE_INPUT", path);
      }
      fields.set(key, this.dataField(descriptor, `${path}.${key}`));
    }

    for (const key of requiredKeys) {
      if (!fields.has(key)) {
        fail("MISSING_KEY", `${path}.${key}`);
      }
    }
    return fields;
  }

  private safeDescriptors(
    object: object,
    path: string,
  ): Record<PropertyKey, PropertyDescriptor> {
    try {
      return Object.getOwnPropertyDescriptors(object);
    } catch {
      fail("UNSAFE_INPUT", path);
    }
  }

  private dataField(
    descriptor: PropertyDescriptor,
    path: string,
  ): unknown {
    if (!("value" in descriptor)) {
      fail("ACCESSOR", path);
    }
    if (descriptor.enumerable !== true) {
      fail("NON_ENUMERABLE", path);
    }
    return descriptor.value;
  }

  private enterContainer(object: object, path: string): void {
    if (this.activeContainers.has(object)) {
      fail("CYCLE", path);
    }
    this.activeContainers.add(object);
  }
}

export function fail(code: string, path: string): never {
  const boundedPath =
    path.length <= MAX_DIAGNOSTIC_PATH_LENGTH
      ? path
      : `${path.slice(0, MAX_DIAGNOSTIC_PATH_LENGTH - 3)}...`;
  throw new GoldenTraceValidationError(
    `GoldenTrace validation failed [${code}] at ${boundedPath}.`,
  );
}

const stringifyJsonPrimitive = JSON.stringify;

function encodedJsonBytes(value: unknown): number {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    const encoded = stringifyJsonPrimitive(value);
    if (encoded === undefined) {
      fail("UNSAFE_INPUT", "$");
    }
    return Buffer.byteLength(encoded, "utf8");
  }

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors["length"];
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      fail("UNSAFE_INPUT", "$");
    }
    const length = lengthDescriptor.value as number;
    let bytes = 2 + Math.max(0, length - 1);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) {
        fail("UNSAFE_INPUT", "$");
      }
      bytes += encodedJsonBytes(descriptor.value);
    }
    return bytes;
  }

  if (typeof value === "object" && value !== null) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    let bytes = 2 + Math.max(0, keys.length - 1);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        fail("UNSAFE_INPUT", "$");
      }
      bytes += encodedJsonBytes(key) + 1;
      bytes += encodedJsonBytes(descriptor.value);
    }
    return bytes;
  }

  fail("UNSAFE_INPUT", "$");
}
