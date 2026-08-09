// 公開前の自動チェック。記憶や注意力に頼らず、機械的に落とし穴を検出する。
// 実行: npm run check   （問題があれば終了コード 1）
//
// 判定はすべて「git が追跡しているか」で行う。ローカルにあるだけのファイルは
// 公開されず、逆に追跡から外れたファイルはローカルに残っていても公開されないため。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const fail = (msg) => {
  console.error(`[エラー] ${msg}`);
  process.exit(1);
};

// git ls-files を安全に呼ぶ。
// -c core.quotePath=false と -z で、日本語ファイル名のクォート・8進エスケープ・
// 改行を含む名前をすべて回避する。
const lsFiles = (...pathspec) => {
  let out;
  try {
    out = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "ls-files", "-z", "--", ...pathspec],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch {
    fail("git を実行できませんでした（未インストール、またはgitリポジトリの外で実行しています）");
  }
  return out.split("\0").filter(Boolean);
};

const readFile = (p) => {
  try {
    return fs.readFileSync(path.join(root, p), "utf8");
  } catch {
    fail(`${p} を読めません。削除・改名されていないか確認してください`);
  }
};

// --- 1. GitHub Pages の動作に必須のファイルが「追跡されているか」 -------------
// ディスク上の存在ではなく追跡状況を見る。git rm --cached された場合、
// ローカルにファイルは残るため、存在チェックでは見逃す。
const tracked = new Set(lsFiles(".nojekyll", "CNAME"));
if (!tracked.has(".nojekyll")) {
  errors.push(".nojekyll が git 管理下にありません。GitHub Pages の Jekyll 処理でビルドが落ち、更新が反映されなくなります");
}
if (!tracked.has("CNAME")) {
  errors.push("CNAME が git 管理下にありません。独自ドメインの設定が外れます");
}

// CNAME の中身も検証する（書き換わればドメインが外れるため）。
const EXPECTED_DOMAIN = "tokyokyodo.com";
if (tracked.has("CNAME")) {
  const cname = readFile("CNAME").trim();
  if (cname !== EXPECTED_DOMAIN) {
    errors.push(`CNAME の内容が「${cname}」です。「${EXPECTED_DOMAIN}」であるべきです`);
  }
}

// --- 2. 公開ファイルが server.js のホワイトリストに載っているか ---------------
// 載せ忘れると GitHub Pages では見えるのに Railway 側だけ 404 になる。
const server = readFile("server.js");

// allowedFiles / allowedDirs のブロックだけを解析する。
// server.js の他の場所にある "/..." 文字列（リダイレクト先やHTML断片）を
// 誤って許可リストとして拾わないようにする。解析できなければ止める（fail-closed）。
const filesBlock = server.match(/const allowedFiles = new Set\(\[([\s\S]*?)\]\)/);
const dirsBlock = server.match(/const allowedDirs = \[([\s\S]*?)\]/);
if (!filesBlock) fail("server.js の allowedFiles ブロックを解析できませんでした。server.js の書き方が変わっていないか確認してください");
if (!dirsBlock) fail("server.js の allowedDirs ブロックを解析できませんでした");

const allowedFiles = new Set([...filesBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const allowedDirs = [...dirsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// 配信対象になりうる公開ファイル（画像はディレクトリ単位で許可済みなので除く）。
const publicFiles = lsFiles("*.html", "*.css", "*.js", "*.txt", "*.xml", "*.ico")
  .filter((f) => !f.startsWith("scripts/"))
  .filter((f) => f !== "server.js");

const isAllowed = (f) =>
  allowedFiles.has(`/${f}`) || allowedDirs.some((d) => `/${f}`.startsWith(d));

for (const file of publicFiles) {
  if (!isAllowed(file)) {
    errors.push(`${file} が server.js のホワイトリストにありません（Railway側だけ404になります）`);
  }
}

// 逆方向：ホワイトリストにあるのに実体が無いエントリ（タイプミスの検出）。
const trackedAll = new Set(lsFiles());
for (const entry of allowedFiles) {
  const rel = entry.replace(/^\//, "");
  if (!trackedAll.has(rel)) {
    errors.push(`server.js の allowedFiles にある ${entry} が git 管理下にありません（綴り誤りの可能性）`);
  }
}

// --- 3. 公開HTMLが sitemap.xml の <loc> に載っているか ------------------------
// 単純な文字列一致だと "/" が必ず一致してしまうため、<loc> を抽出して完全一致で比較する。
const publicHtml = publicFiles.filter((f) => f.endsWith(".html"));
if (!trackedAll.has("sitemap.xml")) {
  errors.push("sitemap.xml が git 管理下にありません");
} else {
  const sitemap = readFile("sitemap.xml");
  const locs = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]);
  if (locs.length === 0) {
    errors.push("sitemap.xml に <loc> が1件もありません");
  }
  const paths = new Set();
  for (const loc of locs) {
    try {
      const u = new URL(loc);
      paths.add(u.pathname);
      if (u.hostname !== EXPECTED_DOMAIN) {
        errors.push(`sitemap.xml の ${loc} のドメインが ${EXPECTED_DOMAIN} と異なります`);
      }
    } catch {
      errors.push(`sitemap.xml の <loc> が URL として不正です: ${loc}`);
    }
  }
  for (const file of publicHtml) {
    // Google 所有権確認ファイルは sitemap に載せる必要がない。
    if (/^google[0-9a-zA-Z]+\.html$/.test(file)) continue;
    const expected = file === "index.html" ? "/" : `/${file}`;
    if (!paths.has(expected)) {
      errors.push(`${file} が sitemap.xml に載っていません（検索エンジンに拾われません）`);
    }
  }
}

// --- 4. 公開してはいけないものが追跡されていないか ----------------------------
// GitHub Pages はリポジトリ内の全ファイルを配信する（server.js のホワイトリストは
// Railway 側にしか効かない）。追跡された時点で公開されると考えること。
const forbidden = lsFiles("*.env", "*.env.*", ".env*", "_backups", "*.pem", "*.key", "基準.md", "**/基準.md");
for (const f of forbidden) {
  errors.push(`${f} が公開リポジトリに追跡されています。ただちに追跡から外してください`);
}

// --- 結果 --------------------------------------------------------------------
for (const e of errors) console.error(`[エラー] ${e}`);

if (errors.length) {
  console.error(`\n${errors.length}件のエラーがあります。修正してから push してください。`);
  process.exit(1);
}
console.log(`チェック完了：問題なし（公開ファイル ${publicFiles.length}件・うちHTML ${publicHtml.length}件を検査）`);
