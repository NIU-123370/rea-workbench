import net from "node:net";

import type { EgressAddressClass, EgressDestination, EgressPolicy } from "../../contracts/sandbox.ts";
import { isBlockedClass } from "../../contracts/sandbox.ts";
import type { EgressDecision, EgressPolicyPort, EgressReview } from "../../application/ports.ts";

// Default-deny egress with real address math (DESIGN §12: 阻断宿主控制面、loopback、
// 私网、link-local 和元数据地址; D18: 逐跳网络策略).
//
// A string prefix is not a network policy. `127.1`, `::ffff:127.0.0.1`,
// `::127.0.0.1`, `2002:7f00:1::` and `010.0.0.1` have each fooled a text matcher
// somewhere. This file therefore parses every address into bytes with `node:net` as
// the authority, resolves the encapsulated forms down to the address that would
// actually be routed, classifies *that*, and only then consults the explicit grants.
//
// The order is part of the rule and has no exception: classification runs before any
// grant lookup, so no prefix — however specific, however purpose-named — can rescue
// an address whose class is blocked. The single allowed exception is DESIGN §12's
// local test fixture: one named host, its own network namespace, its own grant.

const IPV4_LENGTH = 4;
const IPV6_LENGTH = 16;
const MAX_IPV4_PREFIX = 32;
const MAX_IPV6_PREFIX = 128;

export type AddressRange = {
  prefix: readonly number[];
  prefixLength: number;
  addressClass: EgressAddressClass;
};

export type ParsedAddress = {
  // The bytes that would actually be routed. For an IPv4-mapped, IPv4-compatible or
  // 6to4 address this is the inner v4 form, which is what the classes below must see.
  bytes: readonly number[];
  family: 4 | 6;
  // The literal as written, kept so a v6 grant can still be matched in v6 space.
  originalBytes: readonly number[];
  originalFamily: 4 | 6;
  // Named, safe fact about why a v6-looking literal was judged as v4.
  resolvedFrom: string | null;
};

function v4(...octets: readonly number[]): readonly number[] {
  return octets;
}

function v6(...groups: readonly number[]): readonly number[] {
  // Written as 16-bit groups for readability, flattened and zero-padded to 16 bytes
  // so every prefix array is the same length as the addresses it is matched against.
  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >>> 8) & 0xff, group & 0xff);
  while (bytes.length < IPV6_LENGTH) bytes.push(0);
  return bytes;
}

// Order matters: the metadata endpoint lives inside link-local, so it is listed
// first and the operator is told the real reason instead of "link-local".
const V4_RANGES: readonly AddressRange[] = [
  { prefix: v4(0, 0, 0, 0), prefixLength: 8, addressClass: "unspecified" },
  { prefix: v4(10, 0, 0, 0), prefixLength: 8, addressClass: "private" },
  { prefix: v4(100, 64, 0, 0), prefixLength: 10, addressClass: "carrier-nat" },
  { prefix: v4(127, 0, 0, 0), prefixLength: 8, addressClass: "loopback" },
  { prefix: v4(169, 254, 169, 254), prefixLength: 32, addressClass: "metadata" },
  { prefix: v4(169, 254, 0, 0), prefixLength: 16, addressClass: "link-local" },
  { prefix: v4(172, 16, 0, 0), prefixLength: 12, addressClass: "private" },
  { prefix: v4(192, 168, 0, 0), prefixLength: 16, addressClass: "private" },
  { prefix: v4(192, 0, 0, 0), prefixLength: 24, addressClass: "reserved" },
  { prefix: v4(192, 0, 2, 0), prefixLength: 24, addressClass: "reserved" },
  { prefix: v4(198, 18, 0, 0), prefixLength: 15, addressClass: "reserved" },
  { prefix: v4(198, 51, 100, 0), prefixLength: 24, addressClass: "reserved" },
  { prefix: v4(203, 0, 113, 0), prefixLength: 24, addressClass: "reserved" },
  { prefix: v4(224, 0, 0, 0), prefixLength: 4, addressClass: "multicast" },
  { prefix: v4(240, 0, 0, 0), prefixLength: 4, addressClass: "reserved" },
];

const V6_RANGES: readonly AddressRange[] = [
  { prefix: v6(), prefixLength: 128, addressClass: "unspecified" },
  { prefix: v6(0, 0, 0, 0, 0, 0, 0, 1), prefixLength: 128, addressClass: "loopback" },
  { prefix: v6(0xfc00), prefixLength: 7, addressClass: "private" },
  { prefix: v6(0xfe80), prefixLength: 10, addressClass: "link-local" },
  { prefix: v6(0x2001, 0x0db8), prefixLength: 32, addressClass: "reserved" },
  { prefix: v6(0xff00), prefixLength: 8, addressClass: "multicast" },
];

// Known gap, stated rather than papered over: Teredo (`2001::/32`) and ISATAP also
// carry an inner v4 address and are not unpacked here. They are unreachable under a
// default-deny policy that grants no v6 range, and the profile's network namespace
// still denies egress; an operator granting `2001::/32` explicitly would have to
// revisit this list first.
export function parseIpv4Bytes(text: string): number[] | null {
  if (net.isIP(text) !== 4) return null;
  const octets = text.split(".");
  if (octets.length !== IPV4_LENGTH) return null;
  const bytes: number[] = [];
  for (const octet of octets) {
    const value = Number(octet);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function parseGroup(text: string): number | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(text)) return null;
  return Number.parseInt(text, 16);
}

// Expands an IPv6 literal — `::` compression and a trailing dotted-quad included —
// into sixteen bytes. Zone identifiers (`%eth0`) are refused outright: they name a
// host interface, which is host state with no place in this protocol (§12, D17).
export function expandIpv6Bytes(text: string): number[] | null {
  if (net.isIP(text) !== 6) return null;
  if (text.includes("%")) return null;
  if (text.split("::").length - 1 > 1) return null;

  const compression = text.indexOf("::");
  const left = compression === -1 ? text : text.slice(0, compression);
  const right = compression === -1 ? "" : text.slice(compression + 2);

  const collect = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const pieces = part.split(":");
    const groups: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index] as string;
      if (piece.length === 0) return null;
      if (piece.includes(".")) {
        // A dotted-quad is only legal as the final group, and it stands for exactly
        // two 16-bit groups: the high and low halves of the four octets.
        if (index !== pieces.length - 1) return null;
        const embedded = parseIpv4Bytes(piece);
        if (embedded === null) return null;
        groups.push(
          (embedded[0] as number) * 256 + (embedded[1] as number),
          (embedded[2] as number) * 256 + (embedded[3] as number),
        );
        continue;
      }
      const group = parseGroup(piece);
      if (group === null) return null;
      groups.push(group);
    }
    return groups;
  };

  const leftGroups = collect(left);
  const rightGroups = collect(right);
  if (leftGroups === null || rightGroups === null) return null;

  const groups: number[] = [];
  if (compression === -1) {
    if (leftGroups.length !== 8) return null;
    groups.push(...leftGroups);
  } else {
    const filler = 8 - leftGroups.length - rightGroups.length;
    if (filler < 1) return null;
    groups.push(...leftGroups);
    for (let index = 0; index < filler; index += 1) groups.push(0);
    groups.push(...rightGroups);
  }

  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >>> 8) & 0xff, group & 0xff);
  return bytes.length === IPV6_LENGTH ? bytes : null;
}

function asInnerIpv4(bytes: readonly number[]): { bytes: number[]; form: string } | null {
  if (bytes.length !== IPV6_LENGTH) return null;
  const highTwelveZero = bytes.slice(0, 10).every((value) => value === 0);
  // IPv4-mapped (::ffff:a.b.c.d).
  if (highTwelveZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { bytes: bytes.slice(12, 16), form: "ipv4-mapped" };
  }
  // Deprecated IPv4-compatible (::a.b.c.d). A dual-stack host routes it as the
  // inner v4 address, so it must be classified as that address too. The two v6
  // identities that live in this shape stay v6, otherwise `::1` would be read as
  // 0.0.0.1 and lose its own loopback class.
  const tail = bytes.slice(12, 16);
  const isV6Loopback = bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1;
  if (
    bytes.slice(0, 12).every((value) => value === 0) &&
    tail.some((value) => value !== 0) &&
    !isV6Loopback
  ) {
    return { bytes: tail, form: "ipv4-compatible" };
  }
  // 6to4 (2002::/16) carries a whole v4 address in bytes 2-5, so a literal that
  // reads as public v6 can still name 127.0.0.1. That is exactly the bypass class
  // DESIGN §12 blocks, so the inner address is what gets judged.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return { bytes: bytes.slice(2, 6), form: "6to4" };
  }
  return null;
}

export function parseDestination(destination: EgressDestination): ParsedAddress | null {
  const wantFamily: 4 | 6 =
    destination.kind === "ipv4Host" || destination.kind === "ipv4Prefix" ? 4 : 6;
  const bytes =
    wantFamily === 4
      ? parseIpv4Bytes(destination.address)
      : expandIpv6Bytes(destination.address);
  if (bytes === null) return null;
  if (destination.kind === "ipv4Prefix" || destination.kind === "ipv6Prefix") {
    const max = wantFamily === 4 ? MAX_IPV4_PREFIX : MAX_IPV6_PREFIX;
    if (destination.prefixLength > max) return null;
  }

  const inner = wantFamily === 6 ? asInnerIpv4(bytes) : null;
  return {
    bytes: inner === null ? bytes : inner.bytes,
    family: inner === null ? wantFamily : 4,
    originalBytes: bytes,
    originalFamily: wantFamily,
    resolvedFrom: inner === null ? null : inner.form,
  };
}

export function matchesPrefix(
  target: readonly number[],
  prefix: readonly number[],
  prefixLength: number,
): boolean {
  if (target.length !== prefix.length) return false;
  if (prefixLength > target.length * 8) return false;
  const wholeBytes = Math.floor(prefixLength / 8);
  const remainderBits = prefixLength % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (target[index] !== prefix[index]) return false;
  }
  if (remainderBits === 0) return true;
  const mask = (0xff << (8 - remainderBits)) & 0xff;
  return ((target[wholeBytes] ?? 0) & mask) === ((prefix[wholeBytes] ?? 0) & mask);
}

export function classifyAddress(parsed: ParsedAddress): EgressAddressClass {
  const ranges = parsed.family === 4 ? V4_RANGES : V6_RANGES;
  for (const range of ranges) {
    if (matchesPrefix(parsed.bytes, range.prefix, range.prefixLength)) return range.addressClass;
  }
  return "public";
}

// A prefix with host bits set is not a network address. Reading `10.0.0.5/24` as
// either the whole /24 or one host would be a different policy each time, so the
// only honest answer is to refuse the grant.
function hasCanonicalHostBits(prefix: readonly number[], prefixLength: number): boolean {
  const wholeBytes = Math.floor(prefixLength / 8);
  const remainderBits = prefixLength % 8;
  for (let index = wholeBytes; index < prefix.length; index += 1) {
    const byte = prefix[index] ?? 0;
    if (index === wholeBytes && remainderBits > 0) {
      const mask = (0xff << (8 - remainderBits)) & 0xff;
      if ((byte & ~mask) !== 0) return false;
      continue;
    }
    if (byte !== 0) return false;
  }
  return true;
}

function sameAddress(left: ParsedAddress, right: ParsedAddress): boolean {
  if (left.originalFamily !== right.originalFamily || left.family !== right.family) return false;
  if (left.originalBytes.length !== right.originalBytes.length) return false;
  const originalsEqual = left.originalBytes.every(
    (value, index) => value === right.originalBytes[index],
  );
  const resolvedEqual = left.bytes.every((value, index) => value === right.bytes[index]);
  return originalsEqual && resolvedEqual;
}

function grantDestinationMatches(
  grantDestination: EgressDestination,
  target: ParsedAddress,
): boolean {
  const grant = parseDestination(grantDestination);
  if (grant === null) return false;
  if (grantDestination.kind === "ipv4Host" || grantDestination.kind === "ipv6Host") {
    return sameAddress(grant, target);
  }
  const prefixLength = grantDestination.prefixLength;
  // Match in the literal's own space first, so a v6 grant never silently narrows to
  // its mapped v4 half; then in the resolved space, so an encapsulated spelling of a
  // granted v4 range still counts as the address it routes to.
  if (
    grant.originalFamily === target.originalFamily &&
    matchesPrefix(target.originalBytes, grant.originalBytes, prefixLength)
  ) {
    return true;
  }
  return grant.family === target.family && matchesPrefix(target.bytes, grant.bytes, prefixLength);
}

function isFixtureClassAllowed(value: EgressAddressClass): boolean {
  return value === "loopback" || value === "private";
}

function namesOneHost(destination: EgressDestination): boolean {
  if (destination.kind === "ipv4Host" || destination.kind === "ipv6Host") return true;
  return (
    destination.prefixLength === MAX_IPV4_PREFIX || destination.prefixLength === MAX_IPV6_PREFIX
  );
}

export class SandboxEgressPolicy implements EgressPolicyPort {
  review(policy: EgressPolicy): EgressReview {
    const reasons: string[] = [];
    if (policy.defaultAction !== "deny") {
      reasons.push("default-action-not-deny");
    }
    for (const grant of policy.grants) {
      const destination = parseDestination(grant.destination);
      if (destination === null) {
        reasons.push(`grant-address-unparseable:${grant.grantId}`);
        continue;
      }
      if (grant.destination.kind === "ipv4Prefix" || grant.destination.kind === "ipv6Prefix") {
        if (!hasCanonicalHostBits(destination.originalBytes, grant.destination.prefixLength)) {
          reasons.push(`grant-prefix-not-canonical:${grant.grantId}`);
        }
      }
      const addressClass = classifyAddress(destination);
      if (grant.kind === "publicDestination") {
        // A "public" grant to a blocked class is the allow-all-private mistake
        // §12 names by name, so it is refused instead of quietly narrowed.
        if (isBlockedClass(addressClass)) {
          reasons.push(`grant-class-blocked:${grant.grantId}:${addressClass}`);
        }
        continue;
      }
      if (!isFixtureClassAllowed(addressClass)) {
        reasons.push(`fixture-grant-class-invalid:${grant.grantId}:${addressClass}`);
      }
      if (!namesOneHost(grant.destination)) {
        reasons.push(`fixture-grant-must-name-one-host:${grant.grantId}`);
      }
      if (policy.networkNamespace !== "fixture") {
        reasons.push(`fixture-grant-requires-fixture-network:${grant.grantId}`);
      }
      if (destination.resolvedFrom !== null) {
        // A fixture has one address in one family; an encapsulated spelling of it
        // would be a second identity for the same host.
        reasons.push(
          `fixture-grant-encapsulated-address:${grant.grantId}:${destination.resolvedFrom}`,
        );
      }
    }
    return { admissible: reasons.length === 0, reasons };
  }

  evaluate(input: {
    policy: EgressPolicy;
    destination: EgressDestination;
    port: number;
  }): EgressDecision {
    const parsed = parseDestination(input.destination);
    if (parsed === null) {
      return { decision: "deny", addressClass: "reserved", reasons: ["destination-unparseable"] };
    }
    const addressClass = classifyAddress(parsed);
    const reasons: string[] = [];
    if (parsed.resolvedFrom !== null) {
      reasons.push(`address-resolved-from:${parsed.resolvedFrom}`);
    }

    if (isBlockedClass(addressClass)) {
      // The only way out of a blocked class is a fixture grant that names this very
      // host, on this port, in the fixture network — never a broader prefix and
      // never a public grant.
      if (isFixtureClassAllowed(addressClass) && input.policy.networkNamespace === "fixture") {
        const fixtureGrant = input.policy.grants.find(
          (grant) =>
            grant.kind === "localFixture" &&
            grant.port === input.port &&
            grantDestinationMatches(grant.destination, parsed),
        );
        if (fixtureGrant !== undefined && namesOneHost(fixtureGrant.destination)) {
          return { decision: "allow", grantId: fixtureGrant.grantId, addressClass };
        }
      }
      reasons.push(
        addressClass === "metadata"
          ? "metadata-address-blocked"
          : `${addressClass}-address-blocked`,
      );
      return { decision: "deny", addressClass, reasons };
    }

    const grant = input.policy.grants.find(
      (candidate) =>
        candidate.kind === "publicDestination" &&
        // A grant is a (destination, port) pair: reaching the same address on a
        // different port is a different policy, and §12 grants nothing implicitly.
        candidate.port === input.port &&
        grantDestinationMatches(candidate.destination, parsed),
    );
    if (grant === undefined) {
      reasons.push("default-deny-no-grant");
      return { decision: "deny", addressClass, reasons };
    }
    return { decision: "allow", grantId: grant.grantId, addressClass };
  }
}

export const sandboxEgressPolicy: SandboxEgressPolicy = new SandboxEgressPolicy();
