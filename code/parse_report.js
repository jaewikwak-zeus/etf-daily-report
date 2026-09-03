// output/weekly-etf-insight-<날짜>.md 리포트를 읽어서, 웹 대시보드 저장소(DB)에 올릴 수 있는
// JSON 형식으로 변환하는 스크립트. weekly_report_mvp.js 실행 → (사람/Claude가 주요 분석 채움) →
// 이 스크립트로 변환, 순서로 사용합니다.
//
// 실행 방법: node code/parse_report.js 2026-09-04
// 결과: output/data/2026-09-04.json 생성

const fs = require('fs');
const path = require('path');

const DATE = process.argv[2];
if (!DATE) {
  console.error('사용법: node code/parse_report.js YYYY-MM-DD');
  process.exit(1);
}

const CODE_DIR = __dirname;
const BASE_DIR = path.join(CODE_DIR, '..');
const REPORT_PATH = path.join(BASE_DIR, 'output', `weekly-etf-insight-${DATE}.md`);
const CONFIG_PATH = path.join(CODE_DIR, 'config.json');
const OUT_DIR = path.join(BASE_DIR, 'output', 'data');
const OUT_PATH = path.join(OUT_DIR, `${DATE}.json`);

if (!fs.existsSync(REPORT_PATH)) {
  console.error(`리포트 파일을 찾을 수 없습니다: ${REPORT_PATH}`);
  process.exit(1);
}

const md = fs.readFileSync(REPORT_PATH, 'utf-8');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const themeByTicker = {};
for (const item of config.대상ETF) themeByTicker[item.티커] = item.테마;

function 가격파싱(s) {
  s = s.trim();
  if (s === '-' || s === '') return { 값: null, 통화: null };
  const m = s.match(/^([\d,]+\.?\d*)\s+([A-Z]{3})$/);
  if (!m) return { 값: null, 통화: null };
  return { 값: parseFloat(m[1].replace(/,/g, '')), 통화: m[2] };
}
function 정수파싱(s) {
  s = s.trim();
  if (s === '-' || s === '') return null;
  const n = parseInt(s.replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}
function 퍼센트파싱(s) {
  s = s.trim();
  if (s === '-' || s === '') return null;
  const n = parseFloat(s.replace(/%/g, ''));
  return isNaN(n) ? null : n;
}
function notes파싱(s) {
  s = s.trim();
  if (s === '-' || s === '') return [];
  return s.split(/\s+/).map((tok) => {
    const 방향 = tok.endsWith('▲') ? '상승' : '하락';
    const 기간 = tok.slice(0, -1);
    return { 기간, 방향 };
  });
}

const genLine = md.match(/생성 일시:\s*(.+)/);
const baseLine = md.match(/작성기준일\s*:\s*([\d-]+)/);

// ---- 종목별 현황 표 파싱 (18열) ----
const rows = [];
const tableSection = md.split('## 종목별 현황')[1].split('## 요약')[0];
const lines = tableSection.split('\n').filter((l) => l.trim().startsWith('|'));
for (let i = 2; i < lines.length; i++) {
  const cells = lines[i].split('|').map((c) => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
  if (cells.length < 18) continue;
  const [
    티커, 구분, 이름, 시장, 최근, 거래량, 전일전, 일주전, 일달전, 삼개월전, 일년전,
    일일수익, 일주수익, 일달수익, 삼개월수익, 일년수익, notes, 상태원문,
  ] = cells;

  let 상태카테고리 = '정상';
  if (상태원문.includes('실패')) 상태카테고리 = '실패';
  else if (상태원문.includes('확인 필요')) 상태카테고리 = '부분확인필요';

  const 최근가 = 가격파싱(최근);
  rows.push({
    티커, 구분, 이름, 시장,
    통화: 최근가.통화 || (시장 === '국내' ? 'KRW' : 'USD'),
    최근: 최근가.값,
    거래량: 정수파싱(거래량),
    전일전: 가격파싱(전일전).값, 일주전: 가격파싱(일주전).값, 일달전: 가격파싱(일달전).값,
    삼개월전: 가격파싱(삼개월전).값, 일년전: 가격파싱(일년전).값,
    일일수익률: 퍼센트파싱(일일수익), 일주수익률: 퍼센트파싱(일주수익), 일달수익률: 퍼센트파싱(일달수익),
    삼개월수익률: 퍼센트파싱(삼개월수익), 일년수익률: 퍼센트파싱(일년수익),
    notes: notes파싱(notes),
    상태카테고리, 상태원문,
    테마: themeByTicker[티커] || '',
  });
}

// ---- 주요 분석 파싱 ----
const notesList = [];
const notesSection = md.split('## 주요 분석')[1].split('## 참고')[0];
const noteBlocks = notesSection.split(/\*\*\[(\d+)\]/).slice(1);
for (let i = 0; i < noteBlocks.length; i += 2) {
  const 번호 = parseInt(noteBlocks[i], 10);
  const body = noteBlocks[i + 1];
  const headerMatch = body.match(/^\s*([^\(]+)\(([^)]+)\)\s*—\s*(.+?),\s*1일 수익률\s*([-\d.]+)%\*\*/);
  const textMatch = body.match(/\*\*\n> (.+?)(?:\n> 출처: \[(.+?)\]\((.+?)\))?\n\n/s);
  // 분석 내용이 비어있으면(placeholder 그대로면) 목록에서 제외 — "기사 없으면 패스" 원칙
  const 분석텍스트 = textMatch ? textMatch[1].replace(/\n> /g, ' ').trim() : '';
  if (!headerMatch || !분석텍스트 || 분석텍스트.includes('확인 필요 — 아직 작성되지')) continue;
  notesList.push({
    번호,
    티커: headerMatch[1].trim(),
    이름: headerMatch[2].trim(),
    태그: headerMatch[3].trim(),
    일일수익률: parseFloat(headerMatch[4]),
    분석: 분석텍스트,
    출처제목: textMatch[2] || null,
    출처링크: textMatch[3] || null,
  });
}

const result = {
  날짜: DATE,
  생성일시: genLine ? genLine[1].trim() : '',
  작성기준일: baseLine ? baseLine[1].trim() : DATE,
  종목: rows,
  주요분석: notesList,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), 'utf-8');
console.log(`[${DATE}] 종목 ${rows.length}개, 주요분석 ${notesList.length}건 파싱 완료 -> ${OUT_PATH}`);
