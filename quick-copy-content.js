(() => {
  "use strict";

  const GLOBAL_KEY = "__memosOneClickCopyV030";
  const BUTTON_SELECTOR = "[data-memos-one-click-copy]";
  const RUNNING_CLASS = "memos-one-click-copy-running";

  // Saving this setting injects another script element. Tear down an older
  // copy first so observers and buttons never accumulate.
  window[GLOBAL_KEY]?.destroy?.();

  let observer;
  let scanFrame = 0;
  let stopped = false;

  const normalize = (value) => (value || "").replace(/\s+/g, "").toLocaleLowerCase();

  const popupFor = (control) => {
    const id = control?.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  };

  const waitFor = (lookup, timeoutMs = 1500) =>
    new Promise((resolve, reject) => {
      const immediate = lookup();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const watcher = new MutationObserver(() => {
        const match = lookup();
        if (!match) return;
        clearTimeout(timer);
        watcher.disconnect();
        resolve(match);
      });

      const timer = window.setTimeout(() => {
        watcher.disconnect();
        reject(new Error("等待 Memos 菜单超时"));
      }, timeoutMs);

      watcher.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-expanded", "aria-controls"],
      });
    });

  // Base UI 1.6 (used by Memos 0.30.0) opens this trigger on pointer/mouse down.
  const pressMenuTrigger = (element) => {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const common = { bubbles: true, cancelable: true, button: 0, clientX, clientY, view: window };

    if (typeof PointerEvent === "function") {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          ...common,
          buttons: 1,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    }
    element.dispatchEvent(new MouseEvent("mousedown", { ...common, buttons: 1 }));
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          ...common,
          buttons: 0,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    }
    element.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0 }));
  };

  const findOwnMenuTrigger = (card) =>
    [...card.querySelectorAll('[data-slot="dropdown-menu-trigger"]')].find(
      (element) => element.closest("article") === card && element.querySelector("svg.lucide-ellipsis-vertical"),
    );

  const findCopySubmenuTrigger = (menu) =>
    [...menu.querySelectorAll('[data-slot="dropdown-menu-sub-trigger"]')].find((element) => {
      // Lucide classes are language-independent; the text checks are safe fallbacks.
      if (element.querySelector("svg.lucide-copy")) return true;
      return ["复制", "複製", "copy"].includes(normalize(element.textContent));
    });

  const findCopyContentItem = (menu) =>
    [...menu.querySelectorAll('[data-slot="dropdown-menu-item"]')].find((element) => {
      if (element.querySelector("svg.lucide-file-text")) return true;
      return ["复制内容", "複製內容", "copycontent"].includes(normalize(element.textContent));
    });

  const openRootMenu = async (trigger) => {
    const alreadyOpen = trigger.getAttribute("aria-expanded") === "true" && popupFor(trigger);
    if (alreadyOpen) return alreadyOpen;

    pressMenuTrigger(trigger);
    return waitFor(() => (trigger.getAttribute("aria-expanded") === "true" ? popupFor(trigger) : null));
  };

  const openCopySubmenu = async (trigger) => {
    const alreadyOpen = trigger.getAttribute("aria-expanded") === "true" && popupFor(trigger);
    if (alreadyOpen) return alreadyOpen;

    trigger.focus({ preventScroll: true });
    const rtl = getComputedStyle(trigger).direction === "rtl";
    const key = rtl ? "ArrowLeft" : "ArrowRight";
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
    trigger.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));

    return waitFor(() => (trigger.getAttribute("aria-expanded") === "true" ? popupFor(trigger) : null));
  };

  const closeMenu = (menu) => {
    menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  };

  const setButtonState = (button, state) => {
    const label = button.querySelector(".memos-one-click-copy__label");
    if (!label) return;

    window.clearTimeout(Number(button.dataset.resetTimer || 0));
    label.textContent = state === "success" ? "已复制" : "复制失败";
    button.dataset.state = state;
    button.dataset.resetTimer = String(
      window.setTimeout(() => {
        if (!label.isConnected) return;
        label.textContent = "复制内容";
        delete button.dataset.state;
        delete button.dataset.resetTimer;
      }, 1600),
    );
  };

  const copyWithMemos = async (card, button) => {
    const trigger = findOwnMenuTrigger(card);
    if (!trigger) throw new Error("没有找到备忘录操作菜单");

    let rootMenu;
    try {
      rootMenu = await openRootMenu(trigger);
      const copyTrigger = findCopySubmenuTrigger(rootMenu);
      if (!copyTrigger) throw new Error("没有找到“复制”菜单");

      const copyMenu = await openCopySubmenu(copyTrigger);
      const copyContentItem = findCopyContentItem(copyMenu);
      if (!copyContentItem) throw new Error("没有找到“复制内容”菜单项");

      // Reuse Memos' own handler: exact Markdown source, native clipboard
      // fallback, and the normal Memos success toast.
      copyContentItem.click();
      setButtonState(button, "success");
    } catch (error) {
      closeMenu(rootMenu);
      throw error;
    } finally {
      window.setTimeout(() => button.isConnected && button.focus({ preventScroll: true }), 0);
    }
  };

  const addButton = (card) => {
    if (!card.querySelector("[data-memo-content]") || card.querySelector(BUTTON_SELECTOR)) return;

    const menuTrigger = findOwnMenuTrigger(card);
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
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;

      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      document.documentElement.classList.add(RUNNING_CLASS);
      try {
        await copyWithMemos(card, button);
      } catch (error) {
        console.error("[Memos 一键复制]", error);
        setButtonState(button, "error");
      } finally {
        document.documentElement.classList.remove(RUNNING_CLASS);
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });

    menuTrigger.before(button);
  };

  const scan = () => {
    scanFrame = 0;
    if (stopped) return;
    document.querySelectorAll("article").forEach(addButton);
  };

  const scheduleScan = () => {
    if (!scanFrame) scanFrame = requestAnimationFrame(scan);
  };

  observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  window[GLOBAL_KEY] = {
    destroy() {
      stopped = true;
      observer.disconnect();
      if (scanFrame) cancelAnimationFrame(scanFrame);
      document.documentElement.classList.remove(RUNNING_CLASS);
      document.querySelectorAll(BUTTON_SELECTOR).forEach((button) => button.remove());
      delete window[GLOBAL_KEY];
    },
  };
})();
