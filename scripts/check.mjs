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

// --- 5. 非公開であるべき追跡ファイルが、Pages に配信されない状態か ------------
// GitHub Pages は「アップロードされた成果物」を配信する。ワークフローが
// path: '.' でリポジトリ全体を上げていると、運用内規もサーバコードも
// 独自ドメインに出る。2026-08-10、https://tokyokyodo.com/CLAUDE.md が 200 で
// 応答することを実測した(失敗リスト No.19)。上の 4. は「追跡されていないこと」
// しか見ておらず、「追跡はするが配信はしない」ファイルを守れていなかった。
const WORKFLOW = ".github/workflows/static.yml";
const STAGER = "scripts/stage-pages.mjs";

if (!trackedAll.has(WORKFLOW)) {
  errors.push(`${WORKFLOW} が git 管理下にありません。Pages への配信内容を検査できません`);
} else if (!trackedAll.has(STAGER)) {
  errors.push(`${STAGER} が git 管理下にありません。ワークフローが実行時に失敗します`);
} else {
  const wf = readFile(WORKFLOW);
  const pathLine = wf.match(/uses:\s*actions\/upload-pages-artifact@[^\n]*\n[\s\S]*?path:\s*'([^']+)'/);
  if (!pathLine) {
    // 解析できないときは通さない（fail-closed）。
    fail(`${WORKFLOW} の upload-pages-artifact の path を解析できませんでした。配信範囲が確認できないため止めます`);
  }
  if (pathLine[1] === ".") {
    errors.push(`${WORKFLOW} がリポジトリ全体(path: '.')を Pages に上げています。運用内規やサーバコードが ${EXPECTED_DOMAIN} で配信されます`);
  } else if (pathLine[1] !== "_pages") {
    errors.push(`${WORKFLOW} が Pages に上げる path が '${pathLine[1]}' です。'_pages'（${STAGER} が組み立てる場所）であるべきです`);
  }
  // ステージング処理が実際に走ることを確認する。ここが消えると _pages が
  // 空のままアップロードされ、サイトが壊れる。コメント行は数えない。
  const body = wf.replace(/^\s*#.*$/gm, "");
  if (!new RegExp(`run:\\s*node\\s+${STAGER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(body)) {
    errors.push(`${WORKFLOW} が ${STAGER} を実行していません。配信範囲が制御されません`);
  }
}

// GitHub Pages の Source は GitHub の Web UI 設定であり、ワークフローからは
// 制御できない（公式doc「GitHub Pages does not associate a specific workflow
// to the GitHub Pages settings」）。Source を "Deploy from a branch" に戻すと、
// ここまでの検査をすべて素通りしてリポジトリ全ファイルが配信される。
// **この検査では検出できない。** push 後に実 URL を叩いて確認すること。

// --- 6. ステージングが実際に成功するか ----------------------------------------
// 5. はワークフローの「記述」しか見ていない。server.js の許可リストが壊れて
// stage-pages.mjs が落ちる状態でも 5. は通ってしまう。ここで実際に走らせる。
// Actions 上で初めて失敗する状態を、push 前に検出する。
if (trackedAll.has(STAGER)) {
  try {
    execFileSync("node", [STAGER], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const detail = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim();
    errors.push(`${STAGER} が失敗します（Actions 上でデプロイが落ちます）:\n    ${detail.split("\n").join("\n    ")}`);
  }
}

// --- 7. 配信されるが、どのページからも参照されていないファイル ----------------
// `allowedDirs` はディレクトリ単位の許可なので、images/ に置いたものは
// どのページからも参照されていなくても配信される。2026-08-10、掲載対象でない
// 制作用ファイルがこの経路で配信されていたことが判明した(失敗リスト No.19)。
// 発見の手がかりは「参照0件」だった。手作業の棚卸しは次回は行われないので、
// 機械に毎回数えさせる。
// 参照0件でも将来使う予定の素材はありうるため、止めずに警告にとどめる。
const warnings = [];
const htmlBodies = publicHtml.map((f) => readFile(f)).join("\n") + readFile("sitemap.xml");
const dirFiles = [...trackedAll].filter((f) => allowedDirs.some((d) => `/${f}`.startsWith(d)));
// 照合はベース名ではなく相対パス全体で行う。ベース名だと部分文字列で誤って
// 一致する——例えば images/hero.jpg は images/hd/band-hero.jpg の一部として
// 「参照あり」と誤判定される。実際にこの誤りで4件を見落としかけた。
const unreferenced = dirFiles.filter((f) => !htmlBodies.includes(f));
if (unreferenced.length) {
  warnings.push(
    `どのページからも参照されていないのに ${EXPECTED_DOMAIN} で配信されるファイルが ${unreferenced.length}件あります。` +
    `公開して差し支えないか確認してください:\n    ${unreferenced.join("\n    ")}`
  );
}

// --- 結果 --------------------------------------------------------------------
for (const w of warnings) console.warn(`[警告] ${w}`);
for (const e of errors) console.error(`[エラー] ${e}`);

if (errors.length) {
  console.error(`\n${errors.length}件のエラーがあります。修正してから push してください。`);
  process.exit(1);
}
console.log(`チェック完了：問題なし（公開ファイル ${publicFiles.length}件・うちHTML ${publicHtml.length}件を検査）`);
