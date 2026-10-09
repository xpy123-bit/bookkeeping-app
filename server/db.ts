/**
 * 服务端存储：用户、第三方身份、会话、OAuth state。
 *
 * 用 Node 内置的 `node:sqlite`，**不引入任何数据库依赖**。这里只存身份与会话，
 * 账本数据仍然留在用户设备的 IndexedDB 里 —— 服务端不持有流水。
 *
 * 三个表的设计约束：
 * - `identities` 上 `UNIQUE(provider, subject)`：同一个人在同一个渠道只能有一条。
 *   这是防止「重放授权码建出重复账号」的承重约束，不能只靠应用层判断。
 * - `subject` 存的是渠道内的稳定标识：支付宝用 `user_id`（并记录其遵循的标准），
 *   微信用 `unionid`（不是 `openid` —— 后者是「用户 + 单个 AppID」维度）。
 * - `sessions` 存服务端不透明令牌的哈希，不存令牌本身；库被读走也无法直接冒用。
 */

import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 加载内置的 `node:sqlite`。
 *
 * 刻意不走静态 `import`：vitest 内置的 vite 版本早于 `node:sqlite`
 * （Node 22.5 才加入），它的内置模块清单里没有这一项，会把它当成 npm 包
 * 去解析并失败。`process.getBuiltinModule` 是运行时调用，打包器无法静态解析，
 * 因此彻底绕开这个问题。
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** 会话有效期：30 天。 */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** OAuth state 有效期：10 分钟（微信授权码本身也只有 10 分钟）。 */
const STATE_TTL_SECONDS = 10 * 60;

/** 一条用户记录。 */
export interface UserRow {
  id: number;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
}

/** 一条第三方身份记录。 */
export interface IdentityRow {
  id: number;
  user_id: number;
  provider: string;
  subject: string;
  /**
   * `subject` 遵循的标识标准。
   *
   * 两家平台都在迁移用户标识：支付宝正从 `user_id` 迁到 `open_id`
   * （官方明确「未来推出的新产品将只支持 openid」），微信则区分 `openid` 与 `unionid`。
   * 只存一个裸标识符，将来无法判断它属于哪一代，回填会无从下手。
   */
  subject_standard: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
}

/** 数据库文件位置。 */
const DB_PATH = process.env.DB_PATH ?? 'data/bookkeeping.sqlite';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name  TEXT,
    avatar_url    TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS identities (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT NOT NULL,
    subject          TEXT NOT NULL,
    subject_standard TEXT NOT NULL DEFAULT '',
    display_name     TEXT,
    avatar_url       TEXT,
    created_at       INTEGER NOT NULL,
    UNIQUE (provider, subject)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state       TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    code_verifier TEXT,
    return_to   TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
  );

  -- 登录发起频率限制：记录每次发起，用于滑动窗口计数。
  CREATE TABLE IF NOT EXISTS auth_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT NOT NULL,
    provider   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_auth_attempts ON auth_attempts (ip, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
`);

/** 当前 Unix 秒。 */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 把会话令牌哈希后入库。
 *
 * @param token 原始令牌。
 * @returns 十六进制 SHA-256。
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 生成密码学安全的随机串。
 *
 * @param bytes 熵字节数。
 * @returns URL 安全的十六进制串。
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * 创建一次性 OAuth state。
 *
 * state 必须由服务端保存，**不能放 sessionStorage** —— PWA 在 iOS 上被系统
 * 回收后会丢失，用户回来时 state 对不上，登录静默失败。
 *
 * @param provider 渠道名。
 * @param returnTo 登录成功后要跳回的站内路径。
 * @param codeVerifier PKCE 校验值，渠道不支持时传 `null`。
 * @returns state 字符串。
 */
export function createOAuthState(
  provider: string,
  returnTo: string,
  codeVerifier: string | null,
): string {
  const state = randomToken(24);
  const now = nowSeconds();

  db.prepare(
    `INSERT INTO oauth_states (state, provider, code_verifier, return_to, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(state, provider, codeVerifier, returnTo, now, now + STATE_TTL_SECONDS);

  return state;
}

/**
 * 消费一个 state：验证存在、未使用、未过期，并立即标记为已使用。
 *
 * 单次使用是关键 —— 允许重复使用就等于放弃 CSRF 防护。
 *
 * @param state 回调带回的 state。
 * @param provider 期望的渠道名。
 * @returns 校验通过时返回记录，否则返回 `null`。
 */
export function consumeOAuthState(
  state: string,
  provider: string,
): { returnTo: string; codeVerifier: string | null } | null {
  const row = db
    .prepare(
      `SELECT provider, code_verifier, return_to, expires_at, used_at
       FROM oauth_states WHERE state = ?`,
    )
    .get(state) as
    | {
        provider: string;
        code_verifier: string | null;
        return_to: string;
        expires_at: number;
        used_at: number | null;
      }
    | undefined;

  if (!row) return null;
  if (row.provider !== provider) return null;
  if (row.used_at !== null) return null;
  if (row.expires_at < nowSeconds()) return null;

  db.prepare('UPDATE oauth_states SET used_at = ? WHERE state = ?').run(
    nowSeconds(),
    state,
  );

  return { returnTo: row.return_to, codeVerifier: row.code_verifier };
}

/**
 * 把第三方身份 upsert 成用户，并建立会话。
 *
 * 若 `UNIQUE(provider, subject)` 已有记录则复用其用户；否则建新用户。
 * 有昵称/头像时顺带回填 —— 支付宝个人账号拿不到这两项，因此它们必须是可空的。
 *
 * @param input 归一化后的身份信息。
 * @returns 用户 id。
 */
export function upsertIdentity(input: {
  provider: string;
  subject: string;
  subjectStandard: string;
  displayName: string | null;
  avatarUrl: string | null;
}): number {
  const existing = db
    .prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?')
    .get(input.provider, input.subject) as { user_id: number } | undefined;

  if (existing) {
    // 资料可能后续才拿到（例如用户之后补填），有值时回填，无值时保留原值。
    if (input.displayName !== null || input.avatarUrl !== null) {
      db.prepare(
        `UPDATE identities
         SET display_name = COALESCE(?, display_name),
             avatar_url   = COALESCE(?, avatar_url)
         WHERE provider = ? AND subject = ?`,
      ).run(input.displayName, input.avatarUrl, input.provider, input.subject);

      db.prepare(
        `UPDATE users
         SET display_name = COALESCE(?, display_name),
             avatar_url   = COALESCE(?, avatar_url)
         WHERE id = ?`,
      ).run(input.displayName, input.avatarUrl, existing.user_id);
    }
    return existing.user_id;
  }

  const now = nowSeconds();
  const created = db
    .prepare(
      'INSERT INTO users (display_name, avatar_url, created_at) VALUES (?, ?, ?)',
    )
    .run(input.displayName, input.avatarUrl, now);

  const userId = Number(created.lastInsertRowid);

  db.prepare(
    `INSERT INTO identities
       (user_id, provider, subject, subject_standard, display_name, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    input.provider,
    input.subject,
    input.subjectStandard,
    input.displayName,
    input.avatarUrl,
    now,
  );

  return userId;
}

/**
 * 为用户创建会话。
 *
 * @param userId 用户 id。
 * @returns 原始会话令牌（仅此一次可见，库里只存哈希）。
 */
export function createSession(userId: number): string {
  const token = randomToken(32);
  const now = nowSeconds();

  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), userId, now, now + SESSION_TTL_SECONDS);

  return token;
}

/**
 * 用会话令牌取用户。
 *
 * @param token 原始令牌。
 * @returns 用户信息，无效或过期时返回 `null`。
 */
export function getSessionUser(token: string): UserRow | null {
  const row = db
    .prepare(
      `SELECT u.id, u.display_name, u.avatar_url, u.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as
    | { id: number; display_name: string | null; avatar_url: string | null; created_at: number; expires_at: number }
    | undefined;

  if (!row) return null;

  if (row.expires_at < nowSeconds()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }

  return {
    id: row.id,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    created_at: row.created_at,
  };
}

/**
 * 注销会话。
 *
 * @param token 原始令牌。
 */
export function deleteSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/**
 * 查询用户已绑定的所有渠道。
 *
 * @param userId 用户 id。
 * @returns 渠道与标识符列表（不含任何令牌）。
 */
export function listIdentities(userId: number): Array<{ provider: string; subjectStandard: string }> {
  return db
    .prepare('SELECT provider, subject_standard AS subjectStandard FROM identities WHERE user_id = ?')
    .all(userId) as Array<{ provider: string; subjectStandard: string }>;
}

/**
 * 登录发起的滑动窗口频率限制。
 *
 * @param ip 客户端 IP。
 * @param provider 渠道名。
 * @param limit 窗口内允许的次数。
 * @param windowSeconds 窗口长度。
 * @returns 允许时返回 `true`。
 */
export function allowAuthAttempt(ip: string, provider: string, limit = 20, windowSeconds = 60): boolean {
  const since = nowSeconds() - windowSeconds;

  const row = db
    .prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND created_at > ?')
    .get(ip, since) as { n: number };

  if (row.n >= limit) return false;

  db.prepare('INSERT INTO auth_attempts (ip, provider, created_at) VALUES (?, ?, ?)').run(
    ip,
    provider,
    nowSeconds(),
  );

  // 顺手清理过期记录，避免表无限增长。
  db.prepare('DELETE FROM auth_attempts WHERE created_at < ?').run(nowSeconds() - 3600);

  return true;
}

/**
 * 清理过期的 state 与会话。
 */
export function cleanupExpired(): void {
  const now = nowSeconds();
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}

/**
 * 关闭数据库连接。
 *
 * 测试在清理临时数据库文件前必须调用 —— Windows 不允许删除仍被打开的文件，
 * 不关闭会得到 `EPERM`。Linux 上没这个问题，因此这个失败只在 Windows 暴露。
 */
export function closeDb(): void {
  db.close();
}
