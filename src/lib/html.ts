import { stableQuestionCount, type Aggregate, type EngineScore } from './aggregate.js';
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

/** スコア帯。0-29 赤 / 30-59 橙 / 60-100 緑 */
export type Tone = 'red' | 'orange' | 'green';

export function toneOf(total: number): Tone {
  if (total < 30) return 'red';
  if (total < 60) return 'orange';
  return 'green';
}

/** ○=緑 △=橙 ×=赤 －=グレー */
function markKey(m: Mark): 'o' | 'd' | 'x' | 'n' {
  return m === '○' ? 'o' : m === '△' ? 'd' : m === '×' ? 'x' : 'n';
}

const JP_LETTER = /[぀-ゟ゠-ヿ一-鿿ｦ-ﾟa-zA-Z]/g;

/**
 * 回答文から取った「理由」を営業レポートに出せる形に整える。
 * 引用記法（[example.jp](https://…)）や裸の URL しか無いものは理由として意味がないので null を返す。
 */
export function cleanReason(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = String(raw)
    // マークダウンリンクはリンクテキストだけ残す
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 裸の URL とドメインだけの断片を落とす
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/g, (m) => (/[.](jp|com|net|org|co|info|io|me|shop|store)\b/i.test(m) ? '' : m))
    .replace(/\(\s*\)|（\s*）|\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // 前後に残った記号を削る
    .replace(/^[\s、。・,.:：;；\-–—|()（）[\]【】"'“”「」]+/, '')
    .replace(/[\s、・,:：;；\-–—|()（）[\]【】"'“”「」]+$/, '')
    .trim();
  if (s.length < 6) return null;
  const letters = s.match(JP_LETTER)?.length ?? 0;
  // 記号・数字ばかりのものは捨てる
  if (letters < 5 || letters / s.length < 0.4) return null;
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

/** 競合カードに出す抜粋。使えるものが無ければ null */
function reasonFor(reasons: readonly string[]): string | null {
  for (const r of reasons) {
    const c = cleanReason(r);
    if (c) return c;
  }
  return null;
}

/** 進捗バー（幅は 0〜100%） */
function trackWidth(value: number, max: number): string {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return w.toFixed(1);
}

const DONUT_R = 52;
const DONUT_C = 2 * Math.PI * DONUT_R;

function donut(total: number): string {
  const filled = (Math.max(0, Math.min(100, total)) / 100) * DONUT_C;
  const arc =
    total > 0
      ? `<circle cx="60" cy="60" r="${DONUT_R}" fill="none" stroke="var(--primary)" stroke-width="15" stroke-linecap="butt" stroke-dasharray="${filled.toFixed(2)} ${(DONUT_C - filled).toFixed(2)}" transform="rotate(-90 60 60)"/>`
      : '';
  return `<svg class="donut" viewBox="0 0 120 120" width="164" height="164" role="img" aria-label="総合スコア ${total.toFixed(1)} / 100点">
    <circle cx="60" cy="60" r="${DONUT_R}" fill="none" stroke="#e7e9eb" stroke-width="15"/>
    ${arc}
    <text class="donut-num" x="60" y="59" text-anchor="middle">${total.toFixed(1)}</text>
    <text class="donut-denom" x="60" y="78" text-anchor="middle">/ 100点</text>
  </svg>`;
}

function metricBar(label: string, sub: string, value: number, max: number): string {
  return `<div class="metric">
    <div class="metric-head"><span class="metric-label">${h(label)}</span><span class="metric-sub">${h(sub)}</span></div>
    <div class="metric-track"><span style="width:${trackWidth(value, max)}%"></span></div>
    <div class="metric-val"><strong>${value.toFixed(1)}</strong><span class="metric-max">/ ${max}点</span></div>
  </div>`;
}

function engineRow(s: EngineScore, questionCount: number): string {
  return `<tr>
    <th scope="row"><span class="ename">${h(s.label)}</span>${s.manual ? '<span class="tag">手入力</span>' : ''}<span class="emodel">${h(s.model ?? '')}</span></th>
    <td class="escore"><span class="escore-num txt-${toneOf(s.total)}">${s.total.toFixed(1)}</span><span class="escore-track"><span class="txt-${toneOf(s.total)}" style="width:${trackWidth(s.total, 100)}%"></span></span></td>
    <td class="num">${pct(s.mentionRate)}<span class="sub">${s.mentioned}/${s.answers}件</span></td>
    <td class="num">${s.avgRank !== null ? `${s.avgRank.toFixed(1)}番目` : '－'}</td>
    <td class="num">${pct(s.citeRate)}<span class="sub">${s.cited}/${s.answers}件</span></td>
    <td class="num">${s.answers}件<span class="sub">${s.coveredQuestions}/${questionCount}問${s.errors ? ` 失敗${s.errors}` : ''}</span></td>
  </tr>`;
}

const CSS = `
:root {
  --ink: #1a1a1a; --muted: #5f6368; --faint: #8a8f94; --line: #dfe1e3; --soft-bg: #f5f6f7;
  --red: #c0392b; --red-soft: #fbe9e7; --orange: #d68910; --orange-soft: #fdf2e0; --green: #1e8449; --green-soft: #e6f2ea;
  --rival: #4a4f55; --rival-soft: #e6e7e9;
  --primary: var(--orange); --primary-soft: var(--orange-soft);
}
/* body のクラスは主色（--primary）を切り替えるだけ。本文の文字色は常に --ink */
body.tone-red { --primary: var(--red); --primary-soft: var(--red-soft); }
body.tone-orange { --primary: var(--orange); --primary-soft: var(--orange-soft); }
body.tone-green { --primary: var(--green); --primary-soft: var(--green-soft); }
.txt-red { color: var(--red); }
.txt-orange { color: var(--orange); }
.txt-green { color: var(--green); }
.escore-track > .txt-red { background: var(--red); }
.escore-track > .txt-orange { background: var(--orange); }
.escore-track > .txt-green { background: var(--green); }

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: var(--ink); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", "Noto Sans JP", Meiryo, sans-serif;
  font-size: 16px; line-height: 1.75; -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.page { max-width: 860px; margin: 0 auto; padding: 32px 24px 56px; }
p { margin: 0 0 12px; }
section { margin: 0 0 44px; }
h2 { font-size: 26px; font-weight: 800; line-height: 1.35; margin: 0 0 16px; padding: 0 0 10px; border-bottom: 4px solid var(--ink); letter-spacing: -.01em; }
h2 .secno { color: var(--faint); margin-right: 10px; font-size: 22px; }
h3 { font-size: 19px; font-weight: 800; margin: 24px 0 8px; }
.muted { color: var(--muted); }
.note { font-size: 14px; color: var(--muted); margin-top: 12px; line-height: 1.7; }
.num { text-align: right; white-space: nowrap; }
.sub { display: block; font-size: 12px; color: var(--muted); font-weight: 400; }
.tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 10px; background: var(--soft-bg); color: var(--muted); margin-left: 6px; vertical-align: middle; }

/* ---- 表紙 ---- */
.cover { padding: 0 0 8px; }
.cover-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.brand { font-weight: 800; color: var(--ink); letter-spacing: .04em; }
.cname { font-weight: 800; color: var(--ink); font-size: 15px; }
.headline { font-size: 48px; font-weight: 900; line-height: 1.3; letter-spacing: -.02em; margin: 26px 0 10px; }
.headline .hl { color: var(--primary); }
.sub-headline { font-size: 17px; color: var(--muted); margin: 0 0 22px; max-width: 40em; }
.headline-note { display: block; font-size: 13px; color: var(--faint); margin-top: 2px; }
.score-block { display: flex; align-items: center; justify-content: center; gap: 26px; margin: 4px 0 22px; }
.donut-cap { font-size: 14px; color: var(--muted); text-align: center; }
.donut-cap strong { display: block; font-size: 17px; color: var(--ink); }
.donut-num { font-size: 32px; font-weight: 900; fill: var(--primary); }
.donut-denom { font-size: 12px; fill: var(--muted); }
.metrics { display: grid; gap: 12px; margin: 0 0 24px; }
.metric { display: grid; grid-template-columns: 15em 1fr 6.5em; align-items: center; gap: 14px; }
.metric-head { display: flex; flex-direction: column; }
.metric-label { font-size: 15px; font-weight: 700; line-height: 1.4; }
.metric-sub { font-size: 12px; color: var(--muted); }
.metric-track { height: 16px; background: var(--soft-bg); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
.metric-track > span { display: block; height: 100%; background: var(--primary); }
.metric-val { text-align: right; white-space: nowrap; font-size: 14px; color: var(--muted); }
.metric-val strong { font-size: 19px; color: var(--ink); margin-right: 3px; }
.rivals-title { font-size: 15px; font-weight: 800; margin: 0 0 8px; }
.rivals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.rival-card { border: 1px solid var(--line); border-top: 4px solid var(--rival); border-radius: 5px; padding: 10px 12px; background: #fff; }
.rival-rank { font-size: 11px; color: var(--faint); font-weight: 700; }
.rival-name { font-size: 17px; font-weight: 800; color: var(--rival); line-height: 1.35; margin: 2px 0 4px; word-break: break-word; }
.rival-count { font-size: 14px; color: var(--muted); }
.rival-count strong { font-size: 20px; color: var(--ink); }
.rivals-empty { border: 1px solid var(--line); border-radius: 5px; padding: 10px 12px; color: var(--muted); font-size: 14px; }
.banner { border: 1px solid var(--line); background: var(--soft-bg); color: var(--muted); border-radius: 5px; padding: 8px 12px; font-size: 13px; margin-top: 16px; }

/* ---- 赤帯・警告 ---- */
.alert { display: flex; align-items: center; gap: 10px; background: var(--red-soft); border-left: 6px solid var(--red); color: var(--red); font-size: 19px; font-weight: 800; padding: 12px 16px; border-radius: 3px; margin: 0 0 16px; }

/* ---- 表 ---- */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th, td { padding: 10px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
thead th { background: var(--soft-bg); font-size: 13px; font-weight: 800; white-space: nowrap; border-bottom: 2px solid var(--ink); }
tbody th { font-weight: 700; }
.etable { min-width: 620px; }
.etable .ename { font-size: 16px; font-weight: 800; }
.etable .emodel { display: block; font-size: 11px; color: var(--faint); font-weight: 400; }
.escore { width: 27%; }
.escore-num { font-size: 24px; font-weight: 900; line-height: 1.1; }
.escore-track { display: block; height: 9px; background: var(--soft-bg); border-radius: 3px; overflow: hidden; margin-top: 5px; }
.escore-track > span { display: block; height: 100%; }
.etotal th, .etotal td { border-top: 2px solid var(--ink); background: #fafbfb; }

/* ---- 質問別 ---- */
.qtable { min-width: 600px; }
/* 質問列は横スクロールしても残す（スマホで見出しが消えないように） */
.qtable th.q, .qtable td.q { width: 44%; min-width: 250px; position: sticky; left: 0; background: #fff; box-shadow: 1px 0 0 var(--line); }
.qtable th.q { background: var(--soft-bg); }
.qtable td.q { font-size: 16px; line-height: 1.5; }
.qtable .qno { display: inline-block; min-width: 1.8em; color: var(--faint); font-weight: 700; }
.qtable th.cell { text-align: center; min-width: 78px; }
.qtable td.cell { text-align: center; padding: 8px 4px; min-width: 78px; }
.dot { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 50%; font-size: 16px; font-weight: 800; color: #fff; line-height: 1; }
.dot-o { background: var(--green); }
.dot-d { background: var(--orange); }
.dot-x { background: var(--red); }
.dot-n { background: #fff; border: 2px dashed var(--line); color: var(--faint); font-size: 12px; }
.frac { display: block; font-size: 11px; color: var(--muted); margin-top: 3px; }
.cell-o { background: var(--green-soft); }
.cell-d { background: var(--orange-soft); }
.cell-x { background: var(--red-soft); }
.cell-n { background: #fff; }

/* ---- 競合カード ---- */
.rcards { display: grid; gap: 12px; }
.rcard { display: grid; grid-template-columns: 2.2em 1fr; gap: 12px; border: 1px solid var(--line); border-left: 6px solid var(--rival); border-radius: 5px; padding: 12px 14px; }
.rcard-rank { font-size: 22px; font-weight: 900; color: var(--faint); line-height: 1.2; }
.rcard-name { font-size: 20px; font-weight: 800; color: var(--rival); line-height: 1.3; }
.rcard-bar { display: grid; grid-template-columns: 1fr 9em; align-items: center; gap: 12px; margin: 7px 0 6px; }
.rcard-track { height: 14px; background: var(--soft-bg); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
.rcard-track > span { display: block; height: 100%; background: var(--rival); }
.rcard-count { font-size: 13px; color: var(--muted); white-space: nowrap; }
.rcard-count strong { font-size: 18px; color: var(--ink); }
.rcard-quote { font-size: 15px; line-height: 1.6; color: var(--ink); margin: 0; }
.rcard-quote.none { color: var(--faint); }
.rcard-absent { font-size: 13px; color: var(--muted); margin: 5px 0 0; }
.rcard-absent strong { color: var(--rival); font-size: 15px; }

/* ---- 引用元ドメイン ---- */
.dbars { display: grid; gap: 9px; }
.dbar { display: grid; grid-template-columns: 17em 1fr 5.5em; align-items: center; gap: 12px; }
.dbar-name { font-size: 15px; overflow-wrap: anywhere; color: var(--rival); font-weight: 600; }
.dbar-track { height: 18px; background: var(--soft-bg); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
.dbar-track > span { display: block; height: 100%; background: var(--rival); }
.dbar-val { text-align: right; font-size: 14px; color: var(--muted); white-space: nowrap; }
.dbar-val strong { font-size: 17px; color: var(--ink); }
.dbar.own .dbar-name { color: var(--primary); font-weight: 800; }
.dbar.own .dbar-track > span { background: var(--primary); }
.dbar.own .dbar-val strong { color: var(--primary); }
.zero-line { font-size: 19px; font-weight: 800; color: var(--red); background: var(--red-soft); border-left: 6px solid var(--red); padding: 12px 16px; border-radius: 3px; margin: 0 0 16px; }

/* ---- 改善提案 ---- */
.scards { display: grid; gap: 14px; }
.scard { display: grid; grid-template-columns: 2.4em 1fr; gap: 14px; border: 1px solid var(--line); border-left: 6px solid var(--primary); border-radius: 5px; padding: 14px 16px; }
.snum { font-size: 30px; font-weight: 900; color: var(--primary); line-height: 1.05; }
.scard h3 { margin: 0 0 8px; font-size: 21px; font-weight: 800; line-height: 1.35; }
.srow { display: grid; grid-template-columns: 5.5em 1fr; gap: 10px; margin-top: 6px; }
.slbl { font-size: 12px; font-weight: 800; color: var(--muted); letter-spacing: .04em; padding-top: 4px; }
.srow p { font-size: 16px; line-height: 1.65; margin: 0; }

/* ---- 比較 ---- */
.diff-up { color: var(--green); font-weight: 800; }
.diff-down { color: var(--red); font-weight: 800; }

/* ---- 計測方法（末尾・小さく） ---- */
.method-section h2 { font-size: 18px; border-bottom-width: 2px; }
.method-section h2 .secno { font-size: 16px; }
.method { padding-left: 1.2em; margin: 0; }
.method li { font-size: 12.5px; line-height: 1.65; color: var(--muted); margin-bottom: 3px; }
footer { margin-top: 32px; font-size: 11px; color: var(--faint); border-top: 1px solid var(--line); padding-top: 10px; }

@media (max-width: 640px) {
  body { font-size: 15px; }
  .page { padding: 20px 14px 40px; }
  .headline { font-size: 32px; }
  h2 { font-size: 22px; }
  .score-block { flex-direction: column; gap: 12px; }
  .metric { grid-template-columns: 1fr; gap: 4px; }
  .metric-val { text-align: left; }
  .rivals { grid-template-columns: 1fr; }
  .dbar { grid-template-columns: 1fr; gap: 3px; }
  .dbar-val { text-align: left; }
  .srow { grid-template-columns: 1fr; gap: 2px; }
}

@media print {
  @page { size: A4 portrait; margin: 13mm 12mm; }
  body { font-size: 12.5px; }
  .page { max-width: none; padding: 0; }
  .cover { break-after: page; }
  .headline { font-size: 38px; margin: 26px 0 10px; }
  .sub-headline { font-size: 15px; margin-bottom: 22px; }
  .score-block { margin: 0 0 22px; }
  .donut { width: 152px; height: 152px; }
  .metrics { gap: 13px; margin-bottom: 24px; }
  .metric-track { height: 16px; }
  .metric-label { font-size: 14px; }
  .rival-name { font-size: 16px; }
  h2 { font-size: 20px; }
  h2 .secno { font-size: 17px; }
  h3 { font-size: 16px; }
  section, .rcard, .scard, .rival-card, .metric, .dbar, .alert, .zero-line { break-inside: avoid; }
  tr, thead { break-inside: avoid; }
  thead { display: table-header-group; }
  table { font-size: 12px; }
  .qtable td.q { font-size: 12.5px; }
  .srow p { font-size: 13px; }
  .rcard-quote { font-size: 13px; }
  .dbar-name, .dbar-val { font-size: 12px; }
  .table-wrap { overflow: visible; }
  .etable, .qtable { min-width: 0; }
  .qtable th.q, .qtable td.q { position: static; box-shadow: none; min-width: 0; }
  .qtable th.cell, .qtable td.cell { min-width: 0; }
  .dot { width: 24px; height: 24px; font-size: 13px; }
  a { color: inherit; text-decoration: none; }
}
`;

export function renderReport(agg: Aggregate, advice: Advice, comparison: Comparison | null): string {
  const o = agg.overall;
  const t = agg.target;
  const tone = toneOf(o.total);
  const autoEngines = agg.byEngine.filter((e) => !e.manual);
  const manualEngines = agg.byEngine.filter((e) => e.manual);
  const runs = Math.max(0, ...autoEngines.map((e) => agg.runsPerEngine[e.engine] ?? 0));
  const qCount = agg.questions.length;
  const appeared = agg.questionRows.filter((q) => q.mentionedAnywhere).length;
  // 見出しは「計測したすべての AI で毎回そろって社名が出た」質問だけを数える（△は含めない）
  const stable = stableQuestionCount(agg.questionRows, agg.engines);
  const top3 = agg.competitors.slice(0, 3);
  const top5 = agg.competitors.slice(0, 5);
  const top10 = agg.domains.slice(0, 10);
  const ownDomainIndex = agg.domains.findIndex((d) => d.isOwn);
  const ownDomainOutsideTop10 = ownDomainIndex >= 10 ? ownDomainIndex : -1;
  const ownHost = t.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const scanOk = agg.extractions.filter((x) => x.source === 'scan' && x.status === 'ok').length;
  const manualOk = agg.extractions.filter((x) => x.source === 'manual' && x.status === 'ok').length;

  const headline =
    stable === 0
      ? `${qCount}問中 <span class="hl">0問</span>で<br>あなたの会社は出てきませんでした`
      : stable === qCount
        ? `${qCount}問<span class="hl">すべて</span>で<br>安定して出ています`
        : `${qCount}問中 <span class="hl">${stable}問</span>でしか<br>安定して出ていません`;

  const measuredText = [
    autoEngines.length ? `${autoEngines.length} エンジン × ${qCount} 問${runs > 1 ? ` × ${runs} 回` : ''} = ${agg.totals.scan} 件（有効 ${scanOk} 件）` : '',
    manualEngines.length ? `手入力 ${manualEngines.map((e) => e.label).join('・')} ${agg.totals.manual} 件（有効 ${manualOk} 件）` : '',
  ]
    .filter(Boolean)
    .join('、');

  const cover = `
<header class="cover">
  <div class="cover-top">
    <span class="brand">AI検索 露出診断レポート</span>
    <span class="cname">${h(t.name)}</span>
    <span>${h(ownHost)}</span>
    <span>${h(t.area)}／${h(t.industry)}</span>
    <span>計測日 ${h(agg.date)}</span>
  </div>
  <p class="headline">${headline}</p>
  <p class="sub-headline">${h(advice.summary)}<span class="headline-note">計測したすべての AI で毎回そろって社名が挙がった質問の数です（一部の回だけ出た質問は含みません）。</span></p>
  <div class="score-block">
    ${donut(o.total)}
    <div class="donut-cap"><strong>総合スコア</strong>100点満点</div>
  </div>
  <div class="metrics">
    ${metricBar('AIの回答に社名が出た割合', `${pct(o.mentionRate)}（${o.answers}回答中 ${o.mentioned}回）`, o.mentionScore, 50)}
    ${metricBar('出てきたときの順番', o.avgRank !== null ? `平均 ${o.avgRank.toFixed(1)}番目（1番目なら満点）` : '一度も出ていないため0点', o.rankScore, 30)}
    ${metricBar('自社サイトが引用された割合', `${pct(o.citeRate)}（${o.answers}回答中 ${o.cited}回）`, o.citeScore, 20)}
  </div>
  <p class="rivals-title">代わりに出てきた業者</p>
  ${
    top3.length
      ? `<div class="rivals">${top3
          .map(
            (c, i) => `<div class="rival-card">
      <div class="rival-rank">${i + 1}位</div>
      <div class="rival-name">${h(c.name)}</div>
      <div class="rival-count"><strong>${c.mentions}</strong>回 <span class="muted">/ ${o.answers}回答</span></div>
    </div>`,
          )
          .join('')}</div>`
      : '<div class="rivals-empty">競合業者の言及はありませんでした。</div>'
  }
  ${agg.mock ? '<div class="banner">このレポートはモック（ダミー回答）から生成した動作確認用です。実際の AI 検索結果ではありません。</div>' : ''}
</header>`;

  const engineSection = `
<section>
  <h2><span class="secno">1.</span>AIごとの結果</h2>
  <div class="table-wrap"><table class="etable">
    <thead><tr><th>AI</th><th>スコア</th><th class="num">社名が出た割合</th><th class="num">平均の順番</th><th class="num">自社サイト引用</th><th class="num">有効回答</th></tr></thead>
    <tbody>
      ${autoEngines.map((e) => engineRow(e, qCount)).join('')}
      ${manualEngines.map((e) => engineRow(e, qCount)).join('')}
      <tr class="etotal">
        <th scope="row"><span class="ename">総合</span></th>
        <td class="escore"><span class="escore-num txt-${tone}">${o.total.toFixed(1)}</span><span class="escore-track"><span class="txt-${tone}" style="width:${trackWidth(o.total, 100)}%"></span></span></td>
        <td class="num">${pct(o.mentionRate)}<span class="sub">${o.mentioned}/${o.answers}件</span></td>
        <td class="num">${o.avgRank !== null ? `${o.avgRank.toFixed(1)}番目` : '－'}</td>
        <td class="num">${pct(o.citeRate)}<span class="sub">${o.cited}/${o.answers}件</span></td>
        <td class="num">${o.answers}件</td>
      </tr>
    </tbody>
  </table></div>
  <p class="note">「社名が出た割合」= AI の回答に社名（別名含む）が出た割合。「平均の順番」= 出たときに何番目の業者として挙がったか。「自社サイト引用」= 回答の出典に ${h(ownHost)} が含まれた割合。総合はすべての有効回答を合算して計算しています。${manualEngines.length ? '手入力の AI は目視で確認した質問だけを含みます。' : ''}</p>
</section>`;

  const questionSection = `
<section>
  <h2><span class="secno">2.</span>質問別の結果</h2>
  ${appeared === 0 ? `<p class="alert">全${qCount}問で表示なし</p>` : ''}
  <div class="table-wrap"><table class="qtable">
    <thead><tr><th class="q">質問</th>${agg.engines.map((e) => `<th class="cell">${h(agg.byEngine.find((x) => x.engine === e)?.label ?? e)}</th>`).join('')}</tr></thead>
    <tbody>
      ${agg.questionRows
        .map(
          (q) => `<tr><td class="q"><span class="qno">${q.no}</span>${h(q.text)}</td>${agg.engines
            .map((e) => {
              const c = q.cells[e];
              if (!c || !c.measured) {
                const manual = manualEngines.some((m) => m.engine === e);
                const label = manual ? '未入力' : '計測なし';
                return `<td class="cell cell-n" title="${label}"><span class="dot dot-n">–</span><span class="frac">${label}</span></td>`;
              }
              const key = markKey(c.mark);
              const ranks = c.ranks.length ? c.ranks.map((r) => `${r}番目`).join('・') : '';
              const title = c.okRuns ? `${c.mentionedRuns}/${c.okRuns} 回で言及${ranks ? `（${ranks}）` : ''}${c.citedRuns ? `・自社引用 ${c.citedRuns} 回` : ''}` : '有効な回答なし';
              return `<td class="cell cell-${key}" title="${h(title)}"><span class="dot dot-${key}">${c.mark}</span><span class="frac">${c.okRuns ? `${c.mentionedRuns}/${c.okRuns}` : '回答なし'}</span></td>`;
            })
            .join('')}</tr>`,
        )
        .join('')}
    </tbody>
  </table></div>
  <p class="note">緑 ○ = 有効な回答すべてで社名が出た　橙 △ = 一部の回で出た　赤 × = 出なかった　－ = 有効な回答なし。小さい数字は「社名が出た回数／有効回答数」です。API エラーで取れなかった回は分母に含めません。</p>
</section>`;

  const maxRivalMentions = Math.max(1, ...top5.map((c) => c.mentions));
  const absentAnswers = o.answers - o.mentioned;
  const competitorSection = `
<section>
  <h2><span class="secno">3.</span>あなたの代わりに出てきた業者 Top5</h2>
  ${
    top5.length
      ? `<div class="rcards">${top5
          .map((c, i) => {
            const quote = reasonFor(c.reasons);
            return `<div class="rcard">
      <div class="rcard-rank">${i + 1}</div>
      <div>
        <div class="rcard-name">${h(c.name)}${c.isKnownCompetitor ? '' : '<span class="tag">新出</span>'}</div>
        <div class="rcard-bar">
          <span class="rcard-track"><span style="width:${trackWidth(c.mentions, maxRivalMentions)}%"></span></span>
          <span class="rcard-count"><strong>${c.mentions}</strong>回 / ${o.answers}回答</span>
        </div>
        <p class="rcard-quote${quote ? '' : ' none'}">${quote ? h(quote) : '理由の記載なし'}</p>
        ${absentAnswers > 0 ? `<p class="rcard-absent">${h(t.name)}が出なかった ${absentAnswers} 回答のうち <strong>${c.mentionsWhenTargetAbsent}</strong> 回で挙がっています</p>` : ''}
      </div>
    </div>`;
          })
          .join('')}</div>
  <p class="note">言及回数は有効回答 ${o.answers} 件のうち、その業者名が出た回答の数です（多い順）。「新出」は設定ファイルの競合リストにない業者です。文章は AI の回答からの抜粋で、抜粋が取れなかった場合は「理由の記載なし」と表示します。</p>`
      : '<p class="muted">競合業者の言及はありませんでした。</p>'
  }
</section>`;

  const maxDomainCount = Math.max(1, ...top10.map((d) => d.count));
  const domainBar = (d: Aggregate['domains'][number], rank: number) =>
    `<div class="dbar${d.isOwn ? ' own' : ''}">
      <div class="dbar-name">${rank}. ${h(d.domain)}${d.isOwn ? '<span class="tag">自社</span>' : ''}</div>
      <div class="dbar-track"><span style="width:${trackWidth(d.count, maxDomainCount)}%"></span></div>
      <div class="dbar-val"><strong>${d.count}</strong>回</div>
    </div>`;

  const domainSection = `
<section>
  <h2><span class="secno">4.</span>AIはどこを読んで答えているか</h2>
  ${ownDomainIndex < 0 ? `<p class="zero-line">あなたのサイト（${h(ownHost)}）は0回</p>` : ''}
  ${
    top10.length
      ? `<div class="dbars">${top10.map((d, i) => domainBar(d, i + 1)).join('')}${ownDomainOutsideTop10 >= 0 ? domainBar(agg.domains[ownDomainOutsideTop10]!, ownDomainOutsideTop10 + 1) : ''}</div>
  <p class="note">AI が回答の根拠として引用したページのドメインを、引用された回答数の多い順に並べています（有効回答 ${o.answers} 件中）。${ownDomainOutsideTop10 >= 0 ? `自社サイトは ${ownDomainOutsideTop10 + 1} 位のため、参考として末尾に載せています。` : ''}</p>`
      : '<p class="muted">引用元 URL は取得できませんでした。</p>'
  }
</section>`;

  const suggestionSection = `
<section>
  <h2><span class="secno">5.</span>改善提案 3 点</h2>
  <div class="scards">
    ${advice.suggestions
      .map(
        (s, i) => `<div class="scard">
      <div class="snum">${i + 1}</div>
      <div>
        <h3>${h(s.title)}</h3>
        <div class="srow"><span class="slbl">なぜ</span><p>${h(s.why)}</p></div>
        <div class="srow"><span class="slbl">やること</span><p>${h(s.action)}</p></div>
      </div>
    </div>`,
      )
      .join('')}
  </div>
  <p class="note">${advice.source === 'claude' ? `提案は計測結果をもとに AI（${h(advice.model ?? 'Claude')}）が作成し、内容は一般的な施策の範囲です。` : '提案は計測結果に応じたテンプレートから選んでいます。'}</p>
</section>`;

  const changeTable = (list: Comparison['newlyMentioned']) =>
    `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>質問</th><th>AI</th><th style="text-align:center">前回 → 今回</th></tr></thead>
      <tbody>${list
        .map(
          (c) =>
            `<tr><td class="num">${c.no}</td><td>${h(c.text)}</td><td>${h(c.label)}</td><td style="text-align:center"><span class="dot dot-${markKey(c.before)}">${c.before}</span> → <span class="dot dot-${markKey(c.after)}">${c.after}</span></td></tr>`,
        )
        .join('')}</tbody>
    </table></div>`;

  const compareSection = comparison
    ? `
<section>
  <h2><span class="secno">6.</span>前回との比較（${h(comparison.beforeDate)} → ${h(comparison.afterDate)}）</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>AI</th><th class="num">前回</th><th class="num">今回</th><th class="num">差</th></tr></thead>
    <tbody>
      ${comparison.byEngine
        .map(
          (e) => `<tr><th scope="row">${h(e.label)}</th><td class="num">${e.before?.toFixed(1) ?? '－'}</td><td class="num">${e.after?.toFixed(1) ?? '－'}</td><td class="num ${e.diff === null ? '' : e.diff > 0 ? 'diff-up' : e.diff < 0 ? 'diff-down' : ''}">${e.diff === null ? '－' : (e.diff > 0 ? '+' : '') + e.diff.toFixed(1)}</td></tr>`,
        )
        .join('')}
      <tr class="etotal"><th scope="row">総合（両日で計測した AI）</th><td class="num">${comparison.overall.before.toFixed(1)}</td><td class="num">${comparison.overall.after.toFixed(1)}</td><td class="num ${comparison.overall.diff > 0 ? 'diff-up' : comparison.overall.diff < 0 ? 'diff-down' : ''}">${(comparison.overall.diff > 0 ? '+' : '') + comparison.overall.diff.toFixed(1)}</td></tr>
    </tbody>
  </table></div>
  <p class="note">総合の比較は両日で計測した AI（${h(comparison.commonEngines.map((e) => agg.byEngine.find((x) => x.engine === e)?.label ?? e).join('・'))}）だけで再計算しています。社名が出た割合 ${pct(comparison.mentionRate.before)} → ${pct(comparison.mentionRate.after)}、自社サイト引用 ${pct(comparison.citeRate.before)} → ${pct(comparison.citeRate.after)}。${comparison.onlyAfter.length ? `今回から計測: ${h(comparison.onlyAfter.map((e) => agg.byEngine.find((x) => x.engine === e)?.label ?? e).join('・'))}。` : ''}${comparison.onlyBefore.length ? `今回は未計測: ${h(comparison.onlyBefore.map((e) => agg.byEngine.find((x) => x.engine === e)?.label ?? e).join('・'))}。` : ''}${comparison.changedQuestions.length ? `質問文が前回と異なる Q${comparison.changedQuestions.map((c) => c.no).join('・Q')} は比較から外しています。` : ''}</p>
  <h3>新しく出るようになった質問</h3>
  ${comparison.newlyMentioned.length ? changeTable(comparison.newlyMentioned) : '<p class="muted">新しく出るようになった質問はありません。</p>'}
  ${comparison.lost.length ? `<h3>出なくなった質問</h3>${changeTable(comparison.lost)}` : ''}
</section>`
    : '';

  const methodNo = comparison ? 7 : 6;
  const modelList = autoEngines.map((e) => `${e.label}: ${agg.models[e.engine] ?? '-'}`).join(' / ');
  const extractionNote =
    agg.totals.extractedWithClaude > 0
      ? `業者名と理由の抽出には文字列一致に加えて AI（${h(agg.extractModel ?? 'Claude')}）を併用しています（${agg.totals.ok} 件中 ${agg.totals.extractedWithClaude} 件）。`
      : '業者名の抽出は文字列一致（正規表現）で行っています。';
  const locationNote = agg.meta?.searchLocation ? `検索エンジンに渡した利用者の位置情報: ${h(describeLocation(agg.meta.searchLocation))}。` : '';
  const methodSection = `
<section class="method-section">
  <h2><span class="secno">${methodNo}.</span>計測方法と注意</h2>
  <ul class="method">
    <li>計測日時: ${agg.meta?.startedAt ? `${h(fmtDateTime(agg.meta.startedAt))} 〜 ${h(fmtDateTime(agg.meta.finishedAt))}` : h(agg.date)}（レポート作成 ${h(fmtDateTime(agg.generatedAt))}）</li>
    <li>計測内容: ${h(measuredText)}</li>
    ${autoEngines.length ? `<li>${h(autoEngines.map((e) => e.label).join('・'))} に同じ ${qCount} 問を${runs > 1 ? ` ${runs} 回ずつ` : ''}質問し、Web 検索（最新情報の参照）を有効にした状態で回答を取得。指示文は「日本語で、具体的な業者名を挙げて答えてください」のみで、特定の業者を誘導していません。${locationNote}</li>` : ''}
    ${modelList ? `<li>使用モデル: ${h(modelList)}</li>` : ''}
    <li>AI の回答は同じ質問でも毎回変わります。このため${runs > 1 ? ` ${runs} 回の平均で` : ''}集計しています。時期・地域設定・モデル更新によっても結果は変動します。</li>
    <li>スコア = 社名が出た割合 × 50 点 ＋ 順位点（1 番目 30・2 番目 20・3 番目 12・4 番目以下 5 の平均、社名が出た回答のみ）＋ 自社サイト引用率 × 20 点。</li>
    <li>社名の判定は表記ゆれ（${h(t.aliases.join('・'))}）を含めて文字列一致で行っています。${extractionNote}</li>
    ${agg.totals.errors ? `<li>API エラー等で回答を取得できなかった ${agg.totals.errors} 件は集計から除外しています。</li>` : ''}
    ${agg.totals.skipped ? `<li>費用上限のため実行しなかった ${agg.totals.skipped} 件は集計に含まれていません。</li>` : ''}
    ${agg.totals.manual ? `<li>${h(manualEngines.map((e) => e.label).join('・'))} は API がないため、実際の画面を目視で確認した結果（${agg.totals.manual} 件）を手入力で取り込んでいます。未入力の質問は集計に含まれません。</li>` : ''}
    <li>各 AI の回答本文は再配布せず、本レポートには要約と短い抜粋のみを掲載しています。</li>
  </ul>
</section>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(t.name)} AI検索露出診断レポート ${h(agg.date)}</title>
<style>${CSS}</style>
</head>
<body class="tone-${tone}">
<div class="page">
${cover}
${engineSection}
${questionSection}
${competitorSection}
${domainSection}
${suggestionSection}
${compareSection}
${methodSection}
<footer>geo-scan による AI 検索露出診断 / ${h(t.name)} / ${h(agg.date)}</footer>
</div>
</body>
</html>
`;
}
