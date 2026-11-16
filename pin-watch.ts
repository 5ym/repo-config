// pin-watch.json の確かめを 1 つずつ流し、外せるようになったものを JSON で出す (issue を立てるのは pin-watch.yml)。
// `bun pin-watch.ts`。依存は無い (版の範囲の判定は Bun.semver を使い、自前で書かない)。
// 確かめに失敗したものは「外せない」ではなく error として出す
type Json = Record<string, any>;
type Result = { ok: boolean; detail: string };

const { watches }: { watches: Json[] } = await Bun.file(new URL("./pin-watch.json", import.meta.url)).json();

// 相手が応答しないときに job を止めない
const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(30_000) });

const json = async (url: string): Promise<any> => {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
};

// semver として読める版だけを比べる (読めない版を Bun.semver.order に渡すと、等しいとみなされうる)
const SEMVER = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const isVersion = (v: string) => SEMVER.test(v);
// プレリリースは「-」から「+」(ビルドの付記) の手前まで。付記の中の「-」はプレリリースではない
const isPrerelease = (v: string) => SEMVER.exec(v)?.[1] !== undefined;
const newestFirst = (a: string, b: string) => Bun.semver.order(b, a);

const checks: Record<string, (c: Json) => Promise<Result>> = {
  // 最新の版の peerDependencies が、その版を受け付けるか
  async "npm-peer"({ package: name, peer, version }) {
    const latest = await json(`https://registry.npmjs.org/${name}/latest`);
    const range: string | undefined = latest.peerDependencies?.[peer];
    if (!range) return { ok: false, detail: `${name}@${latest.version} に peerDependencies.${peer} が無い` };
    return { ok: Bun.semver.satisfies(version, range), detail: `${name}@${latest.version} の ${peer} は ${range}` };
  },
  // その版以上の正式版 (プレリリースでない) が出ているか
  async "npm-stable"({ package: name, version }) {
    if (!isVersion(version)) throw new Error(`pin-watch.json の版 ${version} が semver ではない`);
    const doc = await json(`https://registry.npmjs.org/${name}`);
    const stable = Object.keys(doc.versions)
      .filter((v) => isVersion(v) && !isPrerelease(v) && Bun.semver.order(v, version) >= 0)
      .sort(newestFirst);
    return {
      ok: stable.length > 0,
      detail: stable.length ? `正式版 ${stable[0]}` : `${version} 以上の正式版は無い (latest: ${doc["dist-tags"].latest})`,
    };
  },
  // .NET のチャネルが正式リリース (active) になったか
  async "dotnet-ga"({ channel }) {
    const index = await json("https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json");
    const c = index["releases-index"].find((r: Json) => r["channel-version"] === channel);
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

const results: Json[] = [];
for (const w of watches) {
  try {
    const check = checks[w.check.type];
    if (!check) throw new Error(`確かめ方 ${w.check.type} は無い`);
    results.push({ ...w, ...(await check(w.check)) });
  } catch (e) {
    results.push({ ...w, ok: false, error: String((e as Error).message ?? e) });
  }
}
for (const r of results) console.error(`${r.ok ? "外せる" : r.error ? "失敗" : "まだ"}\t${r.id}\t${r.error ?? r.detail}`);
console.log(JSON.stringify(results));
