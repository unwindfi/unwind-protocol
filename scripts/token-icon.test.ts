/*
 * Token logos: which URLs are tried, and what counts as an image. No network.
 */
import { assert } from "chai";
import { candidates, ipfsPath, isMint, sniff } from "./token-icon";

const CID = "bafkreibyb3hcn7gglvdqpmklfev3fut3eqv3kje54l3to3xzxxbgpt5wjm";

describe("token logos", () => {
  it("finds the IPFS path in every shape metadata uses", () => {
    assert.equal(ipfsPath(`ipfs://${CID}`), CID);
    assert.equal(ipfsPath(`ipfs://ipfs/${CID}/a.png`), `${CID}/a.png`);
    assert.equal(ipfsPath(`https://ipfs.io/ipfs/${CID}`), CID);
    assert.equal(ipfsPath(`https://sapphire-working-koi-276.mypinata.cloud/ipfs/${CID}?x=1`), `${CID}?x=1`);
    assert.equal(ipfsPath(`https://${CID}.ipfs.dweb.link/`), CID);
    assert.equal(ipfsPath(`https://${CID}.ipfs.dweb.link/logo.png`), `${CID}/logo.png`);
    assert.isNull(ipfsPath("https://arweave.net/abc"));
    assert.isNull(ipfsPath("not a url"));
  });

  it("tries the URL as given, then public gateways", () => {
    const c = candidates(`https://x.mypinata.cloud/ipfs/${CID}`);
    assert.equal(c[0], `https://x.mypinata.cloud/ipfs/${CID}`);
    assert.include(c, `https://ipfs.filebase.io/ipfs/${CID}`);
    assert.deepEqual(candidates("https://arweave.net/abc"), ["https://arweave.net/abc"]);
    // Plain http and other schemes are never fetched as given.
    assert.deepEqual(candidates("http://example.com/a.png"), []);
    assert.deepEqual(candidates("file:///etc/passwd"), []);
    assert.equal(candidates(`ipfs://${CID}`)[0], `https://ipfs.filebase.io/ipfs/${CID}`);
  });

  it("knows an image by its bytes", () => {
    assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
    assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniff(Buffer.from("GIF89a")), "image/gif");
    assert.equal(sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
    assert.equal(sniff(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>')), "image/svg+xml");
    assert.equal(sniff(Buffer.from("<svg viewBox='0 0 1 1'/>")), "image/svg+xml");
    assert.isNull(sniff(Buffer.from("<html><body>403</body></html>")));
    assert.isNull(sniff(Buffer.from('{"error":"forbidden"}')));
  });

  it("takes only a mint", () => {
    assert.isTrue(isMint("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"));
    assert.isFalse(isMint("../../etc/passwd"));
    assert.isFalse(isMint("short"));
  });
});
