"use client";

import { useEffect } from "react";

type WindowWithVConsole = Window & {
  __VCONSOLE__?: {
    destroy?: () => void;
  } | null;
};

const STORAGE_KEY = "rstudio:vconsole";

export function VConsoleBootstrap() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const currentWindow = window as WindowWithVConsole;
    const searchParams = new URLSearchParams(window.location.search);
    const forcedOn = searchParams.get("vconsole") === "1";
    const forcedOff = searchParams.get("vconsole") === "0";

    if (forcedOn) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else if (forcedOff) {
      window.localStorage.removeItem(STORAGE_KEY);
      currentWindow.__VCONSOLE__?.destroy?.();
      currentWindow.__VCONSOLE__ = null;
      return;
    }

    const persistedOn = window.localStorage.getItem(STORAGE_KEY) === "1";
    const shouldEnable = forcedOn || persistedOn;

    if (!shouldEnable || currentWindow.__VCONSOLE__) return;

    let cancelled = false;

    void import("vconsole").then(({ default: VConsole }) => {
      if (cancelled || currentWindow.__VCONSOLE__) return;
      currentWindow.__VCONSOLE__ = new VConsole();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
