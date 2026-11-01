/* Local-only storage. Business data never leaves this browser. */
(() => {
  'use strict';
  const key = 'codex.cross-border-product-map';
  window.projectState = Object.freeze({
    read() {
      try {
        const value = window.localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
      } catch (error) {
        console.warn('无法读取本地保存的数据。', error);
        return null;
      }
    },
    write(state) {
      window.localStorage.setItem(key, JSON.stringify(state));
    },
  });
})();
