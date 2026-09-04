export class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = new Map();
    this.dataset = {};
    this.paused = true;
    this.playCount = 0;
    this.pauseCount = 0;
    this.loadCount = 0;
    this.currentTime = 0;
    this.readyState = 0;
    this.src = "";
    this.rect = { x: 0, y: 0, width: 0, height: 0 };
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...elements) {
    for (const element of elements) {
      element.remove();
      element.parentNode = this;
      this.children.push(element);
    }
  }
  prepend(...elements) {
    for (const element of [...elements].reverse()) {
      element.remove();
      element.parentNode = this;
      this.children.unshift(element);
    }
  }
  get firstElementChild() { return this.children[0] ?? null; }
  getBoundingClientRect() { return this.rect; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((value) => value !== this);
    this.parentNode = null;
  }
  async decode() { this.decoded = true; }
  async play() { this.paused = false; this.playCount += 1; }
  pause() { this.paused = true; this.pauseCount += 1; }
  load() { this.loadCount += 1; }
  requestVideoFrameCallback(callback) { this.frameCallback = callback; return 1; }
  cancelVideoFrameCallback() { this.frameCallback = null; }
  emit(type) { this.dispatchEvent(new Event(type)); }
  emitFrame() { const callback = this.frameCallback; this.frameCallback = null; callback?.(0, {}); }
}

export class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.body = new FakeElement("body");
    this.created = [];
  }
  createElement(tagName) {
    const element = new FakeElement(tagName);
    this.created.push(element);
    return element;
  }
  setHidden(value) {
    this.hidden = value;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

export function createLedger() {
  const disposers = [];
  return {
    track(_kind, disposer) { disposers.push(disposer); },
    async cleanup() {
      for (const disposer of disposers.reverse()) await disposer();
      disposers.length = 0;
    },
  };
}
