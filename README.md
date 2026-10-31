# repo-config

danything と 5ym の**全リポジトリの git の運用の共通設定**(2026-10-07 に 5ym/renovate から改名)。

| 中身 | 在処 |
| --- | --- |
| 共有の Renovate プリセット | [default.json](default.json)(下の「使い方」) |
| Renovate を回す | danything/gitops の [apps/renovate/](https://github.com/danything/gitops/tree/main/apps/renovate)(k8s の CronJob。GitHub の danything・5ym と Forgejo の doa) |
| リポジトリの設定を揃える | [repo-settings.json](repo-settings.json) と [rulesets.json](rulesets.json)(既定のブランチの削除と force push を止める。必須のチェックは各リポジトリのルールセットで持つ)を [.github/workflows/repo-settings.yml](.github/workflows/repo-settings.yml) が毎日と変更時に全リポジトリへ当てる(GitHub App doa-repo-settings。Administration の書き込みだけ) |
| セキュリティの機能をオンにする | [security-settings.json](security-settings.json) と同じ workflow の `security` の段。公開リポジトリで無料のもの(シークレットの検出と push の保護、Dependabot のアラート、脆弱性の非公開の報告、fork 以外の CodeQL の default setup)をオンにする。自分の CodeQL の workflow(`github/codeql-action/analyze` を使うか、下の codeql.yml を呼ぶ advanced setup)を持つリポジトリでは default setup をオンにしない(同時には使えない)。.NET を持つのに codeql.yml を呼んでいないリポジトリは知らせるだけ。オフには戻さない。直す PR は Renovate が出すので、Dependabot の security updates には触らない |
| C# をビルドして CodeQL で解析する | [.github/workflows/codeql.yml](.github/workflows/codeql.yml)(各リポジトリから `uses: 5ym/repo-config/.github/workflows/codeql.yml@main` で呼ぶ。default setup は C# をビルドせずに解析して品質の警告が出るので、.NET のリポジトリはこちらを使い、default setup を切る。呼び方はファイルの先頭) |

### リポジトリの設定

ブランチの更新の提案・自動マージ・マージ後のブランチ削除をオン、マージは squash だけ。新しいリポジトリも次の実行で揃い、
手で変えても戻る。変えたいときは repo-settings.json を直す(項目は GitHub の `PATCH /repos/{owner}/{repo}` の名前)。
Renovate の自動マージ(`platformAutomerge`)は、リポジトリで自動マージが許可されていないと十分に働かない。

## 使い方

各リポジトリの `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>5ym/repo-config"]
}
```

## 設定内容

| まとまり | 自動マージ | ラベル | 中身 |
| --- | --- | --- | --- |
| `all dependencies` | する | | メジャー以外の全部 (Helm の chart も含む)。小さくて頻繁で、タグを戻せば済む |
| `major dependencies` | **しない** | `needs-review` | メジャー。とくにデータベースはタグを差し替えるだけでは上がらない(PostgreSQL は別メジャーが書いたデータディレクトリでは起動を拒否する) |

### `needs-review` ラベル

各リポジトリの Claude レビュー(`.github/workflows/claude-code-review.yml`)は既定で bot の PR を
飛ばす。**自分でマージされる PR をレビューしても誰も読まないから**で、それは正しい。
一方、人を待つ PR はレビューする価値がある。そこで自動マージしないまとまりにだけ
このラベルを付けて、workflow 側で

```yaml
!endsWith(github.event.pull_request.user.login, '[bot]') ||
contains(github.event.pull_request.labels.*.name, 'needs-review')
```

と拾えるようにしてある。

ほかに `reviewers: ["5ym"]` で PR のレビュワーを指定します。**自動マージする PR にも付ける**
(`assignAutomerge: true`。Renovate の既定では自動マージの PR にはレビュワーが付かない)。

### TypeScript は 7 未満

svelte-check が TypeScript 6 と 7 を並べて要る(7 は `@typescript/native` の別名で読む)ので、`typescript` を 7 に
上げると `bun run check` が起動しなくなる。7 つのリポジトリで同じ規則を書いていたのをここにまとめた。
もっと厳しく止めたいリポジトリ(denpa の `<6`)は自分の規則を持つ(後から読まれるほうが勝つ)。

### .NET は正式版が出るまで上げない

`mcr.microsoft.com/dotnet/sdk:11.0` のような major のタグは、2月の最初のプレビューから11月の正式版までプレビューを指す。
タグにプレビューの印が無いので Renovate には見分けられず、プレビューでもビルドは通るので CI も緑のまま
(danything/denpa-hub #4、2026-10-31)。そこで、正式版の major にいるリポジトリは上限 (`<11`) より上に上げない。
わざとプレビューを使っているリポジトリ (いまの版が上限以上。aizuchi・mado の 11.0) には効かず、digest の更新はそのまま届く。
**毎年、正式版が出たら上限をここで 1 つ上げる** (各リポジトリの TargetFramework も一緒に上げる)。出たことは pin-watch の `dotnet-11-ga` が issue で知らせる (下の「固定を外す見張り」。上げたら次の版の項目に書き換える)。

### バージョン範囲は `bump`

`rangeStrategy: "bump"` で、範囲内の更新でも `package.json` の指定ごと上げる(`^5.39.8` → `^5.57.1`)。
既定のようにロックファイルだけを書き換える更新は **`bun.lock` では Renovate が行えず**、
範囲内のセキュリティ修正の PR が適用されないまま閉じられていた(danything/blog #38〜#40)。

`peerDependencies` だけは `widen`(`^5.0.0` → `^5.0.0 || ^6.0.0`)。ライブラリが対応範囲として
公開している値なので、最新に引き上げると利用者全員に更新を強いることになる。

### 自動マージの前提

`platformAutomerge` を使うため、対象リポジトリ側で **Settings → General → Allow auto-merge** を有効にしておく必要があります。

## Renovate を回す(self-hosted)

GitHub の `danything`・`5ym` と Forgejo(fj.doany.io)の `doa` は、danything/gitops の [apps/renovate/](https://github.com/danything/gitops/tree/main/apps/renovate) の CronJob が 15 分おきに回す(2026-10-16 から。それまではこのリポジトリの GitHub Actions と doa/renovate の Forgejo Actions だった)。クラスタが止まっているあいだは Renovate も止まる(更新先のサーバも止まっているので、予備は置かない)。

- GitHub App [doa-renovate](https://github.com/apps/doa-renovate)(持ち主は danything)を danything と 5ym に入れてある
- App の秘密鍵は Infisical の `/renovate/renovate-secrets`。client ID などはマニフェストに書いてある(apps/renovate/README.md)
- `renovate.json` の無いリポジトリには、上の `renovate.json` を足す onboarding の PR が出る。マージするまでそのリポジトリでは依存の PR は出ない(要らなければ PR を閉じれば以後出ない)

## 固定を外す見張り (pin-watch)

Renovate の規則などで版を留めているもののうち、**相手が対応したら外すもの**を [pin-watch.json](pin-watch.json) に書いておくと、
[.github/workflows/pin-watch.yml](.github/workflows/pin-watch.yml) が毎週 (月曜 9:17) 確かめ、外せるようになったらこのリポジトリに issue を立てる (5ym に割り当て)。
固定だけして放置しないため。確かめ方は 4 種類 ([pin-watch.mjs](pin-watch.mjs)):

| type | 外せる条件 |
| --- | --- |
| `npm-peer` | 最新の版の `peerDependencies` がその版を受け付ける (astro check・svelte-check の TypeScript など) |
| `npm-stable` | その版以上の正式版が出た (Blades 3.1.0) |
| `dotnet-ga` | .NET のチャネルが active になった |
| `page-text-gone` | ページから文言が消えた (MosP の動作環境の表) |

外したら pin-watch.json の項目も消す。**わざと留めているもの (人の作業が要る PostgreSQL のメジャーなど) は載せない。**
固定する前に、相手の宣言を毎回読む形にできないかを先に考える (gitops の renovate-validate は Renovate の engines から Node を決める)。
