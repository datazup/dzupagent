import { types as nodeTypes } from "node:util";

import {
  GOLDEN_TRACE_FIXTURE_DECODE_LIMITS,
  type GoldenTraceFixtureDecodeLimits,
} from "./golden-trace-fixture-limits.js";
import {
  failGoldenTraceFixture,
  GoldenTraceFixtureValidationError,
  type GoldenTraceFixtureValidationCode,
} from "./golden-trace-fixture-validation-error.js";

export type GoldenTraceFixtureExactRecord = ReadonlyMap<string, unknown>;

interface ArrayBounds {
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly lengthCode?: GoldenTraceFixtureValidationCode;
}

interface StringBounds {
  readonly nonEmpty?: boolean;
  readonly maxBytes?: number;
  readonly limitCode?: GoldenTraceFixtureValidationCode;
}

export class GoldenTraceFixtureDecodeContext {
  private readonly activeContainers = new WeakSet<object>();
  private visitedNodes = 0;

  constructor(
    readonly limits: Readonly<GoldenTraceFixtureDecodeLimits> =
      GOLDEN_TRACE_FIXTURE_DECODE_LIMITS,
  ) {}

  record<T>(
    value: unknown,
    location: string,
    depth: number,
    requiredKeys: readonly string[],
    decode: (record: GoldenTraceFixtureExactRecord) => T,
  ): T {
    this.visitNode(value, location, depth);
    const object = this.requireOrdinaryRecord(value, location);
    this.enterContainer(object, location);

    try {
      const fields = this.inspectRecord(object, location, requiredKeys);
      return Object.freeze(decode(fields));
    } finally {
      this.activeContainers.delete(object);
    }
  }

  array<T>(
    value: unknown,
    location: string,
    depth: number,
    decodeItem: (item: unknown, location: string, depth: number) => T,
    bounds: ArrayBounds = {},
  ): readonly T[] {
    this.visitNode(value, location, depth);
    const array = this.requireOrdinaryArray(value, location);
    this.enterContainer(array, location);

    try {
      const descriptors = this.safeDescriptors(array, location);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        this.invalid(location);
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
        this.invalid(location);
      }

      const length = lengthDescriptor.value;
      const minItems = bounds.minItems ?? 0;
      const maxItems = bounds.maxItems ?? this.limits.maxFiles;
      if (length < minItems || length > maxItems) {
        failGoldenTraceFixture(
          bounds.lengthCode ?? "MANIFEST_INVALID",
          location,
        );
      }
      if (keys.length !== length + 1) {
        this.invalid(location);
      }

      const clone: T[] = [];
      for (let index = 0; index < length; index += 1) {
        const itemLocation = `${location}[${index}]`;
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined) {
          this.invalid(itemLocation);
        }
        clone.push(
          decodeItem(
            this.dataField(descriptor, itemLocation),
            itemLocation,
            depth + 1,
          ),
        );
      }
      return Object.freeze(clone);
    } finally {
      this.activeContainers.delete(array);
    }
  }

  string(
    value: unknown,
    location: string,
    depth: number,
    bounds: StringBounds = {},
  ): string {
    this.visitNode(value, location, depth);
    if (typeof value !== "string") {
      this.invalid(location);
    }
    if (bounds.nonEmpty === true && value.length === 0) {
      this.invalid(location);
    }
    const maxBytes =
      bounds.maxBytes ?? this.limits.maxMetadataStringBytes;
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      failGoldenTraceFixture(
        bounds.limitCode ?? "MANIFEST_STRING_LIMIT",
        location,
      );
    }
    return value;
  }

  boolean(value: unknown, location: string, depth: number): boolean {
    this.visitNode(value, location, depth);
    if (typeof value !== "boolean") {
      this.invalid(location);
    }
    return value;
  }

  bytes(value: unknown, location: string, depth: number): ArrayBuffer {
    this.visitNode(value, location, depth);
    if (
      value === null ||
      typeof value !== "object" ||
      nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== ArrayBuffer.prototype
    ) {
      this.invalid(location);
    }

    try {
      const buffer = value as ArrayBuffer;
      if (Reflect.ownKeys(Object.getOwnPropertyDescriptors(buffer)).length !== 0) {
        this.invalid(location);
      }
      const byteLength = arrayBufferByteLengthGetter.call(buffer);
      if (byteLength > this.limits.maxPayloadBytes) {
        failGoldenTraceFixture("PAYLOAD_BYTES_LIMIT", location);
      }
      const clone = new ArrayBuffer(byteLength);
      new Uint8Array(clone).set(new Uint8Array(buffer));
      return clone;
    } catch (error) {
      if (error instanceof GoldenTraceFixtureValidationError) {
        throw error;
      }
      failGoldenTraceFixture("UNSAFE_INPUT", location);
    }
  }

  nonNegativeInteger(
    value: unknown,
    location: string,
    depth: number,
  ): number {
    this.visitNode(value, location, depth);
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      this.invalid(location);
    }
    return value;
  }

  literal<T extends string>(
    value: unknown,
    location: string,
    depth: number,
    expected: T,
  ): T {
    const decoded = this.string(value, location, depth);
    if (decoded !== expected) {
      this.invalid(location);
    }
    return expected;
  }

  oneOf<T extends string>(
    value: unknown,
    location: string,
    depth: number,
    allowed: readonly T[],
  ): T {
    const decoded = this.string(value, location, depth);
    if (!allowed.includes(decoded as T)) {
      this.invalid(location);
    }
    return decoded as T;
  }

  digest(value: unknown, location: string, depth: number): `sha256:${string}` {
    const decoded = this.string(value, location, depth);
    if (!/^sha256:[a-f0-9]{64}$/u.test(decoded)) {
      this.invalid(location);
    }
    return decoded as `sha256:${string}`;
  }

  required(
    record: GoldenTraceFixtureExactRecord,
    key: string,
    location: string,
  ): unknown {
    if (!record.has(key)) {
      this.invalid(`${location}.${key}`);
    }
    return record.get(key);
  }

  assertEncodedManifestSize(value: object): void {
    if (encodedJsonBytes(value) > this.limits.maxManifestBytes) {
      failGoldenTraceFixture("MANIFEST_BYTES_LIMIT", "$manifest");
    }
  }

  private inspectRecord(
    object: object,
    location: string,
    requiredKeys: readonly string[],
  ): Map<string, unknown> {
    const descriptors = this.safeDescriptors(object, location);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length > this.limits.maxTotalNodes) {
      failGoldenTraceFixture("MANIFEST_NODE_LIMIT", location);
    }

    const allowed = new Set(requiredKeys);
    const fields = new Map<string, unknown>();
    for (const key of ownKeys) {
      if (typeof key !== "string" || !allowed.has(key)) {
        this.invalid(location);
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined) {
        this.invalid(location);
      }
      fields.set(key, this.dataField(descriptor, `${location}.${key}`));
    }
    for (const key of requiredKeys) {
      if (!fields.has(key)) {
        this.invalid(`${location}.${key}`);
      }
    }
    return fields;
  }

  private visitNode(value: unknown, location: string, depth: number): void {
    this.visitedNodes += 1;
    if (this.visitedNodes > this.limits.maxTotalNodes) {
      failGoldenTraceFixture("MANIFEST_NODE_LIMIT", location);
    }
    if (
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      depth > this.limits.maxDepth
    ) {
      failGoldenTraceFixture("MANIFEST_DEPTH_LIMIT", location);
    }
  }

  private requireOrdinaryRecord(value: unknown, location: string): object {
    if (
      value === null ||
      typeof value !== "object" ||
      nodeTypes.isProxy(value) ||
      Array.isArray(value)
    ) {
      this.invalid(location);
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      this.invalid(location);
    }
    return value;
  }

  private requireOrdinaryArray(value: unknown, location: string): unknown[] {
    if (
      value === null ||
      typeof value !== "object" ||
      nodeTypes.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      this.invalid(location);
    }
    return value;
  }

  private safeDescriptors(
    object: object,
    location: string,
  ): Record<PropertyKey, PropertyDescriptor> {
    try {
      return Object.getOwnPropertyDescriptors(object);
    } catch {
      failGoldenTraceFixture("UNSAFE_INPUT", location);
    }
  }

  private dataField(
    descriptor: PropertyDescriptor,
    location: string,
  ): unknown {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      this.invalid(location);
    }
    return descriptor.value;
  }

  private enterContainer(object: object, location: string): void {
    if (this.activeContainers.has(object)) {
      this.invalid(location);
    }
    this.activeContainers.add(object);
  }

  private invalid(location: string): never {
    failGoldenTraceFixture("MANIFEST_INVALID", location);
  }
}

const stringifyJsonPrimitive = JSON.stringify;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get as (this: ArrayBuffer) => number;

function encodedJsonBytes(value: unknown): number {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    const encoded = stringifyJsonPrimitive(value);
    if (encoded === undefined) {
      failGoldenTraceFixture("UNSAFE_INPUT", "$manifest");
    }
    return Buffer.byteLength(encoded, "utf8");
  }

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      string,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors["length"];
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      failGoldenTraceFixture("UNSAFE_INPUT", "$manifest");
    }
    const length = lengthDescriptor.value as number;
    let bytes = 2 + Math.max(0, length - 1);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) {
        failGoldenTraceFixture("UNSAFE_INPUT", "$manifest");
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
        failGoldenTraceFixture("UNSAFE_INPUT", "$manifest");
      }
      bytes += encodedJsonBytes(key) + 1;
      bytes += encodedJsonBytes(descriptor.value);
    }
    return bytes;
  }

  failGoldenTraceFixture("UNSAFE_INPUT", "$manifest");
}
