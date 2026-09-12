import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';

/** Follow new output until the reader takes control; streaming never wins a gesture. */
export function useChatScroll(content: unknown, busy: boolean) {
  const feed = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const touchY = useRef<number | null>(null);
  const touching = useRef(false);
  const downward = useRef(false);
  const frame = useRef(0);
  const observer = useRef<ResizeObserver | null>(null);
  const [away, setAway] = useState(false);

  const pause = useCallback(() => {
    following.current = false;
    downward.current = false;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setAway(true);
  }, []);
  const atBottom = () => {
    const el = feed.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
  };
  const scrollToBottom = useCallback(() => {
    following.current = true;
    downward.current = false;
    setAway(false);
    const el = feed.current;
    if (el) {
      // No queued smooth animation may pull the reader back after a new gesture.
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
  }, []);
  const schedule = useCallback(() => {
    if (!following.current || touching.current || frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (following.current && !touching.current) scrollToBottom();
    });
  }, [scrollToBottom]);

  useLayoutEffect(schedule, [content, busy, schedule]);
  const attachFeed = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      feed.current = el;
      if (el) {
        observer.current = new ResizeObserver(schedule);
        observer.current.observe(el);
        schedule();
      }
    },
    [schedule],
  );
  useLayoutEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  const scrollProps: HTMLAttributes<HTMLDivElement> = {
    tabIndex: 0,
    'aria-label': 'История сообщений',
    onWheel: (event) => {
      if (event.deltaY < 0) pause();
      else if (event.deltaY > 0) {
        downward.current = true;
        if (atBottom()) scrollToBottom();
      }
    },
    onTouchStart: (event) => {
      touching.current = true;
      touchY.current = event.touches[0]?.clientY ?? null;
      pause();
    },
    onTouchMove: (event) => {
      const y = event.touches[0]?.clientY;
      if (y !== undefined && touchY.current !== null) {
        const delta = y - touchY.current;
        if (delta > 0) pause();
        else if (delta < 0) downward.current = true;
      }
      touchY.current = y ?? null;
    },
    onTouchEnd: () => {
      touching.current = false;
      touchY.current = null;
      if (downward.current && atBottom()) scrollToBottom();
    },
    onTouchCancel: () => {
      touching.current = false;
      touchY.current = null;
    },
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse') pause();
    },
    onKeyDown: (event) => {
      if ((event.target as HTMLElement).matches('input, textarea, select')) return;
      if (
        ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
        (event.key === ' ' && event.shiftKey)
      )
        pause();
      if (
        ['ArrowDown', 'PageDown', 'End'].includes(event.key) ||
        (event.key === ' ' && !event.shiftKey)
      )
        downward.current = true;
    },
    onScroll: (event) => {
      const top = event.currentTarget.scrollTop;
      // Only input handlers pause following. Reflow (e.g. clearing a tall draft)
      // can move scrollTop too and must not be mistaken for a reading gesture.
      if (!following.current && top > lastTop.current + 1) downward.current = true;
      lastTop.current = top;
      if (!following.current && !touching.current && downward.current && atBottom())
        scrollToBottom();
    },
  };
  return { feed: attachFeed, away, scrollProps, scrollToBottom };
}
