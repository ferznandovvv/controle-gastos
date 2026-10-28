// Testa o Worker de ponta a ponta com Google, Firestore e Telegram simulados (fetch falso).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { segredoWebhook, donoDaChave, categoriaAprendida, avisoDeLimite } from './index.js';
import { paraCampos } from './firestore.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
    project_id: 'proj', private_key_id: 'k1', client_email: 'bot@proj.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }),
  TELEGRAM_TOKEN: '123:abc', TELEGRAM_USUARIOS_PERMITIDOS: '111, 222',
  ATALHO_CHAVES: 'Fernando:chave-f, Esposa:chave-e',
};
const RAIZ = 'projects/proj/databases/(default)/documents';

let banco; let commits; let respostas; let destinos; let pushes; let pendentes;
const ctx = { waitUntil: (p) => pendentes.push(p) };
const docApi = (caminho) => ({ name: `${RAIZ}/${caminho}`, fields: paraCampos(banco[caminho]) });

beforeEach(() => {
  banco = {}; commits = []; respostas = []; destinos = []; pushes = []; pendentes = [];
  globalThis.fetch = async (url, op = {}) => {
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.startsWith('https://oauth2.googleapis.com')) return json({ access_token: 'acesso', expires_in: 3600 });
    if (url.startsWith('https://push.example/')) {
      pushes.push({ url, headers: op.headers, corpo: new Uint8Array(op.body) });
      return new Response('', { status: url.includes('morta') ? 410 : 201 });
    }
    if (url.startsWith('https://api.telegram.org/bot123:abc/sendMessage')) {
      respostas.push(JSON.parse(op.body).text);
      destinos.push(JSON.parse(op.body).chat_id);
      return json({});
    }
    assert.equal(op.headers.Authorization, 'Bearer acesso');
    const caminho = url.split('/documents')[1];
    if (caminho === ':runQuery') {
      const q = JSON.parse(op.body).structuredQuery;
      const filtros = q.where ? q.where.compositeFilter?.filters || [q.where] : [];
      const valor = (v) => v.stringValue ?? v.booleanValue ?? v.arrayValue?.values.map((x) => x.stringValue);
      return json(Object.keys(banco)
        .filter((c) => c.startsWith(`${q.from[0].collectionId}/`))
        .filter((c) => filtros.every(({ fieldFilter: f }) => {
          const v = valor(f.value);
          return f.op === 'IN' ? v.includes(banco[c][f.field.fieldPath]) : banco[c][f.field.fieldPath] === v;
        }))
        .map((c) => ({ document: docApi(c) })));
    }
    if (caminho === ':commit') {
      const { writes } = JSON.parse(op.body);
      commits.push(writes);
      for (const w of writes) {
        if (w.delete) { delete banco[w.delete.slice(RAIZ.length + 1)]; continue; }
        const c = w.update.name.slice(RAIZ.length + 1);
        if (w.currentDocument?.exists === false && banco[c]) return json({ error: { status: 'ALREADY_EXISTS' } }, 409);
        const { deCampos } = await import('./firestore.js');
        banco[c] = { ...(w.updateMask ? banco[c] : {}), ...deCampos(w.update.fields) };
        for (const t of w.updateTransforms || []) {
          if (t.setToServerValue) banco[c][t.fieldPath] = new Date();
          if (t.appendMissingElements) {
            const novos = t.appendMissingElements.values.map((v) => v.stringValue);
            banco[c][t.fieldPath] = [...new Set([...(banco[c][t.fieldPath] || []), ...novos])];
          }
        }
      }
      return json({});
    }
    const c = caminho.slice(1);
    return banco[c] ? json(docApi(c)) : json({}, 404);
  };
});

let proximoId = 1;
async function mensagem(texto, { de = 111, chat = de, tipo = 'private', id = proximoId++, segredo } = {}) {
  const corpo = JSON.stringify({ update_id: id, message: { message_id: id, from: { id: de }, chat: { id: chat, type: tipo }, text: texto } });
  const s = segredo ?? await segredoWebhook(env.TELEGRAM_TOKEN);
  return worker.fetch(new Request('https://bot.example/', { method: 'POST', body: corpo, headers: { 'x-telegram-bot-api-secret-token': s } }), env, ctx);
}

test('recusa chamada sem o segredo do Telegram', async () => {
  const r = await mensagem('45 mercado', { segredo: 'errado' });
  assert.equal(r.status, 401);
  assert.equal(commits.length, 0);
  assert.equal(respostas.length, 0);
});

test('lança gasto, ignora reenvio e soma o total', async () => {
  banco['lancamentos/antigo'] = { tipo: 'gasto', valor: 10, mes: new Date().toISOString().slice(0, 7), categoria: 'Outros' };
  await mensagem('45,90 mercado', { id: 500 });
  await mensagem('45,90 mercado', { id: 500 });
  const doc = banco['lancamentos/tg_111_500'];
  assert.equal(doc.valor, 45.9);
  assert.equal(doc.categoria, 'Mercado');
  assert.equal(doc.criadoPor, 'telegram:111');
  assert.equal(doc.origem, 'telegram');
  assert.ok(doc.criadoEm instanceof Date);
  assert.equal(respostas.length, 1, 'o reenvio não responde de novo');
  assert.match(respostas[0], /R\$\s45,90 em \*Mercado\*/);
  assert.deepEqual(destinos, [111]);
});

test('usuário não autorizado recebe o próprio ID e nada é gravado', async () => {
  await mensagem('45 mercado', { de: 999 });
  assert.equal(commits.length, 0);
  assert.match(respostas[0], /Seu ID do Telegram é 999/);
});

test('em grupo, não autorizado é ignorado em silêncio', async () => {
  await mensagem('45 mercado', { de: 999, chat: -100, tipo: 'group' });
  assert.equal(respostas.length, 0);
});

test('autorizado lança pelo grupo do casal e a resposta vai para o grupo', async () => {
  await mensagem('12 pão', { de: 222, chat: -100, tipo: 'group', id: 7 });
  assert.equal(banco['lancamentos/tg_n100_7'].criadoPor, 'telegram:222');
  assert.deepEqual(destinos, [-100]);
});

test('conta da casa é lançada como gasto comum, sem mexer nos fixos', async () => {
  banco['fixos/f1'] = { descricao: 'Energia', variavel: true, valor: 150, dia: 10, categoria: 'Contas da casa', gerados: [] };
  await mensagem('luz 187,40', { id: 9 });
  const lanc = banco['lancamentos/tg_111_9'];
  assert.equal(lanc.valor, 187.4);
  assert.equal(lanc.categoria, 'Contas da casa');
  assert.equal(lanc.fixoId, undefined);
  assert.equal(banco['fixos/f1'].valor, 150);
});

test('desfazer apaga o último gasto da pessoa', async () => {
  await mensagem('10 pão', { id: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await mensagem('20 uber', { id: 2 });
  await mensagem('/desfazer');
  assert.ok(banco['lancamentos/tg_111_1']);
  assert.equal(banco['lancamentos/tg_111_2'], undefined);
  assert.match(respostas.at(-1), /Apaguei R\$\s20,00 em Transporte/);
});

test('total do mês, também como comando /total@bot', async () => {
  await mensagem('10 pão');
  await mensagem('/total@gastos_bot');
  assert.match(respostas.at(-1), /\*R\$\s10,00\*/);
});

test('/start mostra a ajuda', async () => {
  await mensagem('/start');
  assert.match(respostas[0], /Mande o valor/);
});

test('se a formatação quebrar, reenvia sem negrito', async () => {
  const original = globalThis.fetch;
  const enviados = [];
  globalThis.fetch = async (url, op) => {
    if (url.includes('api.telegram.org')) {
      const b = JSON.parse(op.body);
      enviados.push(b.parse_mode || 'texto');
      return new Response('{}', { status: b.parse_mode ? 400 : 200 });
    }
    return original(url, op);
  };
  await mensagem('oi');
  assert.deepEqual(enviados, ['Markdown', 'texto']);
});

function atalho(corpo, chave = 'chave-f', tipo = 'application/json') {
  return worker.fetch(new Request('https://bot.example/atalho', {
    method: 'POST', body: corpo, headers: { 'Content-Type': tipo, ...(chave && { Authorization: `Bearer ${chave}` }) },
  }), env, ctx);
}

test('donoDaChave identifica quem usa o Atalho', () => {
  assert.equal(donoDaChave(env.ATALHO_CHAVES, 'Bearer chave-e'), 'esposa');
  assert.equal(donoDaChave(env.ATALHO_CHAVES, 'chave-f'), 'fernando');
  assert.equal(donoDaChave(env.ATALHO_CHAVES, 'Bearer outra'), null);
  assert.equal(donoDaChave(env.ATALHO_CHAVES, ''), null);
  assert.equal(donoDaChave('', 'Bearer x'), null);
});

test('Atalho lança o gasto e devolve a confirmação em texto puro', async () => {
  const r = await atalho(JSON.stringify({ texto: '45,90 mercado' }));
  assert.equal(r.status, 200);
  const corpo = await r.text();
  assert.match(corpo, /R\$\s45,90 em Mercado/);
  assert.doesNotMatch(corpo, /\*/);
  const [caminho, doc] = Object.entries(banco).find(([c]) => c.startsWith('lancamentos/at_'));
  assert.ok(caminho);
  assert.equal(doc.criadoPor, 'atalho:fernando');
  assert.equal(doc.origem, 'atalho');
  assert.equal(respostas.length, 0, 'não manda nada para o Telegram');
});

test('Atalho aceita texto simples no corpo', async () => {
  const r = await atalho('20 uber', 'chave-e', 'text/plain');
  assert.match(await r.text(), /Transporte/);
  assert.equal(Object.values(banco)[0].criadoPor, 'atalho:esposa');
});

test('Atalho recusa chave errada ou ausente', async () => {
  assert.equal((await atalho('{"texto":"10 pão"}', 'errada')).status, 401);
  assert.equal((await atalho('{"texto":"10 pão"}', null)).status, 401);
  assert.equal(commits.length, 0);
});

test('Atalho: desfazer apaga só o último da mesma pessoa', async () => {
  await atalho('{"texto":"10 pão"}', 'chave-f');
  await new Promise((r) => setTimeout(r, 5));
  await atalho('{"texto":"30 farmácia"}', 'chave-e');
  const r = await atalho('{"texto":"desfazer"}', 'chave-f');
  assert.match(await r.text(), /Apaguei R\$\s10,00/);
  const lancs = Object.entries(banco).filter(([c]) => c.startsWith('lancamentos/'));
  assert.equal(lancs.length, 1);
  assert.equal(lancs[0][1].criadoPor, 'atalho:esposa');
});

test('Atalho sem valor explica como usar', async () => {
  const r = await atalho('{"texto":"mercado"}');
  assert.match(await r.text(), /Não encontrei o valor/);
});

test('Atalho por GET, com a chave no endereço', async () => {
  const r = await worker.fetch(new Request('https://bot.example/atalho/chave-e?texto=ontem%2012%2C50%20padaria'), env, ctx);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /R\$\s12,50 em Mercado · Padaria \(ontem\)/);
  assert.equal(Object.values(banco)[0].criadoPor, 'atalho:esposa');
  const ruim = await worker.fetch(new Request('https://bot.example/atalho/errada?texto=10'), env, ctx);
  assert.equal(ruim.status, 401);
});

test('total ignora lançamento de fixo com data futura, como o app', async () => {
  const mes = new Date().toISOString().slice(0, 7);
  banco['lancamentos/fixo_futuro'] = { tipo: 'gasto', valor: 2000, mes, data: '2999-12-31', fixoId: 'x', categoria: 'Moradia' };
  banco['lancamentos/fixo_passado'] = { tipo: 'gasto', valor: 30, mes, data: '2000-01-01', fixoId: 'y', categoria: 'Assinaturas' };
  await mensagem('total');
  assert.match(respostas.at(-1), /\*R\$\s30,00\*/);
});

test('Atalho responde com aviso quando o banco não responde, em vez de ficar carregando', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op) => {
    if (url.includes('firestore.googleapis.com')) {
      return new Promise((_, rejeitar) => op.signal.addEventListener('abort', () => rejeitar(op.signal.reason)));
    }
    return original(url, op);
  };
  const real = AbortSignal.timeout;
  // O timer do AbortSignal.timeout do Node não segura o processo vivo; aqui um comum, de 50 ms.
  AbortSignal.timeout = () => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('tempo esgotado', 'TimeoutError')), 50);
    return c.signal;
  };
  try {
    const r = await worker.fetch(new Request('https://bot.example/atalho/chave-f', { method: 'POST', body: '18,99 marmita ontem' }), env, ctx);
    assert.equal(r.status, 500);
    assert.match(await r.text(), /Não consegui lançar agora/);
  } finally {
    AbortSignal.timeout = real;
  }
});

test('marmita cai em Restaurante', async () => {
  const r = await worker.fetch(new Request('https://bot.example/atalho/chave-f', { method: 'POST', body: '18,99 marmita ontem' }), env, ctx);
  assert.match(await r.text(), /R\$\s18,99 em Restaurante · Marmita \(ontem\)/);
});

test('compra parcelada pelo Atalho: uma parcela por mês e desfazer apaga todas', async () => {
  const r = await worker.fetch(new Request('https://bot.example/atalho/chave-f', { method: 'POST', body: '100 cadeira 3x' }), env, ctx);
  const texto = await r.text();
  assert.match(texto, /R\$\s100,00 em 3x de R\$\s33,33 em Outros · Cadeira/);
  assert.match(texto, /Última parcela em/);
  const parcelas = Object.entries(banco).filter(([c]) => c.startsWith('lancamentos/')).map(([, d]) => d).sort((a, b) => a.parcela - b.parcela);
  assert.deepEqual(parcelas.map((p) => p.valor), [33.34, 33.33, 33.33]);
  assert.deepEqual(parcelas.map((p) => `${p.parcela}/${p.parcelas}`), ['1/3', '2/3', '3/3']);
  assert.equal(new Set(parcelas.map((p) => p.mes)).size, 3, 'cada parcela em um mês');
  assert.equal(new Set(parcelas.map((p) => p.parcelaId)).size, 1);
  assert.match(texto, /Total de \S+: R\$\s33,34/, 'o mês só soma a 1ª parcela');
  const d = await worker.fetch(new Request('https://bot.example/atalho/chave-f', { method: 'POST', body: 'desfazer' }), env, ctx);
  assert.match(await d.text(), /Apaguei R\$\s100,00 em 3x/);
  assert.equal(Object.keys(banco).filter((c) => c.startsWith('lancamentos/')).length, 0);
  const lixo = Object.entries(banco).filter(([c]) => c.startsWith('lixeira/'));
  assert.equal(lixo.length, 3, 'as 3 parcelas vão para a lixeira');
  assert.ok(lixo.every(([, d]) => d.apagadoEm instanceof Date && d.parcelaId && d.apagadoPor === 'atalho:fernando'));
});

const atalhoTexto = async (texto, chave = 'chave-f') => (await worker.fetch(
  new Request(`https://bot.example/atalho/${chave}`, { method: 'POST', body: texto }), env, ctx)).text();

test('categoria corrigida no app vale para o Atalho', async () => {
  assert.equal(categoriaAprendida('Marmita do trabalho', { marmita: 'Restaurante' }, ['Restaurante']), 'Restaurante');
  assert.equal(categoriaAprendida('Marmita', { marmita: 'Apagada' }, ['Restaurante']), null, 'categoria que não existe mais é ignorada');
  banco['config/aprendizado'] = { mapa: { 'pao de queijo': 'Mercado', xyz: 'Lazer' } };
  assert.match(await atalhoTexto('12 pão de queijo'), /em Mercado/);
  assert.match(await atalhoTexto('30 xyz da loja'), /em Lazer/);
  assert.match(await atalhoTexto('20 uber'), /em Transporte/, 'sem aprendizado, continua pelas palavras-chave');
});

test('aviso de limite na resposta, a partir de 80%', async () => {
  assert.equal(avisoDeLimite('Mercado', [{ categoria: 'Mercado', valor: 100 }], 500), '');
  assert.equal(avisoDeLimite('Mercado', [{ categoria: 'Mercado', valor: 100 }], 0), '');
  banco['config/orcamentos'] = { limites: { Mercado: 100 } };
  assert.doesNotMatch(await atalhoTexto('70 mercado'), /limite/);
  assert.match(await atalhoTexto('15 mercado'), /⚠️ Mercado: faltam R\$\s15,00 para o limite de R\$\s100,00/);
  assert.match(await atalhoTexto('30 mercado'), /🚨 Mercado passou R\$\s15,00 do limite/);
  assert.doesNotMatch(await atalhoTexto('500 uber'), /limite/, 'categoria sem limite não avisa');
});

test('aviso de limite vem logo na 2ª linha da resposta', async () => {
  banco['config/orcamentos'] = { limites: { Lazer: 10 } };
  const linhas = (await atalhoTexto('50 cinema')).split('\n');
  assert.match(linhas[1], /🚨 Lazer passou/);
});

test('categoria criada pelo nome vence o que foi aprendido antes', async () => {
  banco['config/geral'] = { catGasto: ['Mercado', 'Restaurante', 'Marmita', 'Outros'] };
  banco['config/aprendizado'] = { mapa: { marmita: 'Restaurante' } };
  assert.match(await atalhoTexto('18,99 marmita'), /em Marmita/);
  assert.match(await atalhoTexto('25 marmita do trabalho'), /em Marmita/);
  banco['config/aprendizado'] = { mapa: { quentinha: 'Marmita' } };
  assert.match(await atalhoTexto('20 quentinha'), /em Marmita/, 'aprendido ainda vence a palavra-chave');
});

// ---------- notificações ----------
// "Celular" inscrito: par ECDH e segredo de autenticação, como o navegador cria.
async function aparelho(nome, email, endpoint) {
  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const id = endpoint.split('/').pop();
  banco[`inscricoes/${id}`] = {
    endpoint, nome, email,
    keys: { p256dh: b64(await crypto.subtle.exportKey('raw', par.publicKey)), auth: b64(auth) },
  };
  return { endpoint, par, auth };
}
// Decifra como o celular faria (RFC 8291) e devolve o JSON da mensagem.
async function decifrar(ap, corpo) {
  const salt = corpo.slice(0, 16);
  const idlen = corpo[20];
  const asPub = corpo.slice(21, 21 + idlen);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ap.par.publicKey));
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ap.par.privateKey, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const ikm = await hk(ap.auth, segredo, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const claro = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce },
    await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), corpo.slice(21 + idlen)));
  assert.equal(claro.at(-1), 2, 'delimitador do último registro');
  return JSON.parse(new TextDecoder().decode(claro.slice(0, -1)));
}
const esperarAvisos = () => Promise.all(pendentes);
const espacos = (t) => t.replace(/\s/g, ' '); // o R$ vem com espaço não separável
const fetchBot = (path, op) => worker.fetch(new Request(`https://bot.example${path}`, op), env, ctx);

test('chave pública: criada uma vez e sempre a mesma', async () => {
  const a = await (await fetchBot('/push/chave')).text();
  const b = await (await fetchBot('/push/chave')).text();
  assert.equal(a, b);
  assert.equal(Buffer.from(a, 'base64url').length, 65, 'chave P-256 não comprimida');
  assert.ok(banco['segredos/push'].privadaJwk);
  assert.equal((await fetchBot('/push/chave')).headers.get('access-control-allow-origin'), '*');
});

test('lançamento pelo Atalho avisa só o outro, com mensagem cifrada e VAPID válido', async () => {
  const fer = await aparelho('Fernando', 'fernandomendoncacintra@gmail.com', 'https://push.example/fer');
  const gabi = await aparelho('Gabi', 'gabrielagomesfran@gmail.com', 'https://push.example/gabi');
  await atalhoTexto('45 mercado pão', 'chave-e'); // a chave-e é da "esposa" (nome começa com "esp"... ver abaixo)
  await esperarAvisos();
  // chave-e pertence a "Esposa": ninguém inscrito tem esse nome, então os dois recebem.
  assert.equal(pushes.length, 2);
  pushes = []; pendentes = [];
  banco['inscricoes/gabi'].nome = 'Esposa';
  await atalhoTexto('20 uber', 'chave-e');
  await esperarAvisos();
  assert.deepEqual(pushes.map((x) => x.url), ['https://push.example/fer'], 'quem lançou não recebe');
  const msg = await decifrar(fer, pushes[0].corpo);
  assert.equal(espacos(msg.titulo), 'Esposa lançou R$ 20,00');
  assert.equal(msg.corpo, 'Transporte · Uber');
  // VAPID: JWT ES256 assinado com a chave pública anunciada e para a origem do serviço de push.
  const [, t, k] = pushes[0].headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  const [h, c, sig] = t.split('.');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://push.example');
  const pub = await crypto.subtle.importKey('raw', Buffer.from(k, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${h}.${c}`)));
  assert.equal(pushes[0].headers['Content-Encoding'], 'aes128gcm');
  void gabi;
});

test('lançamento feito no app (por e-mail) avisa o outro uma vez só', async () => {
  const fer = await aparelho('Fernando', 'fernandomendoncacintra@gmail.com', 'https://push.example/fer');
  await aparelho('Gabi', 'gabrielagomesfran@gmail.com', 'https://push.example/gabi');
  banco['lancamentos/app1'] = { tipo: 'gasto', valor: 89.9, categoria: 'Compras', descricao: 'Tênis', criadoPor: 'gabrielagomesfran@gmail.com', criadoEm: new Date() };
  const corpo = JSON.stringify({ id: 'app1' });
  assert.equal((await fetchBot('/push/aviso', { method: 'POST', body: corpo })).status, 202);
  await fetchBot('/push/aviso', { method: 'POST', body: corpo });
  await esperarAvisos();
  assert.deepEqual(pushes.map((x) => x.url), ['https://push.example/fer'], 'avisa o Fernando, e uma vez só');
  const m = await decifrar(fer, pushes[0].corpo);
  assert.deepEqual({ ...m, titulo: espacos(m.titulo) }, { titulo: 'Gabi lançou R$ 89,90', corpo: 'Compras · Tênis' });
});

test('não avisa lançamento antigo, fixo ou inexistente, e recusa id estranho', async () => {
  await aparelho('Fernando', 'fernandomendoncacintra@gmail.com', 'https://push.example/fer');
  banco['lancamentos/velho'] = { tipo: 'gasto', valor: 10, categoria: 'Outros', criadoPor: 'gabrielagomesfran@gmail.com', criadoEm: new Date(Date.now() - 3600000) };
  banco['lancamentos/fixo'] = { tipo: 'gasto', valor: 10, categoria: 'Outros', fixoId: 'f', criadoPor: 'automático', criadoEm: new Date() };
  for (const id of ['velho', 'fixo', 'naoexiste']) await fetchBot('/push/aviso', { method: 'POST', body: JSON.stringify({ id }) });
  await esperarAvisos();
  assert.equal(pushes.length, 0);
  assert.equal((await fetchBot('/push/aviso', { method: 'POST', body: JSON.stringify({ id: '../x' }) })).status, 400);
});

test('parcelado avisa com o total, e inscrição morta é apagada', async () => {
  const fer = await aparelho('Fernando', 'fernandomendoncacintra@gmail.com', 'https://push.example/fer');
  await aparelho('Fernando', 'fernandomendoncacintra@gmail.com', 'https://push.example/morta');
  for (const n of [1, 2, 3]) {
    banco[`lancamentos/p_${n}`] = { tipo: 'gasto', valor: n === 1 ? 200.01 : 200, categoria: 'Casa', descricao: 'Sofá', parcelaId: 'p', parcela: n, parcelas: 3, criadoPor: 'atalho:gabi', criadoEm: new Date() };
  }
  await fetchBot('/push/aviso', { method: 'POST', body: JSON.stringify({ id: 'p_1' }) });
  await esperarAvisos();
  assert.equal(pushes.length, 2);
  const msg = await decifrar(fer, pushes.find((x) => x.url.endsWith('/fer')).corpo);
  assert.equal(espacos(msg.titulo), 'Gabi lançou R$ 600,01 em 3x');
  assert.equal(banco['inscricoes/morta'], undefined, 'inscrição que respondeu 410 foi apagada');
  assert.ok(banco['inscricoes/fer']);
});
