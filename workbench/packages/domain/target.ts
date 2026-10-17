import type { Result } from "./result.ts";
import { err, ok } from "./result.ts";

// Which URL may become a capture target (§8 line 273, §5's "敏感 locator 不落库").
//
// A declared URL target is the one kind of target an operator types rather than captures, so
// this is the place where a string becomes a stored locator. Three things are refused rather
// than normalised away, because each of them is a credential or a different resource wearing
// the shape of a URL:
//   * userinfo (`https://user:token@host`) - a bearer secret landing in a row that other
//     screens list;
//   * a fragment - never sent to a server, and in practice where a session token ends up;
//   * any scheme but http(s) - `file:`, `data:` and `javascript:` name something the capture
//     sandbox is not allowed to reach, so accepting them would be promising a capture that
//     cannot happen.
//
// What is stored is the *serialised* URL, not the typed characters: percent-encoding has more
// than one spelling for the same address, and a rule that checked the raw text could be walked
// around by a form the parser did not look at. There is deliberately no "host is empty" rule:
// every spelling that would produce one (`http://`, `//host/x`, `http:`) fails to parse at all,
// so such a check could never be reached and would only look like a guard.

const MAX_LOCATOR_LENGTH = 2000;

export type UrlLocator = { locator: string; host: string };

export function urlLocatorDefects(url: string): string[] {
  const reasons: string[] = [];
  if (url.length === 0) reasons.push("url-empty");
  if (url.length > MAX_LOCATOR_LENGTH) reasons.push(`url-over-length:${String(MAX_LOCATOR_LENGTH)}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    reasons.push("url-unparseable");
    return reasons;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") reasons.push(`url-scheme-not-http:${parsed.protocol.replace(":", "")}`);
  if (parsed.username.length > 0 || parsed.password.length > 0) reasons.push("url-credentials-forbidden");
  if (parsed.hash.length > 0) reasons.push("url-fragment-forbidden");
  return reasons;
}

// The normalised locator, or every reason this one cannot be stored. An IPv6 literal keeps its
// brackets because that is how the serialised form spells it; the check is on `hostname`, which
// strips them.
// Every reason the URL cannot be stored, or the locator as it will be written. The caller turns
// these strings into a named refusal: this module owns the rule, not the status code.
export function normalizeUrlLocator(url: string): Result<UrlLocator, string[]> {
  const defects = urlLocatorDefects(url);
  if (defects.length > 0) return err(defects);
  const parsed = new URL(url);
  return ok({ locator: parsed.toString(), host: parsed.hostname });
}

// Why a URL target has no snapshot yet (§8 line 273: 身份未知). This is a *stated* reason with a
// fixed vocabulary, not a null the reader has to interpret: the same column also carries the
// reason a capture could not identify its source, and those two must not look alike.
export const URL_TARGET_IDENTITY_REASON = "url-declared-not-captured";

// The three kinds a target row may carry (§8's `target.kind`), owned here for the same reason the
// identity reason above is: a screen has to be able to tell "this target is a URL I declared" from
// "this target is bytes somebody imported", and the door that refuses an inspect against a URL
// target refuses it by that difference. `contracts/resources.ts` re-exports this list into its
// schema, so the value the server stores, the value the read answers with, and the value a panel
// can name are one vocabulary rather than three that happen to agree today.
export const TARGET_KINDS = ["url", "har", "asar"] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];

export function isTargetKind(name: string): name is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(name);
}
