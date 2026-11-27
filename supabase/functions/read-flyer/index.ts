// Edge Function: read-flyer
// Lê um flyer (imagem ou PDF) com o Gemini e devolve os dados do evento em JSON.
// Secrets necessários no projeto Supabase: GEMINI_API_KEY (obrigatório), GEMINI_MODEL (opcional).
// Autorização: somente integrantes ativos com can_full_edit (BOB).

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function buildPrompt(currentYear: number): string {
  return [
    'Você é o secretário do motoclube Carniceiros MC (Curitiba • PR • BR).',
    'Analise o flyer/convite em anexo e extraia os dados do evento.',
    'Regras:',
    `- "data": data do evento no formato AAAA-MM-DD. Se o ano não aparecer no flyer, use ${currentYear} ou ${currentYear + 1} caso a data já tenha passado.`,
    '- "titulo": nome do evento em MAIÚSCULAS e curto (ex: ANIVERSÁRIO CARNICEIROS MC - 21 ANOS, ANIVERSÁRIO BOB, ROCK NO GALPÃO). Não invente; se não houver título, use "".',
    '- "local": local em MAIÚSCULAS e curto (ex: SEDE CARNICEIROS, GALPÃO CARNICEIROS). Se houver apenas cidade, use "CIDADE - UF". Se não houver, use "".',
    '- "horario": horário de início no formato HH:MM (ex: 20:00). Se o flyer indicar dia inteiro, "a partir das 9h" sem término ou não tiver horário, use "DIA INTEIRO".',
    '- "diaInteiro": true quando o evento dura o dia todo ou não há horário definido.',
    '- "descricao": uma frase curta resumindo o evento, ou "".',
    '- "confianca": número de 0 a 1 indicando a confiança na data extraída.',
    'Responda apenas com o JSON do schema solicitado.'
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    data: { type: 'STRING' },
    titulo: { type: 'STRING' },
    local: { type: 'STRING' },
    horario: { type: 'STRING' },
    diaInteiro: { type: 'BOOLEAN' },
    descricao: { type: 'STRING' },
    confianca: { type: 'NUMBER' }
  },
  required: ['data', 'titulo', 'local', 'horario', 'diaInteiro', 'descricao', 'confianca']
};

async function authorize(req: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, status: 401, error: 'Sessão ausente. Entre novamente no app.' };

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!userRes.ok) return { ok: false, status: 401, error: 'Sessão expirada. Entre novamente no app.' };
  const user = await userRes.json().catch(() => null);
  if (!user || !user.id) return { ok: false, status: 401, error: 'Sessão inválida. Entre novamente no app.' };

  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=active,can_full_edit`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const profiles = await profileRes.json().catch(() => []);
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profile || !profile.active || !profile.can_full_edit) {
    return { ok: false, status: 403, error: 'Somente BOB (Full Edição) pode usar a leitura de flyers.' };
  }
  return { ok: true };
}

function extractJsonText(raw: string): string {
  const trimmed = String(raw || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ error: 'Método não permitido.' }, 405);

  const auth = await authorize(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  const geminiKey = Deno.env.get('GEMINI_API_KEY') || '';
  if (!geminiKey) {
    return jsonResponse({ error: 'IA não configurada no servidor (GEMINI_API_KEY ausente).' }, 503);
  }

  let payload: { image?: string; mimeType?: string };
  try {
    payload = await req.json();
  } catch (_e) {
    return jsonResponse({ error: 'Corpo da requisição inválido.' }, 400);
  }

  const dataUrl = String(payload.image || '');
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) return jsonResponse({ error: 'Envie o flyer como data URL base64.' }, 400);
  if (match[2].length > MAX_BASE64_CHARS) {
    return jsonResponse({ error: 'Flyer muito grande. Use uma imagem menor (até ~5 MB).' }, 413);
  }
  const mimeType = String(payload.mimeType || match[1]).toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) {
    return jsonResponse({ error: 'Formato não suportado. Use JPG, PNG, WEBP ou PDF.' }, 415);
  }

  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash';
  const currentYear = new Date().getFullYear();
  let geminiRes: Response;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType, data: match[2].replace(/\s+/g, '') } },
              { text: buildPrompt(currentYear) }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA
          }
        })
      }
    );
  } catch (_e) {
    return jsonResponse({ error: 'Falha de conexão com a IA. Tente novamente.' }, 502);
  }

  if (!geminiRes.ok) {
    const detail = await geminiRes.text().catch(() => '');
    if (geminiRes.status === 429) {
      return jsonResponse({ error: 'Limite gratuito da IA atingido agora. Aguarde alguns minutos.' }, 429);
    }
    if (geminiRes.status === 400 && /API[_ ]?KEY/i.test(detail)) {
      return jsonResponse({ error: 'Chave da IA inválida no servidor (GEMINI_API_KEY).' }, 503);
    }
    if (geminiRes.status === 403) {
      return jsonResponse({ error: 'A IA recusou a requisição (verifique a chave e o modelo).' }, 503);
    }
    return jsonResponse({ error: 'A IA não conseguiu processar o flyer. Tente outra imagem.' }, 502);
  }

  const geminiData = await geminiRes.json().catch(() => null);
  const text = geminiData?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
  if (!text) {
    const blocked = geminiData?.promptFeedback?.blockReason;
    return jsonResponse({
      error: blocked ? 'O flyer foi bloqueado pelo filtro de segurança da IA.' : 'A IA não retornou dados legíveis.'
    }, 422);
  }

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(extractJsonText(text));
  } catch (_e) {
    return jsonResponse({ error: 'A IA retornou um formato inesperado. Tente novamente.' }, 502);
  }

  return jsonResponse({ result, model });
});