import assert from "node:assert/strict";

import { runWhenDocumentReady } from "./app-startup.js";

{
  let listener = null;
  let listenerOptions = null;
  let calls = 0;
  const documentRef = {
    readyState: "loading",
    addEventListener(type, callback, options) {
      assert.equal(type, "DOMContentLoaded");
      listener = callback;
      listenerOptions = options;
    },
  };

  runWhenDocumentReady(documentRef, () => {
    calls += 1;
  });

  assert.equal(calls, 0);
  assert.deepEqual(listenerOptions, { once: true });
  listener();
  assert.equal(calls, 1);
}

for (const readyState of ["interactive", "complete"]) {
  let calls = 0;
  const documentRef = {
    readyState,
    addEventListener() {
      throw new Error("should not wait for DOMContentLoaded after document is ready");
    },
  };

  runWhenDocumentReady(documentRef, () => {
    calls += 1;
  });

  assert.equal(calls, 1);
}
