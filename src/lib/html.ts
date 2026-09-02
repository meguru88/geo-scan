import type { Aggregate, EngineScore } from './aggregate.js';
import type { Comparison } from './compare.js';
import type { Mark } from './score.js';
import type { Advice } from './suggest.js';
import { describeLocation } from '../providers/location.js';

/** HTML エスケープ */
function h(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** 日時はレポートの読者のタイムゾーン（既定 Asia/Tokyo、GEO_SCAN_TZ で変更）で表示し、ゾーン名を添える */
function fmtDateTime(iso: string | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const tz = process.env.GEO_SCAN_TZ?.trim() || 'Asia/Tokyo';
  try {
    const parts = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    const label = tz === 'Asia/Tokyo' ? 'JST' : tz;
    return `${parts} ${label}`;
  } catch {
    return d.toISOString();
  }
}

function markClass(m: Mark): string {
  return m === '○' ? 'mark-o' : m === '△' ? 'mark-d' : m === '×' ? 'mark-x' : 'mark-n';
}

function bar(value: number, max: number): string {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<div class="bar" aria-hidden="true"><span style="width:${w.toFixed(0)}%"></span></div>`;
}

function ranksText(ranks: number[]): string {
  return ranks.length ? ranks.map((r) => `${r}位`).join('・') : '';
}

function scoreRow(s: EngineScore | (Aggregate['overall'] & { label: string; model?: string; manual?: boolean; coveredQuestions?: number }), questionCount: number, strong = false): string {
  const tag = strong ? 'th' : 'td';
  const coverage = 'coveredQuestions' in s && typeof s.coveredQuestions === 'number' ? `${s.coveredQuestions}/${questionCount}` : '';
  return `<tr class="${strong ? 'row-total' : ''}">
    <${tag} scope="row">${h(s.label)}${'manual' in s && s.manual ? ' <span class="pill">手入力</span>' : ''}</${tag}>
    <td class="muted small">${h(s.model ?? '')}</td>
    <td class="num"><strong>${s.total.toFixed(1)}</strong>${bar(s.total, 100)}</td>
    <td class="num">${pct(s.mentionRate)} <span class="muted small">(${s.mentioned}/${s.answers})</span></td>
    <td class="num">${s.avgRank !== null ? s.avgRank.toFixed(1) + ' 位' : '-'}</td>
    <td class="num">${pct(s.citeRate)} <span class="muted small">(${s.cited}/${s.answers})</span></td>
    <td class="num">${s.answers}${s.errors ? ` <span class="muted small">(失敗 ${s.errors})</span>` : ''}</td>
    <td class="num">${coverage}</td>
  </tr>`;
}

const CSS = `
:root { --accent: #1f4a2e; --accent-soft: #e8efea; --ink: #1c1c1c; --muted: #6b6b6b; --faint: #a3a3a3; --line: #dcdcdc; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: var(--ink); }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif; font-size: 14px; line-height: 1.7; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { max-width: 820px; margin: 0 auto; padding: 28px 20px 48px; }
h1 { font-size: 30px; line-height: 1.3; margin: 8px 0 12px; color: var(--accent); }
h2 { font-size: 18px; margin: 0 0 12px; padding: 6px 0 6px 12px; border-left: 5px solid var(--accent); color: var(--accent); }
h3 { font-size: 15px; margin: 16px 0 6px; }
p { margin: 0 0 10px; }
section { margin: 0 0 34px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.num { text-align: right; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.brand { font-size: 13px; letter-spacing: .12em; color: var(--accent); font-weight: 700; text-transform: uppercase; }
.cover { padding: 12px 0 28px; border-bottom: 2px solid var(--accent); margin-bottom: 34px; }
.cover .meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; font-size: 13px; margin: 8px 0 18px; }
.cover .meta dt { color: var(--muted); }
.cover .meta dd { margin: 0; word-break: break-all; }
.score-hero { display: flex; align-items: flex-end; gap: 10px; margin: 6px 0 4px; }
.score-big { font-size: 84px; font-weight: 800; line-height: 1; color: var(--accent); letter-spacing: -.02em; }
.score-denom { font-size: 20px; color: var(--muted); padding-bottom: 12px; }
.score-label { font-size: 16px; font-weight: 700; margin-bottom: 8px; }
.summary { font-size: 16px; background: var(--accent-soft); padding: 12px 14px; border-radius: 6px; margin: 12px 0; }
.breakdown { display: flex; flex-wrap: wrap; gap: 10px 22px; font-size: 13px; color: var(--muted); }
.breakdown strong { color: var(--ink); font-size: 15px; }
.banner { background: #f3f3f3; border: 1px solid var(--line); padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-top: 14px; color: var(--muted); }
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
thead th { background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 12px; white-space: nowrap; }
tbody th { font-weight: 600; white-space: nowrap; }
.row-total th, .row-total td { border-top: 2px solid var(--accent); background: #f7faf8; }
.bar { height: 6px; background: #e9ece9; border-radius: 3px; overflow: hidden; margin-top: 4px; min-width: 80px; }
.bar > span { display: block; height: 100%; background: var(--accent); }
.wide { min-width: 560px; }
.qtable td.q { min-width: 230px; position: sticky; left: 0; background: #fff; box-shadow: 1px 0 0 var(--line); }
.qtable th.q { position: sticky; left: 0; background: var(--accent-soft); box-shadow: 1px 0 0 var(--line); }
.qtable .qno { display: inline-block; min-width: 1.6em; color: var(--muted); font-size: 12px; }
.qtable th.mark, .qtable td.mark { min-width: 72px; }
.qtable td.mark { text-align: center; font-size: 18px; line-height: 1.1; white-space: nowrap; }
.qtable td.mark .runs { display: block; font-size: 10px; color: var(--muted); font-weight: 400; }
.mark-o { color: var(--accent); font-weight: 800; }
.mark-d { color: var(--accent); font-weight: 400; opacity: .8; }
.mark-x { color: var(--faint); font-weight: 400; }
.mark-n { color: var(--faint); }
.legend { font-size: 12px; color: var(--muted); margin-top: 8px; }
.pill { display: inline-block; font-size: 10px; padding: 0 6px; border: 1px solid var(--accent); color: var(--accent); border-radius: 10px; margin-left: 4px; vertical-align: middle; }
.own { background: var(--accent-soft); font-weight: 700; }
.domain { min-width: 200px; overflow-wrap: anywhere; }
.engines { min-width: 240px; }
.cards { display: grid; gap: 12px; }
.card { border: 1px solid var(--line); border-left: 5px solid var(--accent); border-radius: 6px; padding: 12px 14px; }
.card h3 { margin: 0 0 6px; font-size: 15px; }
.card .lbl { display: inline-block; min-width: 4.5em; margin-right: 6px; color: var(--accent); font-weight: 700; font-size: 12px; }
.card p { margin: 2px 0; font-size: 13px; }
.method li { margin-bottom: 4px; font-size: 13px; }
.diff-up { color: var(--accent); font-weight: 700; }
.diff-down { color: var(--muted); font-weight: 700; }
footer { margin-top: 40px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 10px; }
@media (max-width: 600px) {
  .page { padding: 18px 14px 40px; }
  h1 { font-size: 24px; }
  .score-big { font-size: 64px; }
  .cover .meta { grid-template-columns: 1fr; }
  .cover .meta dt { margin-top: 6px; }
}
@media print {
  @page { size: A4 portrait; margin: 14mm 12mm; }
  body { font-size: 12px; }
  .page { max-width: none; padding: 0; }
  .cover { break-after: page; border-bottom: 0; }
  h2, h3 { break-after: avoid; }
  .card, .summary { break-inside: avoid; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  .table-wrap { overflow: visible; }
  .wide { min-width: 0; }
  .qtable td.q, .qtable th.q { position: static; box-shadow: none; min-width: 0; }
  .qtable th.mark, .qtable td.mark { min-width: 0; }
  a { color: inherit; text-decoration: none; }
}
`;

export function renderReport(agg: Aggregate, advice: Advice, comparison: Comparison | null): string {
  const o = agg.overall;
  const t = agg.target;
  const autoEngines = agg.byEngine.filter((e) => !e.manual);
  const manualEngines = agg.byEngine.filter((e) => e.manual);
  const runs = Math.max(0, ...autoEngines.map((e) => agg.runsPerEngine[e.engine] ?? 0));
  const top5 = agg.competitors.slice(0, 5);
  const top10 = agg.domains.slice(0, 10);
  const ownOutsideTop10 = agg.domains.findIndex((d) => d.isOwn) >= 10 ? agg.domains.findIndex((d) => d.isOwn) : -1;
  const qCount = agg.questions.length;
  const scanOk = agg.extractions.filter((x) => x.source === 'scan' && x.status === 'ok').length;
  const manualOk = agg.extractions.filter((x) => x.source === 'manual' && x.status === 'ok').length;

  const measuredText = [
    autoEngines.length ? `${autoEngines.length} エンジン × ${qCount} 問${runs > 1 ? ` × ${runs} 回` : ''} = ${agg.totals.scan} 件（有効 ${scanOk} 件）` : '',
    manualEngines.length ? `手入力 ${manualEngines.map((e) => e.label).join('・')} ${agg.totals.manual} 件（有効 ${manualOk} 件）` : '',
  ]
    .filter(Boolean)
    .join('、');

  const cover = `
<header class="cover">
  <div class="brand">AI検索 露出診断レポート</div>
  <h1>${h(t.name)}</h1>
  <dl class="meta">
    <dt>URL</dt><dd><a href="${h(t.url)}">${h(t.url)}</a></dd>
    <dt>地域</dt><dd>${h(t.area)}</dd>
    <dt>業種</dt><dd>${h(t.industry)}</dd>
    <dt>計測日</dt><dd>${h(agg.date)}${agg.meta?.startedAt ? `（${h(fmtDateTime(agg.meta.startedAt))} 〜 ${h(fmtDateTime(agg.meta.finishedAt))}）` : ''}</dd>
    <dt>計測内容</dt><dd>${h(measuredText)}</dd>
  </dl>
  <div class="score-label">総合スコア</div>
  <div class="score-hero"><div class="score-big">${o.total.toFixed(1)}</div><div class="score-denom">/ 100</div></div>
  <div class="breakdown">
    <span>言及率 <strong>${o.mentionScore}</strong> / 50</span>
    <span>順位 <strong>${o.rankScore}</strong> / 30</span>
    <span>自社サイト引用 <strong>${o.citeScore}</strong> / 20</span>
  </div>
  <p class="summary">${h(advice.summary)}</p>
  <p class="muted small">スコアは「AI の回答に社名が出た割合」「出た時の順番」「自社サイトが根拠として引用された割合」から算出しています（配点の内訳は最終章）。</p>
  ${agg.mock ? '<div class="banner">このレポートはモック（ダミー回答）から生成した動作確認用です。実際の AI 検索結果ではありません。</div>' : ''}
</header>`;

  const engineTable = `
<section>
  <h2>1. エンジン別スコア</h2>
  <div class="table-wrap"><table class="wide">
    <thead><tr><th>エンジン</th><th>モデル</th><th class="num">スコア</th><th class="num">言及率</th><th class="num">平均順位</th><th class="num">自社サイト引用率</th><th class="num">有効回答</th><th class="num">計測した質問</th></tr></thead>
    <tbody>
      ${autoEngines.map((e) => scoreRow(e, qCount)).join('')}
      ${manualEngines.map((e) => scoreRow(e, qCount)).join('')}
      ${scoreRow({ ...o, label: '総合', model: '' }, qCount, true)}
    </tbody>
  </table></div>
  <p class="legend">言及率 = 社名（別名含む）が回答に出た割合。平均順位 = 出た時に何番目の業者として挙がったか。自社サイト引用率 = 回答の出典に ${h(t.url.replace(/^https?:\/\//, ''))} が含まれた割合。総合はすべての有効回答を合算して計算。${manualEngines.length ? '手入力のエンジンは目視で確認した質問だけを含みます。' : ''}</p>
</section>`;

  const questionTable = `
<section>
  <h2>2. 質問別の結果</h2>
  <div class="table-wrap"><table class="qtable">
    <thead><tr><th class="q">質問</th>${agg.engines.map((e) => `<th class="mark" style="text-align:center">${h(agg.byEngine.find((x) => x.engine === e)?.label ?? e)}</th>`).join('')}</tr></thead>
    <tbody>
      ${agg.questionRows
        .map(
          (q) => `<tr><td class="q"><span class="qno">${q.no}</span>${h(q.text)}</td>${agg.engines
            .map((e) => {
              const c = q.cells[e];
              if (!c || !c.measured) {
                const manual = manualEngines.some((m) => m.engine === e);
                return `<td class="mark mark-n" title="${manual ? '未入力' : '計測なし'}"><span class="runs">${manual ? '未入力' : '計測なし'}</span></td>`;
              }
              const ranks = ranksText(c.ranks);
              const title = c.okRuns ? `${c.mentionedRuns}/${c.okRuns} 回で言及${ranks ? '（' + ranks + '）' : ''}${c.citedRuns ? `・自社引用 ${c.citedRuns} 回` : ''}` : '有効な回答なし';
              return `<td class="mark ${markClass(c.mark)}" title="${h(title)}">${c.mark}<span class="runs">${c.okRuns ? `${c.mentionedRuns}/${c.okRuns}${ranks ? ' ' + h(ranks) : ''}` : '回答なし'}</span></td>`;
            })
            .join('')}</tr>`,
        )
        .join('')}
    </tbody>
  </table></div>
  <p class="legend">○ = 有効な回答すべてで社名が出た　△ = 一部の回で出た（例: 3 回中 1〜2 回）　× = 出なかった　－ = 有効な回答なし。数字は「言及回数/有効回答数」と、出た時の順位。API エラーで取れなかった回は分母に含めません。</p>
</section>`;

  const competitors = `
<section>
  <h2>3. あなたの代わりに出てきた業者 Top5</h2>
  ${
    top5.length
      ? `<div class="table-wrap"><table class="wide">
    <thead><tr><th>#</th><th>業者</th><th class="num">言及回数</th><th class="num">自社が出なかった回答での言及</th><th>なぜ選ばれたか（回答文からの抜粋）</th></tr></thead>
    <tbody>${top5
      .map(
        (c, i) =>
          `<tr><td class="num">${i + 1}</td><th scope="row">${h(c.name)}${c.isKnownCompetitor ? '' : ' <span class="pill">新出</span>'}</th><td class="num">${c.mentions} <span class="muted small">/ ${o.answers}</span></td><td class="num">${c.mentionsWhenTargetAbsent} <span class="muted small">/ ${o.answers - o.mentioned}</span></td><td>${h(c.reasons[0] ?? '（理由の記載なし）')}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>
  <p class="legend">言及回数は有効回答 ${o.answers} 件のうち、その業者名が出た回答の数（言及回数順）。「自社が出なかった回答での言及」は ${h(t.name)} が出なかった ${o.answers - o.mentioned} 件の中での回数。「新出」は設定ファイルの競合リストにない業者。</p>`
      : '<p class="muted">競合業者の言及はありませんでした。</p>'
  }
</section>`;

  const domainRow = (d: Aggregate['domains'][number], rank: number) =>
    `<tr class="${d.isOwn ? 'own' : ''}"><td class="num">${rank}</td><td class="domain">${h(d.domain)}${d.isOwn ? ' <span class="pill">自社</span>' : ''}</td><td class="num">${d.count} <span class="muted small">/ ${o.answers}</span></td><td class="small muted engines">${agg.engines
      .filter((e) => d.byEngine[e])
      .map((e) => `${h(agg.byEngine.find((x) => x.engine === e)?.label ?? e)} ${d.byEngine[e]}`)
      .join('、')}</td></tr>`;

  const domains = `
<section>
  <h2>4. AI が根拠にした引用元ドメイン Top10</h2>
  ${
    top10.length
      ? `<div class="table-wrap"><table class="wide">
    <thead><tr><th>#</th><th>ドメイン</th><th class="num">引用された回答数</th><th>エンジン</th></tr></thead>
    <tbody>${top10.map((d, i) => domainRow(d, i + 1)).join('')}${ownOutsideTop10 >= 0 ? domainRow(agg.domains[ownOutsideTop10]!, ownOutsideTop10 + 1) : ''}</tbody>
  </table></div>
  ${agg.domains.some((d) => d.isOwn) ? '' : `<p class="legend">自社サイト（${h(t.url)}）は一度も引用されていません。</p>`}
  ${ownOutsideTop10 >= 0 ? `<p class="legend">自社サイトは ${ownOutsideTop10 + 1} 位のため、参考として末尾に載せています。</p>` : ''}`
      : '<p class="muted">引用元 URL は取得できませんでした。</p>'
  }
</section>`;

  const suggestions = `
<section>
  <h2>5. 改善提案 3 点</h2>
  <div class="cards">
    ${advice.suggestions
      .map(
        (s, i) => `<div class="card">
      <h3>${i + 1}. ${h(s.title)}</h3>
      <p><span class="lbl">根拠</span>${h(s.why)}</p>
      <p><span class="lbl">やること</span>${h(s.action)}</p>
    </div>`,
      )
      .join('')}
  </div>
  <p class="legend">${advice.source === 'claude' ? `提案は計測結果をもとに AI（${h(advice.model ?? 'Claude')}）が作成し、内容は一般的な施策の範囲です。` : '提案は計測結果に応じたテンプレートから選んでいます。'}</p>
</section>`;

  const modelList = autoEngines.map((e) => `${e.label}: ${agg.models[e.engine] ?? '-'}`).join(' / ');
  const extractionNote =
    agg.totals.extractedWithClaude > 0
      ? `業者名と理由の抽出には文字列一致に加えて AI（${h(agg.extractModel ?? 'Claude')}）を併用しています（${agg.totals.ok} 件中 ${agg.totals.extractedWithClaude} 件）。`
      : '業者名の抽出は文字列一致（正規表現）で行っています。';
  const locationNote = agg.meta?.searchLocation ? `検索エンジンに渡した利用者の位置情報: ${h(describeLocation(agg.meta.searchLocation))}。` : '';
  const methodology = `
<section>
  <h2>6. 計測方法と注意</h2>
  <ul class="method">
    <li>計測日時: ${agg.meta?.startedAt ? `${h(fmtDateTime(agg.meta.startedAt))} 〜 ${h(fmtDateTime(agg.meta.finishedAt))}` : h(agg.date)}（レポート作成 ${h(fmtDateTime(agg.generatedAt))}）</li>
    ${autoEngines.length ? `<li>${h(autoEngines.map((e) => e.label).join('・'))} に同じ ${qCount} 問を${runs > 1 ? ` ${runs} 回ずつ` : ''}質問し、Web 検索（最新情報の参照）を有効にした状態で回答を取得。指示文は「日本語で、具体的な業者名を挙げて答えてください」のみで、特定の業者を誘導していません。${locationNote}</li>` : ''}
    ${modelList ? `<li>使用モデル: ${h(modelList)}</li>` : ''}
    <li>AI の回答は同じ質問でも毎回変わります。このため${runs > 1 ? ` ${runs} 回の平均で` : ''}集計しています。時期・地域設定・モデル更新によっても結果は変動します。</li>
    <li>スコア = 言及率 × 50 点 ＋ 順位点（1 位 30・2 位 20・3 位 12・4 位以下 5 の平均、言及があった回答のみ）＋ 自社サイト引用率 × 20 点。</li>
    <li>社名の判定は表記ゆれ（${h(t.aliases.join('・'))}）を含めて文字列一致で行っています。${extractionNote}</li>
    ${agg.totals.errors ? `<li>API エラー等で回答を取得できなかった ${agg.totals.errors} 件は集計から除外しています。</li>` : ''}
    ${agg.totals.skipped ? `<li>費用上限のため実行しなかった ${agg.totals.skipped} 件は集計に含まれていません。</li>` : ''}
    ${agg.totals.manual ? `<li>${h(manualEngines.map((e) => e.label).join('・'))} は API がないため、実際の画面を目視で確認した結果（${agg.totals.manual} 件）を手入力で取り込んでいます。未入力の質問は集計に含まれません。</li>` : ''}
    <li>各 AI の回答本文は再配布せず、本レポートには要約と短い抜粋のみを掲載しています。</li>
  </ul>
</section>`;

  const changeRows = (list: Comparison['newlyMentioned']) =>
    `<div class="table-wrap"><table class="wide"><thead><tr><th>#</th><th>質問</th><th>エンジン</th><th style="text-align:center">前回 → 今回</th></tr></thead><tbody>${list
      .map((c) => `<tr><td class="num">${c.no}</td><td>${h(c.text)}</td><td class="nowrap">${h(c.label)}</td><td style="text-align:center"><span class="${markClass(c.before)}">${c.before}</span> → <span class="${markClass(c.after)}">${c.after}</span></td></tr>`)
      .join('')}</tbody></table></div>`;

  const compareSection = comparison
    ? `
<section>
  <h2>7. 前回との比較（${h(comparison.beforeDate)} → ${h(comparison.afterDate)}）</h2>
  <div class="table-wrap"><table class="wide">
    <thead><tr><th>エンジン</th><th class="num">前回</th><th class="num">今回</th><th class="num">差</th></tr></thead>
    <tbody>
      ${comparison.byEngine
        .map(
          (e) => `<tr><th scope="row">${h(e.label)}</th><td class="num">${e.before?.toFixed(1) ?? '-'}</td><td class="num">${e.after?.toFixed(1) ?? '-'}</td><td class="num ${e.diff === null ? '' : e.diff > 0 ? 'diff-up' : e.diff < 0 ? 'diff-down' : ''}">${e.diff === null ? '-' : (e.diff > 0 ? '+' : '') + e.diff.toFixed(1)}</td></tr>`,
        )
        .join('')}
      <tr class="row-total"><th scope="row">総合（両日で計測したエンジン）</th><td class="num">${comparison.overall.before.toFixed(1)}</td><td class="num">${comparison.overall.after.toFixed(1)}</td><td class="num ${comparison.overall.diff > 0 ? 'diff-up' : comparison.overall.diff < 0 ? 'diff-down' : ''}">${(comparison.overall.diff > 0 ? '+' : '') + comparison.overall.diff.toFixed(1)}</td></tr>
    </tbody>
  </table></div>
  <p class="legend">総合の比較は両日で計測したエンジン（${h(comparison.commonEngines.map((e) => agg.byEngine.find((x) => x.engine === e)?.label ?? e).join('・'))}）だけで再計算しています。言及率 ${pct(comparison.mentionRate.before)} → ${pct(comparison.mentionRate.after)}、自社サイト引用率 ${pct(comparison.citeRate.before)} → ${pct(comparison.citeRate.after)}。${comparison.onlyAfter.length ? `今回から計測: ${h(comparison.onlyAfter.map((e) => agg.byEngine.find((x) => x.engine === e)?.label ?? e).join('・'))}。` : ''}${comparison.onlyBefore.length ? `今回は未計測: ${h(comparison.onlyBefore.map((e) => agg.byEngine.find((x) => x.engine === e)?.label ?? e).join('・'))}。` : ''}${comparison.changedQuestions.length ? `質問文が前回と異なる Q${comparison.changedQuestions.map((c) => c.no).join('・Q')} は比較から外しています。` : ''}</p>
  <h3>新しく出るようになった質問</h3>
  ${comparison.newlyMentioned.length ? changeRows(comparison.newlyMentioned) : '<p class="muted">新しく出るようになった質問はありません。</p>'}
  ${comparison.lost.length ? `<h3>出なくなった質問</h3>${changeRows(comparison.lost)}` : ''}
</section>`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(t.name)} AI検索露出診断レポート ${h(agg.date)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
${cover}
${engineTable}
${questionTable}
${competitors}
${domains}
${suggestions}
${methodology}
${compareSection}
<footer>geo-scan による AI 検索露出診断 / ${h(t.name)} / ${h(agg.date)}</footer>
</div>
</body>
</html>
`;
}
