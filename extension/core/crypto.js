/**
 * Chroma Ad-Blocker - Local Crypto Utility
 * Obfuscates sensitive data saved to chrome.storage.local.
 */

'use strict';

const STATIC_SALT = 'chroma-proxy-salt-9876543210';
const STATIC_PASS = 'chroma-proxy-obfuscation-key-1337';

let _cachedKey = null;

async function getDerivedKey() {
  if (_cachedKey) return _cachedKey;

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(STATIC_PASS),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  
  _cachedKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(STATIC_SALT),
      iterations: 10000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  return _cachedKey;
}

export async function encryptAuth(username, password) {
  if (!username && !password) return null;
  const key = await getDerivedKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ username, password }));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return {
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(cipherBuffer))
  };
}

export async function decryptAuth(ivArray, cipherArray) {
  if (!ivArray || !cipherArray) return null;
  try {
    const key = await getDerivedKey();
    const iv = new Uint8Array(ivArray);
    const ciphertext = new Uint8Array(cipherArray);
    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(plainBuffer));
  } catch (err) {
    console.error('[Chroma Crypto] Decryption failed', err);
    return null;
  }
}
