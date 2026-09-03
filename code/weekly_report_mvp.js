// ============================================================
// 주간 ETF 리포트 자동 생성 (MVP v4 - 거래량 / 1일 등락 / 전종목 분석후보)
// ------------------------------------------------------------
// v3 대비 변경점
//   - 최근종가 옆에 거래량(최근 거래일 기준) 추가
//   - "1일(전일 대비)" 기간 추가 — 매일 모니터링에 맞춰 표에도, notes에도 반영
//   - notes 기준 변경: 특정 기간 top5/bottom5가 아니라, "당일 등락폭이 threshold
//     이상인 종목"을 전부 후보로 표시. (사용자 요청: "모든 종목을 다 살펴보되
//     관련 기사가 없으면 패스" — 등락폭이 작으면 뉴스가 있을 가능성이 낮으므로
//     그런 종목은 검색 없이 자동으로 패스 처리해 매일 조사량을 현실적으로 유지)
//
// ★ 이 스크립트가 여전히 "못 하는" 것: notes 후보로 표시된 종목에 대해
//   "실제로 무슨 뉴스가 있었는지" 찾아 글을 쓰는 것은 여전히 사람(Claude)의 몫입니다.
//
// 실행 방법: "주간ETF리포트_자동화" 폴더에서
//   node code/weekly_report_mvp.js
// ============================================================

const fs = require('fs');
const path = require('path');

const CODE_DIR = __dirname;
const BASE_DIR = path.join(CODE_DIR, '..');
const OUTPUT_DIR = path.join(BASE_DIR, 'output');
const LOG_DIR = path.join(OUTPUT_DIR, 'logs');
const CONFIG_PATH = path.join(CODE_DIR, 'config.json');

// notes 후보로 표시할 "당일 등락률" 기준선. 이 값 미만이면 뉴스가 있을 가능성이
// 낮다고 보고 자동으로 패스합니다 (검색 없이).
const 당일등락_후보기준 = 2.0; // %

const 기간정의 = [
  { key: '1일', 일수: 1 },
  { key: '1주', 일수: 7 },
  { key: '1달', 일수: 30 },
  { key: '3개월', 일수: 91 },
  { key: '1년', 일수: 365 },
];

function 오늘날짜문자열() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function 지금시각문자열() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  return `${date} ${time}`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function 화폐(시장) {
  return 시장 === '국내' ? 'KRW' : 'USD';
}

const 로그목록 = [];
function 로그남기기(내용) {
  const 줄 = `[${지금시각문자열()}] ${내용}`;
  로그목록.push(줄);
  console.log(줄);
}
function 로그저장() {
  const 로그경로 = path.join(LOG_DIR, `실행로그-${오늘날짜문자열()}.txt`);
  fs.writeFileSync(로그경로, 로그목록.join('\n') + '\n', 'utf-8');
}

function 설정읽기() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`설정 파일을 찾을 수 없습니다: ${CONFIG_PATH}`);
  }
  const 설정 = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  if (!Array.isArray(설정.대상ETF) || 설정.대상ETF.length === 0) {
    throw new Error('config.json 안에 "대상ETF" 목록이 비어있거나 형식이 올바르지 않습니다.');
  }
  return 설정.대상ETF;
}

async function 캔들목록조회(티커) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(티커)}?range=2y&interval=1d`;
  const 응답 = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!응답.ok) throw new Error(`야후 파이낸스 응답 오류 (HTTP ${응답.status})`);

  const json = await 응답.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const 에러메시지 = json?.chart?.error?.description || '데이터 없음';
    throw new Error(`시세 데이터를 찾을 수 없습니다 (${에러메시지})`);
  }

  const 시각목록 = result.timestamp || [];
  const 종가목록 = result.indicators?.quote?.[0]?.close || [];
  const 거래량목록 = result.indicators?.quote?.[0]?.volume || [];
  const 캔들목록 = [];
  for (let i = 0; i < 시각목록.length; i++) {
    const 종가 = 종가목록[i];
    if (typeof 종가 === 'number') {
      캔들목록.push({ 시각: 시각목록[i] * 1000, 종가, 거래량: typeof 거래량목록[i] === 'number' ? 거래량목록[i] : null });
    }
  }
  if (캔들목록.length < 6) throw new Error(`유효 거래일 데이터가 부족합니다 (${캔들목록.length}일)`);
  return 캔들목록;
}

function 기간전종가찾기(캔들목록, 기준시각, 기간일수) {
  const 목표시각 = 기준시각 - 기간일수 * 24 * 60 * 60 * 1000;
  for (let i = 캔들목록.length - 1; i >= 0; i--) {
    if (캔들목록[i].시각 <= 목표시각) return 캔들목록[i].종가;
  }
  return null;
}

async function 종목분석(종목) {
  const 캔들목록 = await 캔들목록조회(종목.티커);
  const 최근캔들 = 캔들목록[캔들목록.length - 1];
  const 최근종가 = 최근캔들.종가;

  const 가격 = { 최근: 최근종가 };
  const 수익률 = {};
  const 부족한기간 = [];

  for (const { key, 일수 } of 기간정의) {
    const 과거종가 = 기간전종가찾기(캔들목록, 최근캔들.시각, 일수);
    가격[key] = 과거종가;
    if (과거종가 !== null && 과거종가 !== 0) {
      수익률[key] = ((최근종가 - 과거종가) / 과거종가) * 100;
    } else {
      수익률[key] = null;
      부족한기간.push(key);
    }
  }

  const 상태 = 부족한기간.length === 0 ? '정상' : '부분 확인 필요';
  return { ...종목, 상태, 가격, 수익률, 부족한기간, 최근거래량: 최근캔들.거래량, notes: [] };
}

// ---------- notes 후보 선정: 당일(1일) 등락폭이 기준선 이상인 종목 전부 ----------
function notes후보선정(결과목록) {
  const 후보 = [];
  for (const r of 결과목록) {
    if (r.상태 === '실패') continue;
    const 일일 = r.수익률?.['1일'];
    if (일일 === null || 일일 === undefined) continue;
    if (Math.abs(일일) >= 당일등락_후보기준) {
      r.notes = [{ 기간: '1일', 방향: 일일 >= 0 ? '상승' : '하락' }];
      후보.push(r);
    }
  }
  // 등락폭이 큰 순서대로 정렬 (상승/하락 구분 없이 절대값 기준)
  후보.sort((a, b) => Math.abs(b.수익률['1일']) - Math.abs(a.수익률['1일']));
  let 번호 = 1;
  for (const r of 후보) r.notes번호 = 번호++;
  return 후보;
}

function 소수점(n) {
  return n === null || n === undefined ? '-' : n.toFixed(2);
}
function 가격표시(n, 통화) {
  return n === null || n === undefined ? '-' : `${n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${통화}`;
}
function 거래량표시(n) {
  return n === null || n === undefined ? '-' : n.toLocaleString('ko-KR');
}
function 퍼센트(n) {
  return n === null || n === undefined ? '-' : `${n.toFixed(2)}%`;
}
function notes태그문자열(notesArr) {
  if (!notesArr || notesArr.length === 0) return '-';
  return notesArr.map((n) => `${n.기간}${n.방향 === '상승' ? '▲' : '▼'}`).join(' ');
}

function 리포트본문작성(결과목록, 노트후보) {
  const 기준일 = 오늘날짜문자열();
  const 실패목록 = 결과목록.filter((r) => r.상태 === '실패');
  const 성공목록 = 결과목록.filter((r) => r.상태 !== '실패');

  let md = '';
  md += `# 일일 ETF 동향 (MVP 자동 생성)\n\n`;
  md += `- 생성 일시: ${지금시각문자열()}\n`;
  md += `- 대상 종목 수: ${결과목록.length}개\n`;
  md += `- 비교 기간: 1일(전일 대비) · 1주 · 1달 · 3개월 · 1년 — 모두 "최근종가" 기준 역산, 달력일수 근사치\n`;
  md += `- notes 후보 기준: 1일(당일) 등락률 절대값 ${당일등락_후보기준}% 이상 (그 미만은 뉴스가 있을 가능성이 낮다고 보고 자동 패스)\n`;
  md += `- 데이터 출처: Yahoo Finance 공개 시세\n\n`;

  md += `## 종목별 현황(작성기준일 : ${기준일})\n\n`;
  md += `| 티커 | 구분 | 이름 | 시장 | 최근종가 | 거래량 | 전일종가 | 1주전종가 | 1달전종가 | 3개월전종가 | 1년전종가 | 1일수익률 | 1주수익률 | 1달수익률 | 3개월수익률 | 1년수익률 | notes | 상태 |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of 결과목록) {
    const 통화 = 화폐(r.시장);
    if (r.상태 === '실패') {
      md += `| ${r.티커} | ${r.구분} | ${r.이름} | ${r.시장} | - | - | - | - | - | - | - | - | - | - | - |  | ⚠️ 실패 (${r.에러메시지}) |\n`;
      continue;
    }
    const notes표시 = notes태그문자열(r.notes);
    const 상태표시 = r.상태 === '정상' ? '정상' : `⚠️ 부분 확인 필요 (${r.부족한기간.join('·')} 데이터 없음)`;
    md += `| ${r.티커} | ${r.구분} | ${r.이름} | ${r.시장} | ${가격표시(r.가격.최근, 통화)} | ${거래량표시(r.최근거래량)} | ${가격표시(r.가격['1일'], 통화)} | ${가격표시(r.가격['1주'], 통화)} | ${가격표시(r.가격['1달'], 통화)} | ${가격표시(r.가격['3개월'], 통화)} | ${가격표시(r.가격['1년'], 통화)} | ${퍼센트(r.수익률['1일'])} | ${퍼센트(r.수익률['1주'])} | ${퍼센트(r.수익률['1달'])} | ${퍼센트(r.수익률['3개월'])} | ${퍼센트(r.수익률['1년'])} | ${notes표시} | ${상태표시} |\n`;
  }

  md += `\n## 요약\n\n`;
  md += `- 정상 조회: ${성공목록.filter((r) => r.상태 === '정상').length}건 / 부분 확인 필요: ${성공목록.filter((r) => r.상태 === '부분 확인 필요').length}건 / 완전 실패: ${실패목록.length}건\n`;
  md += `- 당일 등락률 ${당일등락_후보기준}% 이상인 notes 후보: ${노트후보.length}건. 아래 "주요 분석"에서 실제 관련 기사가 있는 것만 정리됩니다(없으면 패스).\n`;
  if (실패목록.length > 0) {
    md += `- ⚠️ 다음 종목은 데이터를 아예 가져오지 못했습니다: ${실패목록.map((r) => `${r.티커}(${r.에러메시지})`).join(', ')}\n`;
  }

  md += `\n## 주요 분석\n\n`;
  md += `> 이 목록은 "당일 등락률 ${당일등락_후보기준}% 이상" 후보를 뽑은 것으로, 실제 분석 글은 스크립트가 아니라 사람(Claude)이 그날그날 검색해서 채웁니다. 관련 기사를 찾지 못한 종목은 이 리포트에서 빠집니다(패스).\n\n`;
  for (const r of 노트후보) {
    md += `**[${r.notes번호}] ${r.티커} (${r.이름}) — ${notes태그문자열(r.notes)}, 1일 수익률 ${퍼센트(r.수익률['1일'])}**\n`;
    md += `> (분석 내용 확인 필요 — 아직 작성되지 않음)\n\n`;
  }

  md += `## 참고\n\n`;
  md += `- 이 문서는 MVP(최소 기능) 버전 결과물입니다. 레버리지 ETF 별도 표시, ETFCheck 교차검증, 방송 스크립트 변환 등은 아직 포함되어 있지 않습니다.\n`;
  md += `- "확인 필요"·"실패"로 표시된 항목은 자동으로 값을 지어내지 않고 비워둔 것입니다. 사람이 직접 확인해주세요.\n`;
  md += `- 거래량은 최근 거래일 하루치 체결 수량(주)입니다.\n`;

  return md;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  로그남기기('=== 일일 ETF 리포트 MVP v4 실행 시작 ===');

  let 대상목록;
  try {
    대상목록 = 설정읽기();
    로그남기기(`설정 읽기 완료: 대상 ${대상목록.length}개 종목`);
  } catch (e) {
    로그남기기(`[실패] 설정 파일 읽기 실패: ${e.message}`);
    로그저장();
    process.exit(1);
  }

  const 결과목록 = [];
  let 진행 = 0;
  for (const 종목 of 대상목록) {
    진행++;
    try {
      const 결과 = await 종목분석(종목);
      결과목록.push(결과);
      if (결과.상태 === '정상') {
        로그남기기(`[성공] (${진행}/${대상목록.length}) ${종목.티커} (${종목.이름}) - 최근종가 ${결과.가격.최근.toFixed(2)}, 1일 ${결과.수익률['1일'] === null ? '-' : 결과.수익률['1일'].toFixed(2) + '%'}`);
      } else {
        로그남기기(`[부분성공] (${진행}/${대상목록.length}) ${종목.티커} (${종목.이름}) - 부족한 기간: ${결과.부족한기간.join('·')}`);
      }
    } catch (e) {
      결과목록.push({ ...종목, 상태: '실패', 에러메시지: e.message, 가격: {}, 수익률: {}, notes: [] });
      로그남기기(`[실패] (${진행}/${대상목록.length}) ${종목.티커} (${종목.이름}) - 사유: ${e.message}`);
    }
    await sleep(300);
  }

  const 노트후보 = notes후보선정(결과목록);
  const md = 리포트본문작성(결과목록, 노트후보);
  const 리포트경로 = path.join(OUTPUT_DIR, `weekly-etf-insight-${오늘날짜문자열()}.md`);
  fs.writeFileSync(리포트경로, md, 'utf-8');
  로그남기기(`리포트 저장 완료: ${리포트경로}`);

  const 정상수 = 결과목록.filter((r) => r.상태 === '정상').length;
  const 부분수 = 결과목록.filter((r) => r.상태 === '부분 확인 필요').length;
  const 실패수 = 결과목록.filter((r) => r.상태 === '실패').length;
  로그남기기(`=== 실행 종료: 정상 ${정상수}건 / 부분 확인 필요 ${부분수}건 / 실패 ${실패수}건 / notes 후보 ${노트후보.length}건 ===`);

  로그저장();
}

main().catch((e) => {
  로그남기기(`[치명적 오류] 예상치 못한 문제로 중단되었습니다: ${e.message}`);
  로그저장();
  process.exit(1);
});
