/**
 * Public update-signing trust anchor.
 *
 * The matching private key must stay outside the repository. Package builds read it
 * from secrets/chroma-update-signing-private-key.jwk or an explicit environment path.
 */

'use strict';

export const UPDATE_TRUST = Object.freeze({
  schema: 'chroma-update-manifest-v1',
  signatureAlgorithm: 'ECDSA_P256_SHA256',
  keyId: 'chroma-update-signing-2026-06',
  publicKeyJwk: Object.freeze({
    kty: 'EC',
    crv: 'P-256',
    x: 'U6qevOY9E1RnP52PAgOplJNFyiRjdhyEPJOVG1NLOz8',
    y: 'pEZlDET9BmbVlq506_en3hHlBxBU4INolcG8IbS4I2w',
    key_ops: ['verify'],
    ext: true
  })
});
