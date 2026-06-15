import { describe, expect, it } from "vitest";

import { domainOf, siteName } from "./sourceUtils";

describe("domainOf", () => {
  it("returns the hostname without www", () => {
    expect(domainOf("https://www.example.com/a")).toBe("example.com");
    expect(domainOf("https://ja.wikipedia.org/wiki/X")).toBe("ja.wikipedia.org");
  });

  it("returns empty string for unparseable urls", () => {
    expect(domainOf("not a url")).toBe("");
  });
});

describe("siteName", () => {
  it("strips a single TLD", () => {
    expect(siteName("https://instagram.com/x")).toBe("instagram");
    expect(siteName("https://www.example.net")).toBe("example");
  });

  it("strips the TLD across subdomains", () => {
    expect(siteName("https://ja.wikipedia.org/wiki/X")).toBe("wikipedia");
  });

  it("handles multi-part public suffixes", () => {
    expect(siteName("https://finance.sina.com.cn/news")).toBe("sina");
    expect(siteName("https://news.bbc.co.uk/story")).toBe("bbc");
  });

  it("falls back gracefully", () => {
    expect(siteName("not a url")).toBe("");
  });
});
