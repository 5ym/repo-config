// forgejo-settings.json を Forgejo(fj.doany.io)に当てる。違うものだけ直し、何を直したかを出す。
// `bun forgejo-settings.ts`。依存は無い。
// 環境変数: FORGEJO_TOKEN(組織とリポジトリの書き込み。CI では GitHub の OIDC の JWT、手元ではトークン)、各 webhook の url_secret の名前の変数。DRY_RUN=true なら読むだけ
import { appendFileSync } from "node:fs";

type Json = Record<string, any>;
const cfg: Json = await Bun.file(new URL("./forgejo-settings.json", import.meta.url)).json();
const H: string = cfg.host;
const ORG: string = cfg.org;
const TOKEN = process.env.FORGEJO_TOKEN;
if (!TOKEN) throw new Error("FORGEJO_TOKEN が無い");
const DRY = process.env.DRY_RUN === "true";
const changed: string[] = [];
const failed: string[] = [];

async function api(method: string, path: string, body?: unknown): Promise<[number, any]> {
  const res = await fetch(`${H}/api/v1${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) return [res.status, text.slice(0, 300)];
  return [res.status, text ? JSON.parse(text) : null];
}

async function apply(what: string, method: string, path: string, body?: unknown) {
  if (DRY) {
    changed.push(`(dry) ${what}`);
    return;
  }
  const [st, res] = await api(method, path, body);
  if (st < 300) changed.push(what);
  else failed.push(`${what} → ${st} ${res}`);
}

// JSON として同じか (Python の == と同じく、配列・オブジェクトの中まで比べる)
const same = (a: unknown, b: unknown) => Bun.deepEquals(a, b);
const diff = (have: Json, want: Json): Json =>
  Object.fromEntries(Object.entries(want).filter(([k, v]) => !same(have[k], v)));
const show = (o: unknown) => JSON.stringify(o);
const fail = (msg: string): never => {
  console.log(`::error::${msg}`);
  process.exit(1);
};

// 1. リポジトリのマージの設定(アーカイブ済みは除く)
const repos: Json[] = [];
for (let page = 1; ; page++) {
  const [st, res] = await api("GET", `/orgs/${ORG}/repos?limit=50&page=${page}`);
  if (st !== 200) fail(`repos: ${st} ${res}`);
  repos.push(...res);
  if (res.length < 50) break;
}
for (const r of repos) {
  if (r.archived) continue;
  const d = diff(r, cfg.repo);
  if (Object.keys(d).length) await apply(`${r.full_name}: ${show(d)}`, "PATCH", `/repos/${r.full_name}`, d);
}

const ruleName = (p: Json) => p.rule_name || p.branch_name;

// 2. ブランチの保護(書いてある規則だけ。書いていない規則は消さない)
for (const [repo, rules] of Object.entries<Json[]>(cfg.branch_protections)) {
  const [st, have] = await api("GET", `/repos/${ORG}/${repo}/branch_protections`);
  if (st !== 200) {
    failed.push(`${repo} protections: ${st} ${have}`);
    continue;
  }
  const byName = new Map<string, Json>(have.map((p: Json) => [ruleName(p), p]));
  for (const rule of rules) {
    const cur = byName.get(rule.rule_name);
    if (!cur) {
      await apply(`${repo}: 保護 ${rule.rule_name} を作る`, "POST", `/repos/${ORG}/${repo}/branch_protections`, rule);
      continue;
    }
    const { rule_name: _, ...want } = rule;
    const d = diff(cur, want);
    if (Object.keys(d).length)
      await apply(`${repo}: 保護 ${rule.rule_name} ${show(d)}`, "PATCH", `/repos/${ORG}/${repo}/branch_protections/${rule.rule_name}`, d);
  }
}

// 2b. 消す保護(branch_protections_remove に名前を書いたものだけ。あれば消す)
for (const [repo, names] of Object.entries<string[]>(cfg.branch_protections_remove ?? {})) {
  const [st, have] = await api("GET", `/repos/${ORG}/${repo}/branch_protections`);
  if (st !== 200) {
    failed.push(`${repo} protections: ${st} ${have}`);
    continue;
  }
  const present = new Set(have.map(ruleName));
  for (const name of names) {
    if (present.has(name)) await apply(`${repo}: 保護 ${name} を消す`, "DELETE", `/repos/${ORG}/${repo}/branch_protections/${name}`);
  }
}

// 3. 組織の webhook(**種類ごとに 1 本**の前提で、種類で見分ける。同じ種類を手で足すと上書きされる。書いていない webhook は消さない)
const [hst, hooks] = await api("GET", `/orgs/${ORG}/hooks`);
if (hst !== 200) fail(`hooks: ${hst} ${hooks}`);
for (const w of cfg.org_webhooks as Json[]) {
  // URL を secrets から取るものは、空なら止める(空の URL で PATCH すると本番の webhook の URL が消える)
  const url: string = "url_secret" in w ? (process.env[w.url_secret] ?? "") : w.url;
  if (!url) {
    failed.push(`webhook ${w.name}: secrets の ${w.url_secret} が空なので触らない`);
    continue;
  }
  const wantCfg = { ...w.config, url };
  const body = { type: w.type, config: wantCfg, events: w.events, active: true, branch_filter: w.branch_filter };
  const cur = (hooks as Json[]).find((h) => h.type === w.type);
  if (!cur) {
    await apply(`webhook ${w.name} を作る`, "POST", `/orgs/${ORG}/hooks`, body);
    continue;
  }
  const need =
    cur.active !== true ||
    !same([...(cur.events ?? [])].sort(), [...w.events].sort()) ||
    (cur.branch_filter ?? "") !== w.branch_filter ||
    Object.entries(wantCfg).some(([k, v]) => !same(cur.config?.[k], v));
  if (need) {
    const shown = {
      active: cur.active,
      events: cur.events,
      branch_filter: cur.branch_filter,
      config: Object.fromEntries(
        Object.entries<unknown>(cur.config ?? {}).map(([k, v]) => [k, k === "url" && "url_secret" in w ? "(secret)" : v]),
      ),
    };
    const { type: _, ...patch } = body;
    await apply(`webhook ${w.name} を直す(今: ${show(shown)})`, "PATCH", `/orgs/${ORG}/hooks/${cur.id}`, patch);
  }
}

for (const c of changed) console.log(`::notice::${c}`);
for (const f of failed) console.log(`::error::${f}`);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) appendFileSync(summary, `Forgejo: ${changed.length} 件を直した、${failed.length} 件は失敗\n`);
process.exit(failed.length ? 1 : 0);
