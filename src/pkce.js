// PKCE (RFC 7636) helpers used for the Lichess OAuth2 login flow.
// Lichess is a "public client" - no client secret, PKCE with S256 is mandatory.

function base64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Random URL-safe string, used for both the PKCE code_verifier and the OAuth "state" param.
export function randomString(byteLength = 48) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

// S256 code_challenge derived from a code_verifier.
export async function codeChallengeS256(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(digest);
}
