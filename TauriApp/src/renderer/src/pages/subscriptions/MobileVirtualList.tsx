import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

const defaultOverscanCount = 6;

function resolveScrollParent(element: HTMLElement | null): HTMLElement | Window {
  let current = element?.parentElement ?? null;
  while (current) {
    if (current.classList.contains("content-scroll-view")) {
      return current;
    }
    const style = window.getComputedStyle(current);
    if (style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

interface ViewportState {
  containerTop: number;
  scrollTop: number;
  viewportHeight: number;
}

interface MobileVirtualListProps<T> {
  items: T[];
  itemHeight: number;
  itemGap?: number;
  overscanCount?: number;
  className?: string;
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
}

export function MobileVirtualList<T>({
  items,
  itemHeight,
  itemGap = 0,
  overscanCount = defaultOverscanCount,
  className,
  getItemKey,
  renderItem,
}: MobileVirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollParentRef = useRef<HTMLElement | Window | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    containerTop: 0,
    scrollTop: 0,
    viewportHeight: 0,
  });
  const itemStride = Math.max(1, itemHeight + itemGap);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    scrollParentRef.current = resolveScrollParent(container);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const scrollParent = scrollParentRef.current;
    if (!container || !scrollParent) {
      return;
    }

    let rafId = 0;
    const updateViewport = () => {
      window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        const currentContainer = containerRef.current;
        const currentScrollParent = scrollParentRef.current;
        if (!currentContainer || !currentScrollParent) {
          return;
        }
        if (currentScrollParent === window) {
          const scrollTop =
            window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
          const viewportHeight = window.innerHeight;
          const containerRect = currentContainer.getBoundingClientRect();
          const containerTop = containerRect.top + scrollTop;
          setViewport((previous) => {
            if (
              previous.containerTop === containerTop &&
              previous.scrollTop === scrollTop &&
              previous.viewportHeight === viewportHeight
            ) {
              return previous;
            }
            return {
              containerTop,
              scrollTop,
              viewportHeight,
            };
          });
          return;
        }

        const elementScrollParent = currentScrollParent as HTMLElement;
        const parentRect = elementScrollParent.getBoundingClientRect();
        const containerRect = currentContainer.getBoundingClientRect();
        const scrollTop = elementScrollParent.scrollTop;
        const viewportHeight = elementScrollParent.clientHeight;
        const containerTop = containerRect.top - parentRect.top + scrollTop;
        setViewport((previous) => {
          if (
            previous.containerTop === containerTop &&
            previous.scrollTop === scrollTop &&
            previous.viewportHeight === viewportHeight
          ) {
            return previous;
          }
          return {
            containerTop,
            scrollTop,
            viewportHeight,
          };
        });
      });
    };

    updateViewport();
    const onScroll = () => {
      updateViewport();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updateViewport();
          });
    resizeObserver?.observe(container);
    if (scrollParent !== window) {
      resizeObserver?.observe(scrollParent as HTMLElement);
    }
    const scrollTarget = scrollParent === window ? window : scrollParent;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      scrollTarget.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [itemStride, items.length]);

  const visibleRange = useMemo(() => {
    if (items.length === 0) {
      return {
        start: 0,
        end: 0,
      };
    }
    if (viewport.viewportHeight <= 0) {
      const fallbackEnd = Math.min(items.length, overscanCount * 3);
      return {
        start: 0,
        end: Math.max(1, fallbackEnd),
      };
    }
    const viewportTop = viewport.scrollTop;
    const viewportBottom = viewport.scrollTop + viewport.viewportHeight;
    const relativeTop = Math.max(0, viewportTop - viewport.containerTop);
    const relativeBottom = Math.max(0, viewportBottom - viewport.containerTop);
    const start = Math.max(0, Math.floor(relativeTop / itemStride) - overscanCount);
    const end = Math.min(
      items.length,
      Math.max(start + 1, Math.ceil(relativeBottom / itemStride) + overscanCount),
    );
    return {
      start,
      end,
    };
  }, [itemStride, items.length, overscanCount, viewport]);

  const totalHeight = items.length > 0 ? items.length * itemStride - itemGap : 0;

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: "relative",
        minHeight: totalHeight,
      }}
    >
      {items.slice(visibleRange.start, visibleRange.end).map((item, visibleIndex) => {
        const index = visibleRange.start + visibleIndex;
        return (
          <div
            key={getItemKey(item, index)}
            className="mobile-virtual-list-item"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: index * itemStride,
              height: itemStride,
              paddingBottom: itemGap,
              boxSizing: "border-box",
            }}
          >
            {renderItem(item, index)}
          </div>
        );
      })}
    </div>
  );
}
