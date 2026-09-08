// @vitest-environment node
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps Happy DOM mutation observers alive across garbage collection until disconnected", () => {
  // A separate Node process provides real GC without changing the Vitest worker.
  // happy-dom 20.10.1 lost its anonymous listener through an orphaned WeakRef.
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { Window } from 'happy-dom';
    const window = new Window();
    let deliveries = 0;
    const observer = new window.MutationObserver(() => deliveries++);
    const nextJob = () => new Promise(resolve => setTimeout(resolve, 0));
    observer.observe(window.document.body, { childList: true, subtree: true });
    window.document.body.append(window.document.createElement('div'));
    await nextJob();
    assert.equal(deliveries, 1, 'initial mutation must be delivered');
    for (let i = 0; i < 3; i++) { global.gc(); await nextJob(); }
    window.document.body.append(window.document.createElement('aside'));
    await nextJob();
    assert.equal(deliveries, 2, 'a connected observer must survive garbage collection');
    observer.disconnect();
    window.document.body.append(window.document.createElement('dialog'));
    await nextJob();
    assert.equal(deliveries, 2, 'disconnect must stop delivery');
    window.happyDOM.close();
  `], { encoding: "utf8", timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
// Allow cold module loading in the child process on HDD-backed runners.
}, 30_000);
