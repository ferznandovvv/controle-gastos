// Interpreta mensagens como "45,90 mercado", "uber 23", "ontem 120 farmácia".

// Palavras que indicam cada categoria (comparadas sem acento e em minúsculas).
// As mais específicas vêm primeiro: "pediatra" é Bebê antes de ser Saúde.
const PALAVRAS = {
  bebe: ['bebe', 'fralda', 'fraldas', 'lenco umedecido', 'lencos umedecidos', 'formula', 'leite em po', 'nan',
    'aptamil', 'mamadeira', 'chupeta', 'pediatra', 'berco', 'carrinho', 'enxoval', 'body', 'macacao',
    'pomada', 'creche', 'baba', 'papinha', 'bercario', 'brinquedo'],
  roupas: ['roupa', 'roupas', 'sapato', 'tenis', 'camisa', 'calca', 'vestido', 'renner', 'riachuelo', 'cea', 'zara'],
  beleza: ['salao', 'cabelo', 'cabeleireiro', 'manicure', 'unha', 'unhas', 'maquiagem', 'perfume', 'barbeiro',
    'barbearia', 'depilacao', 'sobrancelha', 'boticario', 'natura'],
  presentes: ['presente', 'presentes', 'lembrancinha'],
  viagem: ['viagem', 'hotel', 'pousada', 'passagem', 'passagens', 'airbnb', 'aeroporto', 'hospedagem'],
  mercado: ['mercado', 'supermercado', 'feira', 'hortifruti', 'sacolao', 'padaria', 'acougue', 'atacadao',
    'assai', 'carrefour', 'extra', 'pao de acucar', 'compras do mes'],
  restaurante: ['restaurante', 'almoco', 'janta', 'jantar', 'lanche', 'pizza', 'ifood', 'hamburguer',
    'burguer', 'sushi', 'bar', 'cafe', 'cafeteria', 'sorvete', 'acai', 'delivery', 'mcdonalds', 'bk'],
  transporte: ['uber', '99', 'gasolina', 'combustivel', 'etanol', 'alcool', 'posto', 'estacionamento',
    'onibus', 'metro', 'pedagio', 'taxi', 'oficina', 'mecanico', 'lavagem', 'ipva', 'seguro do carro'],
  saude: ['farmacia', 'remedio', 'medico', 'consulta', 'exame', 'dentista', 'plano de saude', 'hospital',
    'psicologo', 'terapia', 'drogaria'],
  moradia: ['aluguel', 'condominio', 'iptu', 'reforma', 'moveis', 'movel'],
  'contas da casa': ['luz', 'energia', 'agua', 'internet', 'gas', 'telefone', 'celular', 'conta de luz',
    'conta de agua', 'faxina', 'diarista'],
  lazer: ['cinema', 'show', 'viagem', 'passeio', 'parque', 'teatro', 'ingresso', 'hotel', 'pousada', 'balada'],
  assinaturas: ['netflix', 'spotify', 'prime', 'disney', 'hbo', 'max', 'youtube', 'icloud', 'assinatura',
    'globoplay', 'deezer', 'chatgpt', 'claude'],
  compras: ['shopee', 'amazon', 'mercado livre', 'shein', 'roupa', 'roupas', 'loja', 'shopping', 'sapato',
    'tenis', 'presente', 'magalu'],
  educacao: ['escola', 'curso', 'livro', 'livros', 'faculdade', 'material escolar', 'mensalidade'],
  pets: ['racao', 'pet', 'petshop', 'veterinario', 'vet', 'banho e tosa'],
};

export function normal(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function temPalavra(texto, palavra) {
  return new RegExp(`(^|[^a-z0-9])${palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(texto);
}

// Escolhe a categoria: primeiro pelo nome das categorias cadastradas, depois pelas palavras-chave.
export function escolherCategoria(descricao, categorias) {
  const texto = normal(descricao);
  const porNome = categorias.find((c) => temPalavra(texto, normal(c)));
  if (porNome) return porNome;
  for (const [chave, palavras] of Object.entries(PALAVRAS)) {
    const cat = categorias.find((c) => normal(c) === chave);
    if (cat && palavras.some((p) => temPalavra(texto, p))) return cat;
  }
  return categorias.find((c) => normal(c) === 'outros') || categorias[categorias.length - 1] || 'Outros';
}

// Nomes diferentes para a mesma conta da casa (inclui as concessionárias mais comuns).
const SINONIMOS = [
  ['luz', 'energia', 'conta de luz', 'eletricidade', 'enel', 'cemig', 'light', 'cpfl', 'copel', 'celesc', 'coelba',
    'celpe', 'equatorial', 'neoenergia', 'edp', 'energisa'],
  ['agua', 'conta de agua', 'agua e esgoto', 'saneamento', 'sabesp', 'copasa', 'cedae', 'sanepar', 'embasa',
    'compesa', 'caesb', 'corsan', 'casan', 'aegea', 'iguá', 'igua'],
  ['internet', 'wifi', 'wi-fi', 'fibra', 'banda larga', 'net', 'vivo fibra', 'claro net', 'oi fibra', 'tim live'],
  ['gas', 'gas encanado', 'comgas', 'botijao', 'naturgy', 'ultragaz'],
  ['condominio', 'condo', 'taxa de condominio'],
  ['celular', 'telefone', 'plano de celular', 'vivo', 'claro', 'tim', 'oi'],
  ['aluguel', 'aluguel e iptu'],
];

// Grupo de sinônimos ao qual um texto pertence (ou o próprio texto, se não estiver em nenhum).
function grupoDaConta(texto) {
  const t = normal(texto);
  const i = SINONIMOS.findIndex((g) => g.some((s) => t === normal(s) || temPalavra(t, normal(s))));
  return i >= 0 ? `#${i}` : t;
}

// A mensagem fala da mesma conta que o fixo? ("luz" bate com "Energia", "conta da Sabesp" com "Água").
export function mesmaConta(nomeFixo, descricao) {
  const fixo = normal(nomeFixo);
  const desc = normal(descricao);
  if (!fixo || !desc) return false;
  if (desc.includes(fixo) || fixo.includes(desc)) return true;
  const g = grupoDaConta(fixo);
  return g.startsWith('#') && g === grupoDaConta(desc);
}

const RE_VALOR = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(?:reais|real|conto|contos)\b)?/i;

// Retorna { valor, descricao, diasAtras } ou null se não houver valor.
export function interpretar(texto) {
  const original = String(texto || '').trim();
  const m = original.match(RE_VALOR);
  if (!m) return null;
  let num = m[1];
  num = num.includes(',') ? num.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(num) ? num.replace(/\./g, '') : num;
  const valor = Math.round(Number(num) * 100) / 100;
  if (!(valor > 0)) return null;

  let resto = (original.slice(0, m.index) + ' ' + original.slice(m.index + m[0].length));
  let diasAtras = 0;
  if (/\banteontem\b/i.test(resto)) diasAtras = 2;
  else if (/\bontem\b/i.test(resto)) diasAtras = 1;
  resto = resto.replace(/\b(anteontem|ontem|hoje|gastei|paguei|comprei)\b/gi, ' ')
    .replace(/[\s\-–—:;,.]+/g, ' ')
    .trim()
    .replace(/^((de|do|da|no|na|em|com|o|a)\s+)+/i, '');
  const descricao = resto ? resto[0].toUpperCase() + resto.slice(1) : '';
  return { valor, descricao, diasAtras };
}
