// GitHub Pages に上げるファイルを _pages/ に組み立てる。
// 実行: node scripts/stage-pages.mjs   （問題があれば終了コード 1）
//
// 【なぜこれが要るか】
// GitHub Pages は「アップロードされた成果物」をそのまま配信する。ワークフローが
// path: '.' でリポジトリ全体を上げていたため、2026-08-10 の時点で
// https://tokyokyodo.com/CLAUDE.md が 200 を返していた（失敗リスト No.19）。
//
// 【なぜ除外方式(denylist)ではないのか】
// 「公開してはいけないもの」を列挙する方式は、新しいファイルを足した瞬間に
// 自動で公開される fail-open である。ここでは server.js の allowedFiles /
// allowedDirs を唯一の正本とし、そこに載っているものだけを配る fail-closed に
// する。Railway(server.js) と GitHub Pages で公開範囲がズレることも同時に消える。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "_pages");

const fail = (msg) => {
  console.error(`[エラー] ${msg}`);
  process.exit(1);
};

// server.js の許可リストを読む。解析できなければ止める（fail-closed）。
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const filesBlock = server.match(/const allowedFiles = new Set\(\[([\s\S]*?)\]\)/);
const dirsBlock = server.match(/const allowedDirs = \[([\s\S]*?)\]/);
if (!filesBlock) fail("server.js の allowedFiles を解析できませんでした");
if (!dirsBlock) fail("server.js の allowedDirs を解析できませんでした");

const allowedFiles = [...filesBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/^\//, ""));
const allowedDirs = [...dirsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/^\//, ""));

// server.js は Railway 用であり、GitHub Pages の動作に必要な2ファイルを知らない。
// ここで明示的に足す。欠けると Jekyll 処理でビルドが落ち、独自ドメインも外れる。
const PAGES_ONLY = [".nojekyll", "CNAME"];

// git 管理下のファイルだけを対象にする。runner 上の未追跡ファイルを配らないため。
const tracked = new Set(
  execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "-z"], {
    cwd: root, encoding: "utf8",
  }).split("\0").filter(Boolean)
);

const copy = (rel) => {
  // 追跡されていないファイルは配らない。runner 上には追跡ファイルしか無いが、
  // ローカル実行時に未追跡の下書きを紛れ込ませないための歯止めでもある。
  if (!tracked.has(rel)) fail(`配信対象 ${rel} が git 管理下にありません`);
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) fail(`配信対象 ${rel} が見つかりません`);
  const dst = path.join(dest, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
};

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const staged = [];
for (const rel of [...allowedFiles, ...PAGES_ONLY]) {
  copy(rel);
  staged.push(rel);
}
// ディレクトリ許可は接頭辞一致。git 管理下のものだけを配る。
for (const dir of allowedDirs) {
  for (const rel of tracked) {
    if (rel.startsWith(dir)) {
      copy(rel);
      staged.push(rel);
    }
  }
}

// --- 表明 ------------------------------------------------------------------
// 除外し過ぎて壊れた状態、逆に非公開物が紛れ込んだ状態を、どちらもデプロイしない。
for (const required of ["index.html", "privacy.html", "CNAME", ".nojekyll", "robots.txt", "sitemap.xml"]) {
  if (!fs.existsSync(path.join(dest, required))) fail(`必須ファイルが _pages にありません: ${required}`);
}
for (const forbidden of ["CLAUDE.md", "server.js", "package.json", "package-lock.json", "scripts", ".github", ".git", ".claude"]) {
  if (fs.existsSync(path.join(dest, forbidden))) fail(`非公開ファイルが _pages に含まれています: ${forbidden}`);
}
if (fs.readFileSync(path.join(dest, "CNAME"), "utf8").trim() !== "tokyokyodo.com") {
  fail("_pages/CNAME の内容が tokyokyodo.com ではありません。独自ドメインが外れます");
}

console.log("--- _pages に配置したファイル ---");
for (const f of staged.sort()) console.log(f);
console.log(`ステージング完了：${staged.length}件（server.js の許可リストが正本）`);
