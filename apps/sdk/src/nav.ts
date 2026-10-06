import { CUSTOM_TAGS, type NavPayloadShape } from '@cp/schema/tags';

type Emit = (tag: string, payload: unknown) => void;

export interface NavHooks {
  /** Current route template. */
  route(): string;
  /** Page is going away: send what is buffered now, synchronously. */
  onUnload(): void;
  /** Tab hidden: a good moment to flush (the page may never come back). */
  onHidden(): void;
}

/**
 * `cp.nav` events: `spa` when the path changes through the History API or back/forward, and
 * `unload` on pagehide (right before the final flush). dead_click treats both as a response.
 */
export function instrumentNavigation(win: Window, emit: Emit, hooks: NavHooks): () => void {
  let lastPath = win.location.pathname;
  const changed = () => {
    if (win.location.pathname === lastPath) return;
    lastPath = win.location.pathname;
    emit(CUSTOM_TAGS.nav, { reason: 'spa', route: hooks.route() } satisfies NavPayloadShape);
  };

  const history = win.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
    originalPush.apply(this, args);
    changed();
  };
  history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
    originalReplace.apply(this, args);
    changed();
  };

  const onPopState = () => changed();
  const onPageHide = () => {
    emit(CUSTOM_TAGS.nav, { reason: 'unload', route: hooks.route() } satisfies NavPayloadShape);
    hooks.onUnload();
  };
  const onVisibility = () => {
    if (win.document.visibilityState === 'hidden') hooks.onHidden();
  };
  win.addEventListener('popstate', onPopState);
  win.addEventListener('pagehide', onPageHide);
  win.document.addEventListener('visibilitychange', onVisibility);

  return () => {
    history.pushState = originalPush;
    history.replaceState = originalReplace;
    win.removeEventListener('popstate', onPopState);
    win.removeEventListener('pagehide', onPageHide);
    win.document.removeEventListener('visibilitychange', onVisibility);
  };
}
