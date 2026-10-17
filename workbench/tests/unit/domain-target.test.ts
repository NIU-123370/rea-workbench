import { describe, expect, it } from "vitest";

import { URL_TARGET_IDENTITY_REASON, normalizeUrlLocator, urlLocatorDefects } from "../../packages/domain/target.ts";

// Which declared URL may become a capture target (§8 line 273, §5's "敏感 locator 不落库").
// The rule lives here, in front of any row or request, because what it decides is what the
// database is allowed to hold.

describe("the declared URL locator (§8 line 273 / §5)", () => {
  it("stores the serialised form, not the typed characters", () => {
    const settled = normalizeUrlLocator("HTTPS://Shop.Example/Cart/../checkout?x=1");
    expect(settled.ok && settled.value.locator).toBe("https://shop.example/checkout?x=1");
    // The host is what the journal gets to say about the row, so it is returned rather than
    // made each caller re-parse the locator.
    expect(settled.ok && settled.value.host).toBe("shop.example");
  });

  it("refuses credentials in the locator by name", () => {
    expect(urlLocatorDefects("https://user:token@shop.example/cart")).toContain("url-credentials-forbidden");
    // The same secret wearing an encoding the naive check would not see: the rule is applied to
    // the parsed URL, so percent-encoding cannot make a userinfo disappear.
    expect(urlLocatorDefects("https://user%3Atoken@shop.example/cart")).toContain("url-credentials-forbidden");
  });

  it("refuses a fragment, because it is where a token ends up and never reaches a server", () => {
    expect(urlLocatorDefects("https://shop.example/cart#access_token=abc")).toContain("url-fragment-forbidden");
  });

  it("refuses every scheme the capture sandbox may not reach", () => {
    expect(urlLocatorDefects("file:///etc/passwd")).toContain("url-scheme-not-http:file");
    expect(urlLocatorDefects("javascript:alert(1)")).toContain("url-scheme-not-http:javascript");
    expect(urlLocatorDefects("data:text/plain,hi")).toContain("url-scheme-not-http:data");
    expect(urlLocatorDefects("not a url at all")).toContain("url-unparseable");
    expect(urlLocatorDefects("")).toContain("url-empty");
  });

  it("keeps every reason it found instead of reporting only the first", () => {
    const defects = urlLocatorDefects("ftp://user:pw@host.invalid/x#y");
    expect(defects).toContain("url-scheme-not-http:ftp");
    expect(defects).toContain("url-credentials-forbidden");
    expect(defects).toContain("url-fragment-forbidden");
    expect(defects).toHaveLength(3);
  });

  it("bounds the locator length before anything is stored", () => {
    const long = "https://shop.example/" + "a".repeat(2000);
    expect(urlLocatorDefects(long).some((reason) => reason.startsWith("url-over-length"))).toBe(true);
    // Every host-less spelling fails to parse rather than parsing to an empty host, which is why
    // the rule set has no "empty host" branch of its own. The IPv6 bracket form is a host.
    expect(urlLocatorDefects("http://")).toContain("url-unparseable");
    // `https:///path` is the one spelling that looks host-less and is not: the URL standard hoists
    // the first segment into the host, so this parses as the host "path". The rule set follows the
    // parser rather than second-guessing it, and this line is where that choice is written down.
    expect(urlLocatorDefects("https:///path")).toEqual([]);
    expect(urlLocatorDefects("http://[::1]:8080/cart")).toEqual([]);
  });

  it("names why a declared URL has no identity yet, in words that cannot be mistaken for a failure", () => {
    expect(URL_TARGET_IDENTITY_REASON).toBe("url-declared-not-captured");
    // The reason is a fixed vocabulary item, not a sentence a caller could paraphrase into
    // meaning "the capture could not identify its source".
    expect(URL_TARGET_IDENTITY_REASON).not.toContain(" ");
  });
});
