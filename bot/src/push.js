// Notificações (Web Push) para o app instalado no celular: criptografia RFC 8291 (aes128gcm) e
// identificação do remetente por VAPID (RFC 8292), tudo com WebCrypto, sem biblioteca.
// O par de chaves VAPID é criado na primeira vez e guardado em segredos/push, que só este bot lê.

const enc = new TextEncoder();
export const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const deB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const juntar = (...partes) => {
  const r = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) { r.set(p, i); i += p.length; }
  return r;
};

async function hkdf(salt, ikm, info, bytes) {
  const chave = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, chave, bytes * 8));
}

// Chaves VAPID: lê do banco ou cria (e grava) na primeira vez. Devolve { publica (b64url), privada (CryptoKey) }.
export async function chavesVapid(db) {
  let doc = await db.ler('segredos/push');
  if (!doc) {
    const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const dados = {
      privadaJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', par.privateKey)),
      publica: b64url(await crypto.subtle.exportKey('raw', par.publicKey)),
    };
    try {
      await db.gravar([{ criar: 'segredos/push', dados }]);
    } catch (e) {
      if (!e.jaExiste) throw e; // outra chamada criou ao mesmo tempo: usa a dela
    }
    doc = await db.ler('segredos/push');
  }
  const privada = await crypto.subtle.importKey('jwk', JSON.parse(doc.dados.privadaJwk),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { publica: doc.dados.publica, privada };
}

async function jwtVapid(endpoint, chaves, contato) {
  const corpo = `${b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.`
    + b64url(enc.encode(JSON.stringify({
      aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contato,
    })));
  const assinatura = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chaves.privada, enc.encode(corpo));
  return `${corpo}.${b64url(assinatura)}`;
}

// Cifra a mensagem para uma inscrição ({ endpoint, keys: { p256dh, auth } }), no formato aes128gcm.
export async function cifrar(inscricao, texto) {
  const uaPublica = deB64url(inscricao.keys.p256dh);
  const auth = deB64url(inscricao.keys.auth);
  const efemera = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', efemera.publicKey));
  const uaChave = await crypto.subtle.importKey('raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaChave }, efemera.privateKey, 256));

  const ikm = await hkdf(auth, segredo, juntar(enc.encode('WebPush: info\0'), uaPublica, asPublica), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const chave = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, chave,
    juntar(enc.encode(texto), new Uint8Array([2]))));
  const cabecalho = new Uint8Array(21);
  cabecalho.set(salt, 0);
  new DataView(cabecalho.buffer).setUint32(16, 4096);
  cabecalho[20] = asPublica.length;
  return juntar(cabecalho, asPublica, cifrado);
}

// Envia uma notificação. Devolve o status HTTP do serviço de push (201 = entregue ao serviço;
// 404/410 = inscrição que não vale mais e deve ser apagada).
export async function enviar(inscricao, mensagem, chaves, contato) {
  const r = await fetch(inscricao.endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `vapid t=${await jwtVapid(inscricao.endpoint, chaves, contato)}, k=${chaves.publica}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body: await cifrar(inscricao, JSON.stringify(mensagem)),
  });
  if (!r.ok) console.warn('Push recusado', r.status, await r.text().catch(() => ''));
  return r.status;
}
