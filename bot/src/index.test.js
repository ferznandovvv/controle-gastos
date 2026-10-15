// Testa o Worker de ponta a ponta com Google, Firestore e Telegram simulados (fetch falso).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { segredoWebhook } from './index.js';
import { paraCampos } from './firestore.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
    project_id: 'proj', private_key_id: 'k1', client_email: 'bot@proj.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }),
  TELEGRAM_TOKEN: '123:abc', TELEGRAM_USUARIOS_PERMITIDOS: '111, 222',
};
const RAIZ = 'projects/proj/databases/(default)/documents';

let banco; let commits; let respostas; let destinos;
const docApi = (caminho) => ({ name: `${RAIZ}/${caminho}`, fields: paraCampos(banco[caminho]) });

beforeEach(() => {
  banco = {}; commits = []; respostas = []; destinos = [];
  globalThis.fetch = async (url, op = {}) => {
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.startsWith('https://oauth2.googleapis.com')) return json({ access_token: 'acesso', expires_in: 3600 });
    if (url.startsWith('https://api.telegram.org/bot123:abc/sendMessage')) {
      respostas.push(JSON.parse(op.body).text);
      destinos.push(JSON.parse(op.body).chat_id);
      return json({});
    }
    assert.equal(op.headers.Authorization, 'Bearer acesso');
    const caminho = url.split('/documents')[1];
    if (caminho === ':runQuery') {
      const q = JSON.parse(op.body).structuredQuery;
      const filtros = q.where.compositeFilter?.filters || [q.where];
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
  return worker.fetch(new Request('https://bot.example/', { method: 'POST', body: corpo, headers: { 'x-telegram-bot-api-secret-token': s } }), env);
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

test('confirma conta variável e atualiza a estimativa do fixo', async () => {
  banco['fixos/f1'] = { descricao: 'Energia', variavel: true, valor: 150, dia: 10, categoria: 'Contas da casa', gerados: [] };
  await mensagem('luz 187,40');
  const mes = Object.keys(banco).find((c) => c.startsWith('lancamentos/f1_')).slice('lancamentos/f1_'.length);
  const lanc = banco[`lancamentos/f1_${mes}`];
  assert.equal(lanc.valor, 187.4);
  assert.equal(lanc.confirmado, true);
  assert.equal(lanc.data, `${mes}-10`);
  assert.equal(banco['fixos/f1'].valor, 187.4);
  assert.deepEqual(banco['fixos/f1'].gerados, [mes]);
  assert.match(respostas[0], /estimativa era R\$\s150,00/);
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
