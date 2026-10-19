"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readRawContent, copyPlainText, legacyCopy } = require("./quick-copy-content.js");

function memoCard(content = "original", name = "memos/example_123") {
  const card = { querySelectorAll: () => [host] };
  const host = {
    closest: () => card,
    getAttribute: (attribute) => attribute === "data-memo-name" ? name : null,
    __reactProps$current: { children: { props: { memoName: name, content } } },
  };
  Object.defineProperty(host, "innerText", { get() { throw new Error("Rendered text must never be copied"); } });
  Object.defineProperty(host, "__reactFiber$stale", { get() { throw new Error("Fiber alternates must not be used"); } });
  return { card, host };
}

function selectionDocument({ copyResult = true, copyError } = {}) {
  const calls = [];
  const oldRange = { cloneRange: () => restoredRange };
  const restoredRange = {};
  const selection = {
    rangeCount: 1,
    getRangeAt(index) { assert.equal(index, 0); return oldRange; },
    removeAllRanges() { calls.push(["removeAllRanges"]); },
    addRange(range) { calls.push(["addRange", range]); },
  };
  const active = {
    isConnected: true,
    selectionStart: 2,
    selectionEnd: 5,
    selectionDirection: "backward",
    focus(options) { calls.push(["restoreFocus", options]); },
    setSelectionRange(...args) { calls.push(["restoreInputSelection", ...args]); },
  };
  const textarea = {
    style: {},
    setAttribute() {},
    focus(options) { calls.push(["focus", options]); },
    select() { calls.push(["select"]); },
    setSelectionRange(...args) { calls.push(["selectRange", ...args]); },
    remove() { calls.push(["removeTextarea"]); },
  };
  const doc = {
    activeElement: active,
    getSelection: () => selection,
    createElement(tag) { assert.equal(tag, "textarea"); return textarea; },
    body: { append(node) { assert.equal(node, textarea); calls.push(["append"]); } },
    execCommand(command) {
      assert.equal(command, "copy");
      calls.push(["copy", textarea.value]);
      if (copyError) throw copyError;
      return copyResult;
    },
  };
  return { doc, calls, textarea, active, restoredRange };
}

test("copies original Markdown and Unicode exactly, including an empty memo", () => {
  for (const content of ["# 标题 🐑\n\n[链接](https://example.test/a)\n\n```js\n  let x = 1;\n```\n\t尾部  \n", ""]) {
    const { card } = memoCard(content);
    assert.equal(readRawContent(card), content);
  }
});

test("reads newly committed props after an edit instead of retaining the first memo content", () => {
  const { card, host } = memoCard("before edit");
  assert.equal(readRawContent(card), "before edit");
  host.__reactProps$current = { children: { props: { memoName: "memos/example_123", content: "after edit\n" } } };
  assert.equal(readRawContent(card), "after edit\n");
});

test("scopes extraction to the requested article and validates the renderer's memo identity", () => {
  const { card, host } = memoCard("correct memo");
  const nested = memoCard("nested memo", "memos/nested");
  card.querySelectorAll = () => [nested.host, host];
  host.__reactProps$current.children = [
    { props: { memoName: "memos/other", content: "wrong memo" } },
    { props: { memoName: "memos/example_123", content: "correct memo" } },
  ];
  assert.equal(readRawContent(card), "correct memo");
  host.__reactProps$current.children = { props: { memoName: "memos/other", content: "wrong memo" } };
  assert.throws(() => readRawContent(card), /无法读取原始内容/);
});

test("fails closed on unknown structures, invalid names, and non-string content", () => {
  assert.throws(() => readRawContent({ querySelectorAll: () => [] }), /无法识别/);
  for (const name of ["", "users/123", "memos/../secret"]) {
    assert.throws(() => readRawContent(memoCard("content", name).card), /无法识别/);
  }
  for (const content of [undefined, null, 7, { toString: () => "not a string" }]) {
    const fixture = memoCard();
    fixture.host.__reactProps$current.children.props.content = content;
    assert.throws(() => readRawContent(fixture.card), /无法读取原始内容/);
  }
  const fixture = memoCard();
  delete fixture.host.__reactProps$current;
  assert.throws(() => readRawContent(fixture.card), /无法读取原始内容/);
});

test("starts clipboard writing synchronously and waits for actual completion", async () => {
  const calls = [];
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const clipboard = {
    writeText(text) {
      assert.equal(this, clipboard);
      calls.push(["write", text]);
      return pending;
    },
  };
  const writing = copyPlainText("exact\nMarkdown 🐑", {
    isSecureContext: true,
    navigator: { clipboard },
    document: { getSelection() { throw new Error("Modern path must not touch selection"); } },
  });
  calls.push(["handler returned"]);
  assert.deepEqual(calls, [["write", "exact\nMarkdown 🐑"], ["handler returned"]]);
  assert.equal(writing, pending);
  let resolved = false;
  writing.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  finish();
  await writing;
  assert.equal(resolved, true);
});

test("preserves clipboard rejection and never attempts an asynchronous legacy fallback", async () => {
  const error = new Error("clipboard permission denied");
  let fallbacks = 0;
  const writing = copyPlainText("content", {
    isSecureContext: true,
    navigator: { clipboard: { writeText: () => Promise.reject(error) } },
    document: { getSelection() { fallbacks++; throw new Error("Unexpected fallback"); } },
  });
  await assert.rejects(writing, (actual) => actual === error);
  assert.equal(fallbacks, 0);
});

test("legacy copy selects all content synchronously and restores selection and focus", async () => {
  const fixture = selectionDocument();
  const text = "中文\n  Markdown\n🐑";
  const writing = copyPlainText(text, { isSecureContext: true, navigator: {}, document: fixture.doc });
  assert.equal(fixture.textarea.value, text);
  assert.equal(fixture.textarea.readOnly, true);
  assert.deepEqual(fixture.calls, [
    ["append"], ["focus", { preventScroll: true }], ["select"], ["selectRange", 0, text.length],
    ["copy", text], ["removeTextarea"], ["restoreFocus", { preventScroll: true }],
    ["restoreInputSelection", 2, 5, "backward"], ["removeAllRanges"], ["addRange", fixture.restoredRange],
  ]);
  await writing;
});

test("explicit retry uses the synchronous compatibility path despite available Clipboard API", async () => {
  const fixture = selectionDocument();
  const writing = copyPlainText("retry", {
    isSecureContext: true,
    navigator: { clipboard: { writeText() { throw new Error("Retry must avoid the rejected API"); } } },
    document: fixture.doc,
  }, true);
  assert.ok(fixture.calls.some(([name]) => name === "copy"));
  await writing;
});

test("insecure contexts use compatibility copy without attempting Clipboard API", async () => {
  const fixture = selectionDocument();
  await copyPlainText("http fallback", {
    isSecureContext: false,
    navigator: { clipboard: { writeText() { throw new Error("Secure API unavailable here"); } } },
    document: fixture.doc,
  });
  assert.ok(fixture.calls.some(([name]) => name === "copy"));
});

test("legacy failure is reported and temporary content is removed even if the browser throws", () => {
  for (const options of [{ copyResult: false }, { copyError: new Error("system clipboard unavailable") }]) {
    const fixture = selectionDocument(options);
    assert.throws(() => legacyCopy("private memo", fixture.doc));
    assert.ok(fixture.calls.some(([name]) => name === "removeTextarea"));
    assert.ok(fixture.calls.some(([name]) => name === "restoreFocus"));
    assert.deepEqual(fixture.calls.at(-1), ["addRange", fixture.restoredRange]);
  }
});
