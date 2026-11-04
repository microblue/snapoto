import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import path from "node:path";
export const root = path.resolve(process.env.DATA_DIR || "data");
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(path.join(root, "assets"), { recursive: true, mode: 0o700 });
const keyPath = path.join(root, "key");
if (!existsSync(keyPath))
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
const key = readFileSync(keyPath);
export const db = new DatabaseSync(path.join(root, "snapoto.db"));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,settings TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS members(space_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(space_id,user_id));
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS record_space_kind ON records(space_id,kind);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,capture_id TEXT NOT NULL,rule_id TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(capture_id,rule_id));
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
`);
export const id = () => randomBytes(16).toString("hex");
export const hash = (b) => createHash("sha256").update(b).digest("hex");
export const now = () => new Date().toISOString();
export function put(space, kind, body, rid = id()) {
  const prev = get(rid);
  const value = {
    ...body,
    id: rid,
    space_id: space,
    created_at: prev?.created_at || now(),
  };
  db.prepare(
    "INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
  ).run(rid, space, kind, JSON.stringify(value), value.created_at);
  return value;
}
export function get(rid) {
  const r = db.prepare("SELECT body FROM records WHERE id=?").get(rid);
  return r ? JSON.parse(r.body) : null;
}
export function list(space, kind) {
  return db
    .prepare(
      "SELECT body FROM records WHERE space_id=? AND kind=? ORDER BY created_at DESC",
    )
    .all(space, kind)
    .map((r) => JSON.parse(r.body));
}
export function audit(space, actor, event, details = {}) {
  return put(space, "audit", { actor, event, details });
}
export function encrypt(value) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  const b = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), b]).toString("base64");
}
export function decrypt(value) {
  const b = Buffer.from(value, "base64"),
    c = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  c.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(),
  );
}
