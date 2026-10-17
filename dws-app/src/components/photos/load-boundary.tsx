"use client";

import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { toast } from "sonner";
import { reloadIfRedeployed } from "@/lib/photos/redeploy";

// Parts of the photo app download on their own, after the page is up (the
// viewer, the "+" pop-ups, Download, Arrange). Each loads through
// `retryableLoader` and renders inside a <LoadBoundary>. Such a download can
// fail: a phone on a weak signal, or a tab opened before a deploy asking for a
// file name the deploy removed. Without a boundary, React hands the failure to
// Next's root, which swaps the whole app for "Application error" and loses the
// upload tray's queue with it.
// <LoadBoundary> keeps the failure to the part that failed, and
// `retryableLoader` lets the next open of that part try the download again.
// After a deploy, trying again cannot help (the file is gone for good), so
// `reloadIfRedeployed` moves the tab onto the new build instead.

export const LOAD_FAILED_MESSAGE =
  "Could not load part of the page. Check your connection and try again.";
const LOAD_FAILED_TOAST_ID = "photos-load-failed";

interface LoadBoundaryProps {
  children: ReactNode;
  /** Told of the failure, so the parent can close what failed to open. */
  onError?(error: unknown): void;
  /** Toast the failure (default). Off for a download nobody asked for yet. */
  notify?: boolean;
}

/**
 * Renders nothing in place of a part whose code failed to load, and says so
 * once. The parent unmounts it (onError) and mounts a fresh one on the next
 * open, which tries again.
 */
export class LoadBoundary extends Component<LoadBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // One fixed id: two parts failing together show one toast.
    if (this.props.notify !== false) {
      toast.error(LOAD_FAILED_MESSAGE, { id: LOAD_FAILED_TOAST_ID });
      // Only for a part someone asked for: a download nobody is waiting on
      // never reloads the page under them.
      void reloadIfRedeployed(error);
    }
    this.props.onError?.(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * A next/dynamic loader that can be tried again. next/dynamic hands its loader
 * to React.lazy, which remembers a failed import for good: every later mount
 * would throw the same error without asking the network again. So the loader
 * never fails. When the download does, it resolves to a stand-in that fetches
 * the code again each time it mounts (webpack forgets a failed file, so this
 * is a real new request), draws the part once it arrives, and throws to the
 * nearest <LoadBoundary> if that try fails as well.
 */
export function retryableLoader<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>
): () => Promise<{ default: ComponentType<P> }> {
  let loaded: ComponentType<P> | null = null;
  function RetryLoad(props: P) {
    const [state, setState] = useState<{ part: ComponentType<P> | null; error?: unknown }>(() => ({
      part: loaded,
    }));
    useEffect(() => {
      if (state.part) return;
      let live = true;
      load().then(
        (module) => {
          loaded = module.default;
          if (live) setState({ part: module.default });
        },
        (error: unknown) => {
          if (live) setState({ part: null, error: error ?? new Error("load failed") });
        }
      );
      return () => {
        live = false;
      };
      // Once per mount: a remount is the next try.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    if (state.error !== undefined) throw state.error;
    const Part = state.part;
    return Part ? <Part {...props} /> : null;
  }
  return () =>
    load().then(
      (module) => module,
      () => ({ default: RetryLoad })
    );
}
