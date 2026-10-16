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
  restaurante: ['restaurante', 'marmita', 'marmitex', 'quentinha', 'almoco', 'janta', 'jantar', 'lanche', 'pizza', 'ifood', 'hamburguer',
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

// Categoria cujo nome aparece no texto ("marmita" com a categoria Marmita), ou undefined.
export function categoriaPeloNome(descricao, categorias) {
  const texto = normal(descricao);
  return categorias.find((c) => temPalavra(texto, normal(c)));
}

// Escolhe a categoria: primeiro pelo nome das categorias cadastradas, depois pelas palavras-chave.
export function escolherCategoria(descricao, categorias) {
  const texto = normal(descricao);
  const porNome = categoriaPeloNome(descricao, categorias);
  if (porNome) return porNome;
  for (const [chave, palavras] of Object.entries(PALAVRAS)) {
    const cat = categorias.find((c) => normal(c) === chave);
    if (cat && palavras.some((p) => temPalavra(texto, p))) return cat;
  }
  return categorias.find((c) => normal(c) === 'outros') || categorias[categorias.length - 1] || 'Outros';
}

// "Mercado arroz e carne" na categoria Mercado vira só "Arroz e carne": o nome da categoria no começo
// só servia para escolhê-la. Palavras-chave ficam ("Pizza com a família" diz mais que "Com a família"),
// e se não sobrar nada a descrição fica como veio.
export function observacao(descricao, categoria) {
  const nome = normal(categoria);
  const texto = normal(descricao);
  if (!nome || !(texto === nome || texto.startsWith(`${nome} `))) return descricao;
  const resto = String(descricao).trim().split(/\s+/).slice(nome.split(' ').length).join(' ')
    .replace(/^((de|do|da|dos|das|no|na|em|com|pra|para)\s+)+/i, '').trim();
  return resto ? resto[0].toUpperCase() + resto.slice(1) : descricao;
}

const RE_VALOR = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(?:reais|real|conto|contos)\b)?/i;

// "3x", "em 3x", "3 vezes": compra parcelada (de 2 a 24 vezes; "1x" é à vista).
const RE_PARCELAS = /(^|\s)(?:em\s+)?(\d{1,2})\s*(?:x|vezes)(?=\s|$)/i;

// Retorna { valor, descricao, diasAtras, parcelas } ou null se não houver valor.
// O valor é o total da compra; dividir em parcelas fica para quem grava.
export function interpretar(texto) {
  let original = String(texto || '').trim();
  let parcelas = 1;
  const p = original.match(RE_PARCELAS);
  if (p && Number(p[2]) >= 1 && Number(p[2]) <= 24) {
    parcelas = Number(p[2]);
    original = (original.slice(0, p.index) + p[1] + original.slice(p.index + p[0].length)).trim();
  }
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
  return { valor, descricao, diasAtras, parcelas };
}

// Divide o total em centavos; o que não divide certinho vai para a 1ª parcela, como no cartão
// (mesma regra de dividirParcelas em public/app.js).
export function dividirParcelas(valor, n) {
  const centavos = Math.round(valor * 100);
  const base = Math.floor(centavos / n);
  return Array.from({ length: n }, (_, i) => (i ? base : centavos - base * (n - 1)) / 100);
}

// Mesmo dia, k meses depois (dia 31 vira o último dia dos meses mais curtos).
export function dataDaParcela(data, k) {
  const [a, m] = data.slice(0, 7).split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + k, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return `${alvo.toISOString().slice(0, 7)}-${String(Math.min(Number(data.slice(8)), ultimoDia)).padStart(2, '0')}`;
}
