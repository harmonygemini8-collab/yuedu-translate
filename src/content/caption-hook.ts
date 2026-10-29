/**
 * Runs in the page's own JavaScript world, where the player's network calls can be seen; the
 * extension's content script cannot see them from its isolated one. It does one thing: when the
 * player downloads a caption file, it hands a copy of the response to the content script with
 * `postMessage`. Nothing is sent anywhere and no other request is looked at.
 */
(() => {
  const win = window as unknown as Record<string, unknown>;
  if (win.__yilinCaptionHook) return;
  win.__yilinCaptionHook = true;

  const report = (url: string, body: string) => {
    try {
      const target = new URL(url, location.href);
      if (target.pathname !== '/api/timedtext') return;
      const param = (name: string) => target.searchParams.get(name) ?? '';
      window.postMessage(
        { source: 'yilin-captions', kind: param('kind'), lang: param('lang'), tlang: param('tlang'), videoId: param('v'), body },
        location.origin,
      );
    } catch {
      // A malformed address is not ours to report.
    }
  };
  const wanted = (url: string) => url.includes('/api/timedtext');

  const originalFetch = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const promise = originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (wanted(url)) promise.then((response) => response.clone().text()).then((body) => report(url, body)).catch(() => {});
    } catch {
      // The page's request is never held up by this.
    }
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const urls = new WeakMap<XMLHttpRequest, string>();
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    urls.set(this, String(url));
    return (originalOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = urls.get(this);
    if (url && wanted(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') report(url, this.responseText);
        } catch {
          // Not readable as text: not a caption file we can use.
        }
      });
    }
    return originalSend.call(this, body);
  };
})();
