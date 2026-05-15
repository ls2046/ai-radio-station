"use client";

import { useEffect } from "react";

const KEYBOARD_VISUAL_VIEWPORT_THRESHOLD = 80;
const KEYBOARD_SYNC_DELAYS = [80, 220, 420];

function isTextInputElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || target.isContentEditable;
}

export function useMobileViewportLayout() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.documentElement;
    let frameId = 0;
    let keyboardOpenState = false;
    let lastTouchY = 0;
    let stableAppHeight = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    const timeoutIds: number[] = [];

    const findScrollableParent = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return document.scrollingElement;

      let element: HTMLElement | null = target;
      while (element && element !== document.body) {
        const style = window.getComputedStyle(element);
        const canScrollY = /(auto|scroll)/.test(style.overflowY);
        if (canScrollY && element.scrollHeight > element.clientHeight + 1) {
          return element;
        }
        element = element.parentElement;
      }

      return document.scrollingElement;
    };

    const syncViewportVariables = () => {
      const isStandalone = window.matchMedia?.("(display-mode: standalone)").matches
        || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
      const innerHeight = window.innerHeight;
      const visualViewportHeight = window.visualViewport?.height || innerHeight;
      const keyboardFocused = isTextInputElement(document.activeElement);
      const viewportHeight = Math.max(innerHeight, document.documentElement.clientHeight || 0);

      if (!keyboardFocused) {
        stableAppHeight = viewportHeight;
      }

      const keyboardOffset = keyboardFocused
        ? Math.max(0, stableAppHeight - visualViewportHeight)
        : 0;
      const keyboardOpen = keyboardFocused && keyboardOffset > KEYBOARD_VISUAL_VIEWPORT_THRESHOLD;
      const appHeight = isStandalone || keyboardFocused ? stableAppHeight : visualViewportHeight;
      const visibleHeight = keyboardOpen ? Math.min(visualViewportHeight, appHeight) : appHeight;

      keyboardOpenState = keyboardOpen;
      root.style.setProperty("--app-height", `${Math.round(appHeight)}px`);
      root.style.setProperty("--visible-height", `${Math.round(visibleHeight)}px`);
      root.style.setProperty("--keyboard-offset", `${Math.round(keyboardOffset)}px`);
      root.style.setProperty("--keyboard-open", keyboardOpen ? "1" : "0");
      root.dataset.keyboardOpen = keyboardOpen ? "true" : "false";
      root.dataset.standaloneMode = isStandalone ? "true" : "false";
    };

    const scheduleViewportSync = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        syncViewportVariables();
      });
    };

    const syncAfterKeyboardToggle = () => {
      scheduleViewportSync();
      KEYBOARD_SYNC_DELAYS.forEach((delay) => {
        timeoutIds.push(window.setTimeout(scheduleViewportSync, delay));
      });
    };

    const keepFocusedInputVisible = () => {
      const activeElement = document.activeElement;
      if (!(activeElement instanceof HTMLElement) || !isTextInputElement(activeElement)) return;

      activeElement.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth"
      });
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isTextInputElement(event.target)) return;
      syncAfterKeyboardToggle();
      [120, 320, 520].forEach((delay) => {
        timeoutIds.push(window.setTimeout(keepFocusedInputVisible, delay));
      });
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!isTextInputElement(event.target)) return;
      syncAfterKeyboardToggle();
    };

    const handleTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY || 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!keyboardOpenState || event.touches.length !== 1) return;

      const currentY = event.touches[0]?.clientY || 0;
      const deltaY = currentY - lastTouchY;
      lastTouchY = currentY;

      const scrollable = findScrollableParent(event.target);
      if (!scrollable) {
        event.preventDefault();
        return;
      }

      const scrollTop = scrollable.scrollTop;
      const atTop = scrollTop <= 0;
      const atBottom = scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1;

      if ((deltaY > 0 && atTop) || (deltaY < 0 && atBottom)) {
        event.preventDefault();
      }
    };

    scheduleViewportSync();
    window.addEventListener("resize", scheduleViewportSync);
    window.addEventListener("orientationchange", scheduleViewportSync);
    window.visualViewport?.addEventListener("resize", scheduleViewportSync);
    window.visualViewport?.addEventListener("scroll", scheduleViewportSync);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
    document.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      timeoutIds.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("resize", scheduleViewportSync);
      window.removeEventListener("orientationchange", scheduleViewportSync);
      window.visualViewport?.removeEventListener("resize", scheduleViewportSync);
      window.visualViewport?.removeEventListener("scroll", scheduleViewportSync);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("touchstart", handleTouchStart, { capture: true });
      document.removeEventListener("touchmove", handleTouchMove, { capture: true });
      delete root.dataset.keyboardOpen;
      delete root.dataset.standaloneMode;
    };
  }, []);
}
