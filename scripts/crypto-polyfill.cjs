// Node.js 24+ polyfill for Vite 5.4.x crypto.getRandomValues
const nodeCrypto = require('crypto')
if (typeof nodeCrypto.getRandomValues !== 'function') {
  // Use webcrypto.getRandomValues (available in Node.js 20+)
  const webcrypto = nodeCrypto.webcrypto
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    nodeCrypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto)
  } else {
    // Fallback: use randomFillSync to implement getRandomValues
    nodeCrypto.getRandomValues = (array) => {
      if (array instanceof Uint8Array) {
        nodeCrypto.randomFillSync(array)
      } else if (array instanceof Uint16Array) {
        nodeCrypto.randomFillSync(new Uint8Array(array.buffer))
      } else if (array instanceof Uint32Array) {
        nodeCrypto.randomFillSync(new Uint8Array(array.buffer))
      }
      return array
    }
  }
}

// Also polyfill globalThis.crypto if missing
if (!globalThis.crypto) {
  globalThis.crypto = nodeCrypto.webcrypto || {
    getRandomValues: nodeCrypto.getRandomValues,
    randomUUID: () => nodeCrypto.randomUUID(),
  }
}
