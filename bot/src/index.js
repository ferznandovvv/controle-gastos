// Lança os gastos no Firestore a partir de mensagens de texto. Roda no Cloudflare Workers e atende:
//   /atalho        o app Atalhos do iPhone (veja a função atalho; a resposta vem em texto simples)
//   POST /         o bot do Telegram (opcional)
// Configuração (segredos do Worker):
//   FIREBASE_SERVICE_ACCOUNT       chave JSON da conta de serviço do Firebase
//   ATALHO_CHAVES                  quem pode usar o Atalho, como "nome:chave,nome:chave"; a chave vem no
//                                  endereço ou no cabeçalho Authorization e o nome identifica quem lançou
//   TELEGRAM_TOKEN                 token do bot, dado pelo @BotFather
//   TELEGRAM_USUARIOS_PERMITIDOS   IDs do Telegram que podem lançar gastos, separados por vírgula
// O Telegram é avisado do endereço do bot pela publicação (.github/workflows/publicar.yml), com um segredo
// derivado do token (segredoWebhook) que volta em cada chamada e prova que ela veio do Telegram.
import { conectar } from './firestore.js';
import { interpretar, escolherCategoria, observacao, normal } from './interpretar.js';

// Mesma lista padrão do app (public/app.js), usada enquanto ninguém editar as categorias.
const CAT_PADRAO = ['Mercado', 'Bebê', 'Moradia', 'Contas da casa', 'Transporte', 'Saúde', 'Restaurante', 'Lazer',
  'Viagem', 'Compras', 'Roupas', 'Beleza', 'Presentes', 'Educação', 'Assinaturas', 'Pets', 'Outros'];
const AJUDA = 'Mande o valor e o que foi, por exemplo:\n'
  + '• *45,90 mercado*\n• *uber 23*\n• *ontem 120 farmácia*\n\n'
  + 'Comandos: *total* (gastos do mês) e *desfazer* (apaga o último).';

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fusoSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const dataSP = (diasAtras = 0) => fusoSP.format(new Date(Date.now() - diasAtras * 86400000));
function nomeMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, 15)).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' });
}
function mesAnterior(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m - 2, 15)).toISOString().slice(0, 7);
}

// Segredo que o Telegram manda no cabeçalho de cada chamada. Sai do próprio token para não exigir
// mais um segredo; a publicação calcula o mesmo valor ao registrar o webhook.
export async function segredoWebhook(token) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`webhook:${token}`)));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

async function responderTelegram(env, chat, texto) {
  const enviar = (extra) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto, ...extra }),
  });
  let r = await enviar({ parse_mode: 'Markdown' });
  // Uma descrição com * ou _ quebra a formatação; nesse caso vai sem negrito.
  if (r.status === 400) r = await enviar({});
  if (!r.ok) console.error('Falha ao responder no Telegram', r.status, await r.text());
}

// O que o bot faz com uma mensagem, sem saber de onde ela veio: `responder` leva a resposta de volta.
function criarBot(db, responder) {
  // Mesma regra do app (contaNoTotal em public/app.js): lançamento de fixo com data futura não conta.
  async function gastosDoMes(mes) {
    const docs = await db.consultar('lancamentos', [['mes', 'EQUAL', mes]]);
    return docs.map((d) => d.dados).filter((d) => d.tipo === 'gasto' && !(d.fixoId && d.data > dataSP()));
  }

  async function totalDoMes(mes) {
    return (await gastosDoMes(mes)).reduce((s, d) => s + d.valor, 0);
  }

  async function lancar(texto, autor, idLancamento, origem) {
    const r = interpretar(texto);
    if (!r) return responder(`Não encontrei o valor 🤔\n\n${AJUDA}`);

    const data = dataSP(r.diasAtras);
    const mes = data.slice(0, 7);

    const config = (await db.ler('config/geral'))?.dados || {};
    const categoria = escolherCategoria(r.descricao, config.catGasto?.length ? config.catGasto : CAT_PADRAO);
    const descricao = observacao(r.descricao, categoria);
    try {
      // Um id fixo por mensagem evita duplicar quando a mesma mensagem chega de novo.
      await db.gravar([{
        criar: `lancamentos/${idLancamento}`,
        dados: {
          tipo: 'gasto', valor: r.valor, categoria, descricao, quem: '', data, mes,
          origem, criadoPor: autor,
        },
        agoraEm: 'criadoEm',
      }]);
    } catch (e) {
      if (e.jaExiste) return; // reenvio da mesma mensagem
      throw e;
    }
    const extra = descricao && normal(descricao) !== normal(categoria) ? ` · ${descricao}` : '';
    const quando = ['', ' (ontem)', ' (anteontem)'][r.diasAtras];
    return responder(`✅ ${brl(r.valor)} em *${categoria}*${extra}${quando}\n`
      + `Total de ${nomeMes(mes)}: ${brl(await totalDoMes(mes))}\n\nErrou? Mande *desfazer*.`);
  }

  async function desfazer(autor) {
    const mes = dataSP().slice(0, 7);
    const docs = await db.consultar('lancamentos', [['criadoPor', 'EQUAL', autor], ['mes', 'IN', [mes, mesAnterior(mes)]]]);
    const ultimo = docs.sort((a, b) => (b.dados.criadoEm?.getTime() || 0) - (a.dados.criadoEm?.getTime() || 0))[0];
    if (!ultimo) return responder('Não achei nenhum gasto seu recente para desfazer.');
    await db.gravar([{ apagar: ultimo.caminho }]);
    return responder(`🗑️ Apaguei ${brl(ultimo.dados.valor)} em ${ultimo.dados.categoria}`
      + `${ultimo.dados.descricao ? ` (${ultimo.dados.descricao})` : ''}.`);
  }

  async function resumo() {
    const mes = dataSP().slice(0, 7);
    const porCat = {};
    let total = 0;
    for (const d of await gastosDoMes(mes)) {
      total += d.valor;
      porCat[d.categoria] = (porCat[d.categoria] || 0) + d.valor;
    }
    const top = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([c, v]) => `• ${c}: ${brl(v)}`).join('\n');
    return responder(`📊 Gastos de ${nomeMes(mes)}: *${brl(total)}*${top ? `\n\n${top}` : ''}`);
  }

  return async function tratar(texto, autor, idLancamento, origem) {
    // "/total@nome_do_bot" e "/total" valem o mesmo que "total".
    const cmd = normal(texto).replace(/^\//, '').replace(/@\S+$/, '').replace(/[!?.]/g, '');
    if (['desfazer', 'apagar', 'cancelar', 'excluir'].includes(cmd)) return desfazer(autor);
    if (['total', 'resumo', 'quanto', 'gastos'].includes(cmd)) return resumo();
    if (['start', 'ajuda', 'oi', 'ola', 'menu', 'help', 'bom dia', 'boa tarde', 'boa noite'].includes(cmd)) return responder(AJUDA);
    return lancar(texto, autor, idLancamento, origem);
  };
}

async function telegram(req, env) {
  if (!env.TELEGRAM_TOKEN || req.headers.get('x-telegram-bot-api-secret-token') !== await segredoWebhook(env.TELEGRAM_TOKEN)) {
    console.warn('Chamada sem o segredo do Telegram');
    return new Response(null, { status: 401 });
  }
  const msg = (await req.json()).message;
  if (!msg?.chat) return new Response(null, { status: 200 });
  const chat = msg.chat.id;
  const usuario = String(msg.from?.id || '');
  console.log('Mensagem recebida', msg.chat.type, usuario);
  const responder = (texto) => responderTelegram(env, chat, texto);
  try {
    const permitidos = (env.TELEGRAM_USUARIOS_PERMITIDOS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!permitidos.includes(usuario)) {
      console.warn('Mensagem de usuário não autorizado', usuario);
      // Só em conversa direta: responder em grupo exporia o bot a quem nem falou com ele.
      if (msg.chat.type === 'private') {
        await responder(`Este bot é privado. Seu ID do Telegram é ${usuario}: passe esse número para quem cuida do bot.`);
      }
    } else if (typeof msg.text !== 'string') {
      await responder(`Por enquanto só entendo mensagens de texto.\n\n${AJUDA}`);
    } else {
      // O id da mensagem no lançamento evita duplicar quando o Telegram reenvia a mesma atualização.
      const id = `tg_${chat}_${msg.message_id}`.replace(/-/g, 'n');
      await criarBot(conectar(env.FIREBASE_SERVICE_ACCOUNT), responder)(msg.text, `telegram:${usuario}`, id, 'telegram');
    }
  } catch (e) {
    console.error('Erro ao tratar mensagem', e);
  }
  return new Response(null, { status: 200 });
}

// Quem é o dono da chave enviada pelo Atalho (ou null). ATALHO_CHAVES = "nome:chave,nome:chave".
export function donoDaChave(chaves, autorizacao) {
  const enviada = String(autorizacao || '').replace(/^Bearer\s+/i, '').trim();
  if (!enviada) return null;
  for (const par of String(chaves || '').split(',')) {
    const i = par.indexOf(':');
    if (i > 0 && par.slice(i + 1).trim() === enviada) return normal(par.slice(0, i)).replace(/\s+/g, '-');
  }
  return null;
}

// Aceita dois formatos, para o Atalho poder ser montado do jeito mais simples:
//   GET  /atalho/<chave>?texto=45,90%20mercado
//   POST /atalho  com "Authorization: Bearer <chave>" e corpo {"texto": "..."} (ou o texto puro)
async function atalho(req, env, url) {
  const texto = (msg, status = 200) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const chaveNoCaminho = decodeURIComponent(url.pathname.slice('/atalho/'.length));
  const nome = donoDaChave(env.ATALHO_CHAVES, chaveNoCaminho || req.headers.get('authorization'));
  if (!nome) {
    console.warn('Atalho com chave inválida');
    return texto('Chave inválida: confira a chave no Atalho.', 401);
  }
  let mensagem = url.searchParams.get('texto') ?? '';
  if (req.method === 'POST') {
    mensagem = await req.text();
    try {
      const json = JSON.parse(mensagem);
      if (json && typeof json === 'object') mensagem = json.texto ?? json.text ?? '';
    } catch { /* corpo em texto simples */ }
  }
  mensagem = String(mensagem || '').trim();
  if (!mensagem) return texto(AJUDA.replace(/\*/g, ''));

  console.log('Atalho recebido', nome);
  const respostas = [];
  try {
    await criarBot(conectar(env.FIREBASE_SERVICE_ACCOUNT), (r) => respostas.push(r))(
      mensagem, `atalho:${nome}`, `at_${crypto.randomUUID()}`, 'atalho');
  } catch (e) {
    console.error('Erro ao tratar atalho', e);
    return texto('⚠️ Não consegui lançar agora. Tente de novo em instantes.', 500);
  }
  // O Atalho mostra texto puro: sem os * de negrito e sem a dica de "mandar desfazer" do chat.
  return texto(respostas.join('\n\n').replace(/\*/g, '').replace('Errou? Mande desfazer.', 'Errou? Lance "desfazer".'));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/atalho' || url.pathname.startsWith('/atalho/')) {
      return ['GET', 'POST'].includes(req.method) ? atalho(req, env, url) : new Response(null, { status: 405 });
    }
    if (req.method === 'GET') return new Response('Bot de gastos no ar.');
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    return telegram(req, env);
  },
};
