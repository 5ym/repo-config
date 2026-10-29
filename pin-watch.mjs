// pin-watch.json の確かめを 1 つずつ流し、外せるようになったものを JSON で出す (issue を立てるのは pin-watch.yml)。
// 依存は semver だけ (npm の範囲の判定を自前で書かない)。確かめに失敗したものは「外せない」ではなく error として出す
import { readFileSync } from "node:fs";
import semver from "semver";

const { watches } = JSON.parse(readFileSync(new URL("./pin-watch.json", import.meta.url), "utf8"));

// 相手が応答しないときに job を止めない
const get = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) });

const json = async (url) => {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
};

const checks = {
  // 最新の版の peerDependencies が、その版を受け付けるか
  async "npm-peer"({ package: name, peer, version }) {
    const latest = await json(`https://registry.npmjs.org/${name}/latest`);
    const range = latest.peerDependencies?.[peer];
    if (!range) return { ok: false, detail: `${name}@${latest.version} に peerDependencies.${peer} が無い` };
    return { ok: semver.satisfies(version, range), detail: `${name}@${latest.version} の ${peer} は ${range}` };
  },
  // その版以上の正式版 (プレリリースでない) が出ているか
  async "npm-stable"({ package: name, version }) {
    const doc = await json(`https://registry.npmjs.org/${name}`);
    const stable = Object.keys(doc.versions).filter((v) => !semver.prerelease(v) && semver.gte(v, version));
    return { ok: stable.length > 0, detail: stable.length ? `正式版 ${semver.rsort(stable)[0]}` : `${version} 以上の正式版は無い (latest: ${doc["dist-tags"].latest})` };
  },
  // .NET のチャネルが正式リリース (active) になったか
  async "dotnet-ga"({ channel }) {
    const index = await json("https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json");
    const c = index["releases-index"].find((r) => r["channel-version"] === channel);
    if (!c) return { ok: false, detail: `${channel} はまだ一覧に無い` };
    return { ok: c["support-phase"] === "active", detail: `${channel}: ${c["support-phase"]} (${c["latest-release"]})` };
  },
  // ページの文言が変わったか (動作環境の表など)
  // marker はその表が読めている目印で、無ければ作りが変わったとみて error にする (作り替えを対応と取り違えない)
  async "page-text-gone"({ url, text, marker }) {
    const res = await get(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const body = (await res.text()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    if (!body.includes(marker)) throw new Error(`${url} に目印「${marker}」が無い (ページの作りが変わった)`);
    return { ok: !body.includes(text), detail: body.includes(text) ? `まだ「${text}」` : `「${text}」が無くなった` };
  },
};

const results = [];
for (const w of watches) {
  try {
    results.push({ ...w, ...(await checks[w.check.type](w.check)) });
  } catch (e) {
    results.push({ ...w, ok: false, error: String(e.message ?? e) });
  }
}
for (const r of results) console.error(`${r.ok ? "外せる" : r.error ? "失敗" : "まだ"}\t${r.id}\t${r.error ?? r.detail}`);
console.log(JSON.stringify(results));
