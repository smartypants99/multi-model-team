import { describe, it, expect } from "vitest";
import { checkOutboundUrl, isPrivateAddress } from "../src/tools/netguard.js";

describe("outbound URL policy", () => {
  it("classifies private, loopback and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("refuses loopback and private targets for fetch_url, in every spelling", async () => {
    for (const u of ["http://127.0.0.1:4310/api/runs", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://2130706433/", "http://0x7f000001/", "http://10.0.0.5/", "http://metadata/", "http://foo.internal/"]) {
      expect(await checkOutboundUrl(u, { allowLoopback: false }), u).toBeTruthy();
    }
  });
  it("allows loopback only when the policy says so (screenshots of a dev server)", async () => {
    expect(await checkOutboundUrl("http://127.0.0.1:8080/index.html", { allowLoopback: true })).toBeUndefined();
    expect(await checkOutboundUrl("http://localhost:8080/", { allowLoopback: true })).toBeUndefined();
    expect(await checkOutboundUrl("http://169.254.169.254/", { allowLoopback: true })).toBeTruthy();
    expect(await checkOutboundUrl("http://192.168.0.10/", { allowLoopback: true })).toBeTruthy();
  });
  it("rejects non-http schemes", async () => {
    expect(await checkOutboundUrl("file:///etc/passwd", { allowLoopback: true })).toBeTruthy();
    expect(await checkOutboundUrl("ftp://example.com/", { allowLoopback: true })).toBeTruthy();
  });
});
