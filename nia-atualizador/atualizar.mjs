// Nia — atualizador de notícias
// Fluxo: lê RSS -> descarta o que já está no banco -> Gemini resume em português -> grava no Supabase.
// Requer Node 20+ (usa fetch nativo, sem dependências).
// Uso:  node --env-file=.env atualizar.mjs        (grava de verdade)
//       node atualizar.mjs --dry                  (só testa os feeds, sem chaves)

const DRY = process.argv.includes('--dry');
const {
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-flash-latest',      // troque se o AI Studio indicar outro modelo gratuito
  SUPABASE_URL,                               // ex.: https://xxxx.supabase.co
  SUPABASE_SECRET_KEY,                        // chave service_role / secret (NUNCA no site)
} = process.env;

const DIAS_MAX = Number(process.env.DIAS_MAX || 7);      // ignora posts mais velhos que isso
const MAX_NOVAS = Number(process.env.MAX_NOVAS || 12);   // limite por execução (poupa a cota)

// empresa = como aparece no site; fonte = RSS. Anthropic e Meta não têm RSS oficial:
// os feeds abaixo são gerados pela comunidade (github.com/Olshansk/rss-feeds) e podem falhar.
const FONTES = [
  { empresa: 'OpenAI',    url: 'https://openai.com/news/rss.xml' },
  { empresa: 'Google',    url: 'https://deepmind.google/blog/rss.xml' },
  { empresa: 'Google',    url: 'https://blog.google/technology/ai/rss/' },
  { empresa: 'Anthropic', url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml' },
  { empresa: 'Meta',      url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_meta_ai.xml' },
  { empresa: 'Geral',     url: 'https://huggingface.co/blog/feed.xml' },
];
const TAGS = ['Modelos', 'Agentes', 'Regulação', 'Código aberto', 'Multimodal', 'Segurança', 'Pesquisa', 'Produtos'];

/* ---------- RSS / Atom ---------- */
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const limpar = s => decode(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const pegar = (bloco, tag) => {
  const m = bloco.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
};

function lerFeed(xml, empresa) {
  const blocos = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocos.map(b => {
    const linkAtom = b.match(/<link[^>]*href=["']([^"']+)["']/i);
    const link = limpar(pegar(b, 'link')) || (linkAtom ? linkAtom[1] : '');
    const data = new Date(limpar(pegar(b, 'pubDate') || pegar(b, 'published') || pegar(b, 'updated')));
    return {
      empresa, link,
      titulo: limpar(pegar(b, 'title')),
      texto: limpar(pegar(b, 'description') || pegar(b, 'summary') || pegar(b, 'content')).slice(0, 1200),
      publicado_em: isNaN(data) ? new Date() : data,
    };
  }).filter(n => n.link && n.titulo);
}

async function coletar() {
  const limite = Date.now() - DIAS_MAX * 864e5;
  const todas = [];
  for (const f of FONTES) {
    try {
      const r = await fetch(f.url, { headers: { 'User-Agent': 'NiaBot/1.0 (+rss)' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const itens = lerFeed(await r.text(), f.empresa);
      console.log(`✔ ${f.url} -> ${itens.length} itens`);
      todas.push(...itens);
    } catch (e) {
      console.warn(`✖ ${f.url} -> ${e.message} (ignorado)`);
    }
  }
  const vistos = new Set();
  return todas
    .filter(n => n.publicado_em.getTime() >= limite)
    .filter(n => !vistos.has(n.link) && vistos.add(n.link))
    .sort((a, b) => b.publicado_em - a.publicado_em);
}

/* ---------- Supabase (REST, sem SDK) ---------- */
const sb = (path, init = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
    ...init.headers,
  },
});

async function linksExistentes() {
  const r = await sb('noticias?select=link&order=publicado_em.desc&limit=500');
  if (!r.ok) throw new Error(`Supabase (leitura) ${r.status}: ${await r.text()}`);
  return new Set((await r.json()).map(x => x.link));
}

async function salvar(linhas) {
  const r = await sb('noticias?on_conflict=link', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(linhas),
  });
  if (!r.ok) throw new Error(`Supabase (gravação) ${r.status}: ${await r.text()}`);
}

/* ---------- Gemini ---------- */
async function resumir(itens) {
  const entrada = itens.map((n, id) => ({ id, empresa: n.empresa, titulo: n.titulo, texto: n.texto }));
  const prompt =
`Você é editor de um portal brasileiro de notícias sobre Inteligência Artificial.
Para cada item abaixo, escreva em português do Brasil:
- "titulo": título claro e objetivo, até 90 caracteres, sem clickbait;
- "resumo": 2 a 3 frases com suas próprias palavras, usando SOMENTE o que está no texto recebido (não invente datas, números ou recursos);
- "tag": exatamente uma entre ${JSON.stringify(TAGS)};
- "empresa": mantenha o valor recebido, exceto se o texto tratar claramente de outra empresa da lista [OpenAI, Anthropic, Google, Meta, Geral].
Devolva um item de saída para cada "id" recebido.

ITENS:
${JSON.stringify(entrada)}`;

  const corpo = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'INTEGER' }, titulo: { type: 'STRING' }, resumo: { type: 'STRING' },
            tag: { type: 'STRING', enum: TAGS }, empresa: { type: 'STRING' },
          },
          required: ['id', 'titulo', 'resumo', 'tag', 'empresa'],
        },
      },
    },
  };

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(corpo),
    });
    if (r.status === 429 || r.status >= 500) {          // limite de cota ou instabilidade: espera e tenta de novo
      await new Promise(ok => setTimeout(ok, 15000 * tentativa));
      continue;
    }
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const j = await r.json();
    const texto = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '[]';
    return JSON.parse(texto);
  }
  throw new Error('Gemini indisponível após 3 tentativas');
}

/* ---------- Execução ---------- */
const novidades = await coletar();
console.log(`\n${novidades.length} itens recentes nos feeds.`);

if (DRY) {
  novidades.slice(0, 5).forEach(n => console.log(` • [${n.empresa}] ${n.titulo}`));
  console.log('\nModo --dry: nada foi enviado ao Gemini nem ao banco.');
  process.exit(0);
}

for (const [nome, v] of Object.entries({ GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY })) {
  if (!v) { console.error(`Falta a variável ${nome}.`); process.exit(1); }
}

const jaTem = await linksExistentes();
const novas = novidades.filter(n => !jaTem.has(n.link)).slice(0, MAX_NOVAS);
if (!novas.length) { console.log('Nada novo para publicar.'); process.exit(0); }

console.log(`Resumindo ${novas.length} novidades com ${GEMINI_MODEL}...`);
const resumos = await resumir(novas);
const linhas = resumos
  .filter(x => novas[x.id])
  .map(x => ({
    link: novas[x.id].link,
    fonte: new URL(novas[x.id].link).hostname,
    tag: TAGS.includes(x.tag) ? x.tag : 'Produtos',
    empresa: x.empresa || novas[x.id].empresa,
    titulo: x.titulo.trim(),
    resumo: x.resumo.trim(),
    publicado_em: novas[x.id].publicado_em.toISOString(),
  }));

await salvar(linhas);
console.log(`Salvas ${linhas.length} notícias no Supabase.`);
