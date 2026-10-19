(() => {
  "use strict";

  const GLOBAL_KEY = "__memosOneClickCopyV030"; // Keep the old teardown key for upgrades.
  const BUTTON_SELECTOR = "[data-memos-one-click-copy]";

  // Read the exact Markdown passed to the renderer in the current DOM commit.
  // Do not use innerText, cached content, or React Fiber alternates: these can
  // lose formatting, omit collapsed text, or copy an older version after editing.
  const readRawContent = (card) => {
    const host = [...card.querySelectorAll("[data-memo-content]")].find((node) => node.closest("article") === card);
    const name = host?.getAttribute("data-memo-name");
    if (!name || !/^memos\/[A-Za-z0-9_-]+$/.test(name)) throw new Error("无法识别这条备忘录，请刷新页面后重试");
    const propsKey = Object.keys(host).find((key) => key.startsWith("__reactProps$"));
    const children = host[propsKey]?.children;
    const renderer = (Array.isArray(children) ? children : [children]).find(
      (child) => child?.props?.memoName === name && typeof child.props.content === "string",
    );
    if (!renderer) throw new Error("当前 Memos 页面结构不兼容，无法读取原始内容");
    return renderer.props.content;
  };

  // Only invoke this synchronously inside a real click, including a retry after
  // a rejected Clipboard API request. Never try it after awaiting menu renders.
  const legacyCopy = (text, doc) => {
    const active = doc.activeElement;
    const selection = doc.getSelection();
    const ranges = [];
    for (let i = 0; selection && i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
    const inputSelection = active && typeof active.selectionStart === "number"
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const textarea = doc.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute("aria-label", "复制备忘录内容");
    textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;";
    doc.body.append(textarea);
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      if (!doc.execCommand("copy")) throw new Error("浏览器拒绝复制，请检查剪贴板权限");
    } finally {
      textarea.remove();
      if (active?.isConnected) active.focus({ preventScroll: true });
      if (inputSelection) active.setSelectionRange(...inputSelection);
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach((range) => selection.addRange(range));
      }
    }
  };

  const copyPlainText = (text, env, fallback = false) => {
    if (!fallback && env.isSecureContext && typeof env.navigator.clipboard?.writeText === "function") {
      // Start the write NOW, before any await, timer, fetch, or synthetic event.
      return env.navigator.clipboard.writeText(text);
    }
    legacyCopy(text, env.document);
    return Promise.resolve();
  };

  // Allow focused regression tests without shipping a separate build artifact.
  if (typeof module === "object" && module.exports && typeof window === "undefined") {
    module.exports = { readRawContent, copyPlainText, legacyCopy };
    return;
  }

  window[GLOBAL_KEY]?.destroy?.();
  document.documentElement.classList.remove("memos-one-click-copy-running");
  let scanFrame = 0;
  let stopped = false;
  let noticeTimer;
  const resetTimers = new Set();
  const notice = document.createElement("div");
  notice.className = "memos-one-click-copy-notice";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.hidden = true;
  document.body.append(notice);

  const report = (message, failed) => {
    notice.textContent = message;
    notice.dataset.state = failed ? "error" : "success";
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, failed ? 6000 : 1800);
  };

  const addButton = (card) => {
    if (!card.querySelector("[data-memo-content]") || card.querySelector(BUTTON_SELECTOR)) return;
    const menuTrigger = [...card.querySelectorAll('[data-slot="dropdown-menu-trigger"]')].find(
      (node) => node.closest("article") === card && node.querySelector("svg.lucide-ellipsis-vertical"),
    );
    if (!menuTrigger) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memos-one-click-copy";
    button.setAttribute("data-memos-one-click-copy", "");
    button.setAttribute("aria-label", "复制内容");
    button.title = "一键复制备忘录原始内容";
    const icon = document.createElement("span");
    icon.className = "memos-one-click-copy__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📋";
    const label = document.createElement("span");
    label.className = "memos-one-click-copy__label";
    label.textContent = "复制内容";
    button.append(icon, label);
    let fallbackNextClick = false;
    let resetTimer;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled || stopped) return;
      clearTimeout(resetTimer);
      resetTimers.delete(resetTimer);
      let writing;
      try {
        const content = readRawContent(card);
        writing = copyPlainText(content, window, fallbackNextClick);
      } catch (error) {
        report(error.message || "复制失败，请刷新页面重试", true);
        return;
      }
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      Promise.resolve(writing).then(() => {
        if (stopped) return;
        fallbackNextClick = false;
        label.textContent = "已复制";
        button.dataset.state = "success";
        report("备忘录原始内容已复制", false);
      }, () => {
        if (stopped) return;
        fallbackNextClick = true;
        label.textContent = "重试复制";
        button.dataset.state = "error";
        report("浏览器未允许复制，请再点一次“复制内容”使用兼容方式", true);
      }).finally(() => {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        if (stopped) return;
        resetTimer = setTimeout(() => {
          label.textContent = "复制内容";
          delete button.dataset.state;
          resetTimers.delete(resetTimer);
        }, 1800);
        resetTimers.add(resetTimer);
      });
    });
    menuTrigger.before(button);
  };
  const scan = () => {
    scanFrame = 0;
    if (!stopped) document.querySelectorAll("article").forEach(addButton);
  };
  const observer = new MutationObserver(() => {
    if (!scanFrame) scanFrame = requestAnimationFrame(scan);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
  window[GLOBAL_KEY] = {
    version: "2026-10-19",
    destroy() {
      stopped = true;
      observer.disconnect();
      cancelAnimationFrame(scanFrame);
      clearTimeout(noticeTimer);
      resetTimers.forEach(clearTimeout);
      notice.remove();
      document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => button.remove());
      delete window[GLOBAL_KEY];
    },
  };
})();
