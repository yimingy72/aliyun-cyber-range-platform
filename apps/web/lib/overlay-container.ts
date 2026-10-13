// Native fullscreen hides portals outside the fullscreen element.
export function overlayContainer() {
  return typeof document === 'undefined' ? undefined : document.fullscreenElement ?? undefined;
}
