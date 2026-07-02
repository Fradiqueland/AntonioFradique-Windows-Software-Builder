'use strict';

/*
 * Cifra dos endereços dos canais IPTV.
 *
 * Nos fornecedores Xtream, o utilizador e a password fazem parte do próprio
 * link de cada canal (ex.: http://host/live/USER/PASS/123.m3u8). Para que essas
 * credenciais NÃO fiquem em texto simples dentro do curso gerado (.exe SFX),
 * cifram-se os url no momento de empacotar o curso e decifram-se apenas em
 * memória, dentro do Viewer, no instante de reproduzir.
 *
 * Limitação assumida: como a app corre no PC do aluno, a chave viaja embutida
 * na aplicação. Isto impede que as credenciais sejam lidas por quem simplesmente
 * abre os ficheiros do curso (99,9% dos casos), mas não é à prova de um atacante
 * muito determinado — para isso seria necessário um servidor intermediário.
 */

const crypto = require('crypto');

const SECRET = 'LBX::AntonioFradique.net::iptv-url::7f3a9c1e-2b6d-4a10-9e55-c0ffee1ab2cd';
const KEY = crypto.createHash('sha256').update(SECRET).digest(); // 32 bytes
const PREFIX = 'enc1:';

function encryptUrl(url) {
  if (typeof url !== 'string' || url === '' || url.startsWith(PREFIX)) return url;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
  } catch (_) {
    return url;
  }
}

function decryptUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_) {
    return value;
  }
}

/* Percorre a config e aplica `fn` ao url de cada canal IPTV, devolvendo uma
 * cópia (não altera o objeto original). Módulos não-IPTV ficam intactos. */
function transformConfigIptv(config, fn) {
  if (!config || !Array.isArray(config.content)) return config;
  const content = config.content.map((mod) => {
    if (!mod || mod.type !== 'iptv' || !mod.data || !Array.isArray(mod.data.channels)) return mod;
    const channels = mod.data.channels.map((ch) => {
      if (!ch || typeof ch.url !== 'string') return ch;
      return Object.assign({}, ch, { url: fn(ch.url) });
    });
    return Object.assign({}, mod, { data: Object.assign({}, mod.data, { channels }) });
  });
  return Object.assign({}, config, { content });
}

function encryptConfigIptv(config) { return transformConfigIptv(config, encryptUrl); }
function decryptConfigIptv(config) { return transformConfigIptv(config, decryptUrl); }

/* Prepara a config para ser embutida num curso: cifra os url dos canais IPTV e
 * remove os metadados que só o Builder usa (xtreamUrl/playlistUrl). Esses
 * campos podem conter credenciais/tokens no endereço do servidor e o Viewer
 * nunca os utiliza — os canais já foram resolvidos no momento do build. */
function sanitizeConfigForCourse(config) {
  if (!config || !Array.isArray(config.content)) return config;
  const content = config.content.map((mod) => {
    if (!mod || mod.type !== 'iptv' || !mod.data) return mod;
    const data = Object.assign({}, mod.data);
    delete data.xtreamUrl;
    delete data.playlistUrl;
    if (Array.isArray(data.channels)) {
      data.channels = data.channels.map((ch) =>
        (ch && typeof ch.url === 'string') ? Object.assign({}, ch, { url: encryptUrl(ch.url) }) : ch);
    }
    return Object.assign({}, mod, { data });
  });
  return Object.assign({}, config, { content });
}

module.exports = { encryptUrl, decryptUrl, encryptConfigIptv, decryptConfigIptv, sanitizeConfigForCourse, PREFIX };
