// Client script of the `sim:human` report. report.ts inlines it into report.html.
// It reads the two JSON blocks of the page and draws every chart as inline SVG. It loads nothing.
(() => {
  'use strict';

  const DATA = JSON.parse(document.getElementById('human-data').textContent);
  const RUN = JSON.parse(document.getElementById('run-data').textContent);
  const SVG_NS = document.getElementById('svg-namespace').namespaceURI;
  const app = document.getElementById('app');

  // ---------------------------------------------------------------- elements and formats

  function fill(node, attrs, kids) {
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  const h = (tag, attrs, ...kids) => fill(document.createElement(tag), attrs, kids);
  const s = (tag, attrs, ...kids) => fill(document.createElementNS(SVG_NS, tag), attrs, kids);

  const int = (x) => Math.round(x).toLocaleString('ko-KR');
  const fixed = (x, digits) => x.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const pct = (x, digits = 1) => `${fixed(100 * x, digits)}%`;
  const pp = (x, digits = 1) => `${x >= 0 ? '+' : '−'}${fixed(100 * Math.abs(x), digits)}%p`;
  const pm = (x, digits = 2) => `±${fixed(100 * x, digits)}%p`;
  const times = (x) => `${fixed(x, 2)}배`;
  const bets = (x) => `${fixed(x, Math.abs(x) < 100 ? 1 : 0)}베팅`;
  const tierName = (tier) => `${tier.n}×${tier.n}`;
  const b = (text) => h('b', null, text);
  const Z = 1.959963984540054;

  const rows = new Map(DATA.rows.map((row) => [row.id, row]));
  const COLORED = new Set(['novice', 'average', 'thoughtful', 'learning', 'best-rule']);
  const colorOf = (id) => (COLORED.has(id) ? `var(--m-${id})` : 'var(--m-other)');
  const nameOf = (id) => rows.get(id).name;
  const shortName = (id) => nameOf(id).replace(' 플레이어', '');
  const SESSION_ROWS = ['novice', 'average', 'thoughtful', 'learning', 'best-rule'];
  const MOVE_NAME = { exit: '출구 쪽', space: '넓은 쪽', route: '가장 짧은 길' };
  const FORK_NAME = { any: '모든 갈림길', even: '어느 쪽도 뚜렷이 낫지 않은 갈림길', away: '모든 갈래가 출구에서 멀어지는 갈림길' };
  const STOP_FORK_NAME = { any: '갈림길', even: '뚜렷이 나은 쪽이 없는 갈림길', away: '모든 갈래가 멀어지는 갈림길' };

  function niceStep(span, count) {
    const raw = span / Math.max(1, count);
    const power = 10 ** Math.floor(Math.log10(raw));
    const unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
  }
  function niceAxis(min, max, count) {
    if (!(max > min)) max = min + 1;
    const step = niceStep(max - min, count);
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let i = 0; lo + i * step <= hi + step * 1e-9; i++) ticks.push(Number((lo + i * step).toPrecision(12)));
    return { lo, hi, ticks };
  }

  // ---------------------------------------------------------------- tooltip

  const tip = h('div', { class: 'tip', role: 'status' });
  function showTip(event, title, lines) {
    tip.replaceChildren();
    fill(tip, null, [
      h('div', { class: 'title' }, title),
      lines.map((line) =>
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'name' }, line.color ? h('span', { class: 'key-line', style: `border-color:${line.color}` }) : null, line.name),
          h('span', { class: 'val' }, line.value),
        ),
      ),
    ]);
    tip.style.visibility = 'visible';
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let x = event.clientX + 14;
    let y = event.clientY + 14;
    if (x + width > window.innerWidth - 8) x = event.clientX - width - 14;
    if (y + height > window.innerHeight - 8) y = event.clientY - height - 14;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() {
    tip.style.visibility = 'hidden';
  }
  /** Shows a tooltip while the pointer is over `target`; dims the other marks of `marks` and lifts `group`. */
  function hover(target, group, marks, title, lines) {
    target.addEventListener('pointermove', (event) => {
      if (marks) marks.classList.add('dim');
      if (group) group.classList.add('on');
      showTip(event, title, lines);
    });
    target.addEventListener('pointerleave', () => {
      if (marks) marks.classList.remove('dim');
      if (group) group.classList.remove('on');
      hideTip();
    });
  }

  // ---------------------------------------------------------------- chart parts

  /** Width of a chart that spans its card: wide on a wide window, so that its text keeps its size. */
  const fullWidth = () => (window.innerWidth > 900 ? 1160 : 600);
  function chartRoot(width, height, label) {
    return s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, style: `max-width:${Math.round(width * 1.25)}px` });
  }
  function legend(items) {
    return h(
      'div',
      { class: 'legend' },
      items.map((item) => h('span', null, h('span', { class: `key-${item.key}`, style: item.key === 'line' ? `border-color:${item.color}` : `background:${item.color}` }), item.text)),
    );
  }
  function table(headers, body, wrapColumns = []) {
    return h(
      'div',
      { class: 'scroll' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, headers.map((header, i) => h('th', { class: wrapColumns.includes(i) ? 'prose' : null }, header)))),
        h(
          'tbody',
          null,
          body.map((row) =>
            row.group ? h('tr', { class: 'group' }, h('td', { colspan: headers.length }, row.group)) : h('tr', null, row.map((cell, i) => h('td', { class: wrapColumns.includes(i) ? 'prose' : null }, cell))),
          ),
        ),
      ),
    );
  }
  /** The numbers behind a chart, for readers who cannot or do not want to read them off the marks. */
  const tableView = (...tables) => h('details', null, h('summary', null, '표로 보기'), tables);
  const assumptionBadge = () => h('span', { class: 'badge' }, '가정');
  const rowCell = (id) => h('span', { class: 'name-cell' }, h('span', { class: 'swatch', style: `background:${colorOf(id)}` }), nameOf(id));
  function figure(title, caption, wide, ...body) {
    return h('figure', { class: wide ? 'card wide' : 'card' }, h('figcaption', null, h('h3', null, title), caption ? h('p', null, caption) : null), body);
  }
  function section(title, note, ...body) {
    return h('section', null, h('h2', null, title), note ? h('p', { class: 'section-note' }, note) : null, body);
  }

  // ---------------------------------------------------------------- state and lookups

  const state = { table: 0, tier: 0 };
  const currentTable = () => DATA.tables[state.table];
  const currentTier = () => currentTable().tiers[Math.min(state.tier, currentTable().tiers.length - 1)];
  const cellOf = (tier, row) => tier.cells.find((cell) => cell.row === row);
  const variantName = (id) => DATA.variants.find((variant) => variant.id === id).name;

  /** How much of the house's margin over naive play a simple rule takes away. */
  function riskOf(tier) {
    const gap = tier.ruleGap.toValueLsm;
    if (gap === null) return { level: 'mid', text: '인증 기록 없음' };
    if (gap.difference + gap.halfWidth >= -0.01) return { level: 'high', text: '위험: value-lsm에 1%p 안까지 붙음' };
    if (tier.ruleGap.closedShare !== null && tier.ruleGap.closedShare >= 0.75) return { level: 'mid', text: '주의: naive와의 간격을 4분의 3 넘게 메움' };
    return { level: 'low', text: '간격이 넉넉함' };
  }

  // ---------------------------------------------------------------- header and notes

  function headerSection() {
    const o = DATA.options;
    const themeButtons = [
      ['auto', '자동'],
      ['light', '밝게'],
      ['dark', '어둡게'],
    ].map(([mode, text]) => {
      const button = h('button', { type: 'button', 'data-mode': mode }, text);
      button.addEventListener('click', () => setTheme(mode));
      return button;
    });
    return h(
      'header',
      null,
      h(
        'div',
        { class: 'head' },
        h(
          'div',
          null,
          h('h1', null, '사람이 플레이할 때: 미로 게임 시뮬레이션'),
          h('p', { class: 'lede' }, '사람처럼 판단하는 플레이어 모형들과, 사람이 머릿속으로 적용할 수 있는 가장 강한 규칙이 이 게임에서 어떤 결과를 내는지, 그리고 그것이 최강 AI(value-lsm)와 얼마나 차이 나는지를 보여 줍니다.'),
        ),
        h('div', { class: 'theme', role: 'group', 'aria-label': '색 테마' }, themeButtons),
      ),
      h(
        'dl',
        { class: 'meta' },
        h('dt', null, '튜닝 표'),
        h(
          'dd',
          null,
          DATA.tables.map((entry) =>
            h('div', null, `${entry.label}: `, h('code', null, entry.path), ` (해시 ${entry.tableHash.slice(0, 10)}…, ${entry.certified ? '인증 통과' : '이 코드로 인증된 기록 없음'}) — `, entry.tiers.map((tier) => `${tierName(tier)} 출구 ${fixed(tier.multiplier, 4)}배`).join(', ')),
          ),
        ),
        h('dt', null, '판 수'),
        h('dd', null, `모형 × 크기마다 평가용 ${int(o.games)}판 (같은 크기에서는 모든 모형이 같은 미로), 규칙 탐색은 길 고르는 방법마다 학습용 ${int(o.trainGames)}판, 배우는 플레이어는 ${int(o.careers)}명이 각자 처음부터 ${int(o.careerGames)}판`),
        h('dt', null, '뱅크롤 세션'),
        h('dd', null, `모형 × 크기마다 ${int(o.sessions)}명, 세션 행동 조합마다 ${int(o.behaviourSessions)}명, 시작 ${int(o.bankroll)}베팅, 최대 ${int(o.gameCap)}판`),
        h('dt', null, '미로'),
        h(
          'dd',
          null,
          '이 명령 전용 흐름 ',
          h('code', null, DATA.stream.label),
          ` (기준 시드 ${DATA.stream.base}, 시드 ${o.seed}). 인증 흐름 A–E와 ${DATA.stream.disjoint ? '겹치지 않으므로' : '겹치므로(!)'} 인증(흐름 B의 앞쪽 2^24판)이나 sim:stats(흐름 B의 2^32번째 판부터)가 쓴 미로는 한 판도 없습니다. 학습용과 평가용 미로도 서로 겹치지 않습니다.`,
        ),
        h('dt', null, '실행'),
        h('dd', null, `${RUN.generatedAt} · ${fixed(RUN.seconds, 1)}초 · 워커 ${RUN.workers} · `, h('code', null, RUN.command)),
      ),
    );
  }

  function noteSection() {
    return h(
      'section',
      { class: 'card note' },
      h('h3', null, '읽기 전에'),
      h(
        'ul',
        null,
        h('li', null, h('strong', null, '사람 모형은 가정입니다. '), '실제 플레이어 데이터는 없습니다. 각 모형의 행동(실수 비율, 손절 기준, 전망이론 매개변수, 학습 속도)은 행동경제학·도박 연구의 일반적인 발견을 빌려 정한 값이고, 이 게임의 플레이어를 잰 것이 아닙니다. ', assumptionBadge(), ' 표시가 붙은 숫자는 그 위에 다시 플레이어 구성이나 세션 행동을 가정합니다.'),
        h('li', null, h('strong', null, '가정과 무관한 숫자. '), '"배울 수 있는 최선의 규칙"과 value-lsm, naive-greedy는 정해진 규칙이 실제로 낸 결과입니다. 규칙은 학습용 미로에서 골랐고 숫자는 겹치지 않는 평가용 미로에서 다시 쟀습니다.'),
        h('li', null, h('strong', null, '비교 기준. '), 'value-lsm과 naive-greedy의 숫자는 인증 기록(certify.json, 수백만 판)에서 가져왔습니다. 이 실행의 표본과는 서로 독립이라 차이의 95% 구간은 두 오차를 합칩니다.'),
        h('li', null, h('strong', null, '즉시 캐시아웃이 바닥입니다. '), '베팅 직후 그만두면 언제나 95%를 돌려받습니다. 어떤 규칙이든 95%보다 낮으면 "아예 안 하는 것"보다 못하고, 하우스는 어떤 플레이어에게서도 적어도 value-lsm 상대 몫(4~5%)은 남깁니다.'),
        h('li', null, h('strong', null, '오차. '), '±는 95% 신뢰구간의 반폭입니다. 큰 미로는 출구에 닿는 판이 드물어 같은 판 수에서도 구간이 넓습니다. 더 좁히려면 --games를 늘리세요.'),
      ),
    );
  }

  // ---------------------------------------------------------------- verdict

  function verdictSection() {
    const entry = currentTable();
    const population = entry.population;
    const tiles = entry.tiers.map((tier) => {
      const risk = riskOf(tier);
      const gap = tier.ruleGap.toValueLsm;
      return h(
        'div',
        { class: 'tile' },
        h('div', { class: 'label' }, `${tierName(tier)} · 배울 수 있는 최선의 규칙`),
        h('div', { class: 'value' }, `${pct(tier.ruleGap.rtp, 1)} `, h('span', { class: 'sub' }, pm(tier.ruleGap.halfWidth, 1))),
        h(
          'div',
          { class: 'sub' },
          gap === null ? 'value-lsm 인증 기록 없음' : `value-lsm ${pct(tier.certified.valueLsm.rtp, 1)}와 ${pp(gap.difference, 1)} (${pm(gap.halfWidth, 1)})`,
          tier.ruleGap.closedShare === null ? null : ` · naive→value-lsm 간격의 ${pct(tier.ruleGap.closedShare, 0)}`,
        ),
        h('div', { class: `risk ${risk.level}` }, risk.text),
      );
    });
    const mix = population.mix;
    const money = [
      { label: '가정한 사람들 상대', value: population.houseTake.humans, sub: `초보 ${pct(mix.novice, 0)}, 보통 ${pct(mix.average, 0)}, 생각 ${pct(mix.thoughtful, 0)}, 배우는 ${pct(mix.learning, 0)} · 크기 비율 ${population.tierShare.map((share) => pct(share, 0)).join('/')}` },
      { label: '모두 최선의 규칙을 쓸 때', value: population.houseTake.bestRule, sub: '같은 크기 비율로 가중' },
      { label: '모두 value-lsm일 때', value: population.houseTake.valueLsm, sub: '인증 기록, 같은 크기 비율' },
      { label: '모두 즉시 캐시아웃할 때', value: population.houseTake.immediateCashout, sub: '게임을 하지 않는 것과 같음' },
    ];
    return section(
      `결론 · ${entry.label}`,
      '하우스 수익은 "최선의 플레이도 내주는 몫(약 4~5%)"과 "실제 사람이 두는 방식" 사이의 차이에서 나옵니다. 위 칸은 사람이 배울 수 있는 단순한 규칙이 그 차이를 얼마나 메우는지, 아래 칸은 크기별 이용 비율로 가중한 하우스 몫입니다.',
      h('div', { class: 'verdict' }, tiles),
      h(
        'div',
        { class: 'tiles', style: 'margin-top:10px' },
        money.map((item) =>
          h('div', { class: 'tile' }, h('div', { class: 'label' }, item.label, ' ', assumptionBadge()), h('div', { class: 'value' }, item.value === null ? '–' : `하우스 ${pct(item.value, 1)}`), h('div', { class: 'sub' }, item.sub)),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- return per model (dot plot)

  function rtpChart(tier) {
    const width = fullWidth();
    const left = width > 700 ? 250 : 200;
    const rowHeight = 24;
    const top = 34;
    const height = top + tier.cells.length * rowHeight + 40;
    const svg = chartRoot(width, height, `${tierName(tier)} 모형별 환수율`);
    const box = { x0: left, x1: width - 64, y0: top, y1: height - 40 };
    const lsm = tier.certified.valueLsm;
    const naive = tier.certified.naiveGreedy;
    const low = Math.min(...tier.cells.map((cell) => cell.rtp.ci95[0]), naive ? naive.rtp : 1);
    const axis = niceAxis(Math.max(0, low - 0.03), 1, 6);
    const sx = (v) => box.x0 + ((Math.min(1, v) - axis.lo) / (1 - axis.lo)) * (box.x1 - box.x0);
    for (const tick of axis.ticks) {
      if (tick > 1 + 1e-9) continue;
      svg.append(s('line', { class: 'gridline', x1: sx(tick), x2: sx(tick), y1: box.y0, y2: box.y1 }));
      svg.append(s('text', { x: sx(tick), y: box.y1 + 15, 'text-anchor': 'middle' }, pct(tick, 0)));
    }
    svg.append(s('text', { class: 'axis-title', x: (box.x0 + box.x1) / 2, y: height - 4, 'text-anchor': 'middle' }, '환수율 (돌려받은 돈 / 건 돈) · 100%까지 남은 거리가 하우스 몫'));
    const refs = [naive ? { v: naive.rtp, text: `naive ${pct(naive.rtp, 1)}` } : null, { v: 0.95, text: '즉시 캐시아웃 95%' }, lsm ? { v: lsm.rtp, text: `value-lsm ${pct(lsm.rtp, 1)}` } : null].filter(Boolean);
    refs.forEach((ref, i) => {
      svg.append(s('line', { class: 'reference', x1: sx(ref.v), x2: sx(ref.v), y1: box.y0 - 4, y2: box.y1 }));
      const anchor = ref.v === 0.95 ? 'end' : ref.v > 0.95 ? 'start' : 'middle';
      svg.append(s('text', { x: sx(ref.v) + (anchor === 'start' ? 3 : anchor === 'end' ? -3 : 0), y: box.y0 - (i % 2 === 0 ? 8 : 20), 'text-anchor': anchor }, ref.text));
    });
    const marks = s('g', null);
    const hits = s('g', null);
    tier.cells.forEach((cell, r) => {
      const y = box.y0 + r * rowHeight + rowHeight / 2;
      svg.append(s('text', { class: 'row-label', x: box.x0 - 10, y: y + 4, 'text-anchor': 'end' }, nameOf(cell.row)));
      const group = s('g', { class: 'mark' });
      const lo = Math.max(axis.lo, cell.rtp.ci95[0]);
      const hi = Math.min(1, cell.rtp.ci95[1]);
      group.append(s('path', { d: `M${sx(lo)},${y}H${sx(hi)}M${sx(lo)},${y - 4}v8M${sx(hi)},${y - 4}v8`, stroke: 'var(--text-secondary)', 'stroke-width': 1.25, fill: 'none' }));
      group.append(s('circle', { class: 'ring', cx: sx(cell.rtp.mean), cy: y, r: 5.5, fill: colorOf(cell.row) }));
      marks.append(group);
      svg.append(s('text', { class: 'label', x: sx(hi) + 8, y: y + 4 }, pct(cell.rtp.mean, 1)));
      const lines = [
        { name: '환수율', value: `${pct(cell.rtp.mean, 2)} ${pm(cell.rtp.halfWidth)}` },
        { name: '하우스 몫', value: pct(cell.houseHold.value, 2) },
        { name: '출구 도착', value: pct(cell.rates.exit, 2) },
        { name: '캐시아웃', value: pct(cell.rates.cashOut, 2) },
        { name: '막다른 길', value: pct(cell.rates.deadEnd, 2) },
      ];
      if (cell.vsValueLsm) lines.push({ name: 'value-lsm 대비', value: `${pp(cell.vsValueLsm.difference, 2)} ${pm(cell.vsValueLsm.halfWidth)}` });
      const hit = s('rect', { class: 'hit', x: 0, y: y - rowHeight / 2, width, height: rowHeight });
      hover(hit, group, marks, `${tierName(tier)} · ${nameOf(cell.row)}`, lines);
      hits.append(hit);
    });
    svg.append(marks, hits);
    return svg;
  }

  function rtpSection() {
    const entry = currentTable();
    const headers = ['모형', '출구 도착', '막다른 길', '캐시아웃', '환수율', '95% 오차', '하우스 몫', 'value-lsm 대비', 'naive 대비', '평균 걸음'];
    const body = [];
    for (const tier of entry.tiers) {
      body.push({ group: `${tierName(tier)} · 출구 ${fixed(tier.multiplier, 4)}배 · 평가 ${int(cellOf(tier, 'novice').games)}판 (배우는 플레이어 ${int(cellOf(tier, 'learning').games)}판)` });
      for (const cell of tier.cells) {
        body.push([
          rowCell(cell.row),
          pct(cell.rates.exit, 2),
          pct(cell.rates.deadEnd, 2),
          pct(cell.rates.cashOut, 2),
          pct(cell.rtp.mean, 2),
          pm(cell.rtp.halfWidth),
          pct(cell.houseHold.value, 2),
          cell.vsValueLsm ? `${pp(cell.vsValueLsm.difference, 2)} ${pm(cell.vsValueLsm.halfWidth)}` : '–',
          cell.vsNaive ? `${pp(cell.vsNaive.difference, 2)} ${pm(cell.vsNaive.halfWidth)}` : '–',
          fixed(cell.meanSteps, 1),
        ]);
      }
      for (const reference of [tier.certified.valueLsm, tier.certified.naiveGreedy]) {
        if (!reference) continue;
        body.push([`${reference.bot} (인증, ${int(reference.games)}판)`, pct(reference.winRate, 2), '', '', pct(reference.rtp, 2), pm(Z * reference.se), pct(1 - reference.rtp, 2), '', '', '']);
      }
    }
    return section(
      `모형별 환수율 · ${entry.label}`,
      '점은 환수율, 가는 선은 95% 신뢰구간입니다. 세로선은 비교 기준입니다: 출구 방향으로만 가는 naive-greedy와 최강 AI value-lsm(둘 다 인증 기록), 그리고 즉시 캐시아웃(95%). 색이 있는 점이 사람 모형과 최선의 규칙이고 회색은 비교·검증용 줄입니다.',
      entry.tiers.map((tier) => figure(`${tierName(tier)} · 출구 ${times(tier.multiplier)} · 최단 경로 ${tier.shortestPath}걸음`, null, true, rtpChart(tier))),
      h(
        'div',
        { class: 'card', style: 'margin-top:14px' },
        legend(
          DATA.rows
            .filter((row) => COLORED.has(row.id))
            .map((row) => ({ key: 'box', color: colorOf(row.id), text: row.name }))
            .concat([{ key: 'box', color: 'var(--m-other)', text: '비교·검증용' }]),
        ),
        tableView(table(headers, body)),
      ),
    );
  }

  // ---------------------------------------------------------------- the learnable rule

  const SEQ = 7;
  /** Shortfall from the best stop rule, in return, at the upper edge of each class (darkest = closest). */
  const LANDSCAPE_BINS = [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05];
  const binOf = (shortfall) => {
    for (let i = 0; i < LANDSCAPE_BINS.length; i++) if (shortfall <= LANDSCAPE_BINS[i]) return SEQ - 1 - i;
    return 0;
  };

  function landscapeChart(tier) {
    const land = tier.rule.landscape;
    const width = fullWidth();
    const cols = land.maxStep.length;
    const rowsCount = land.minDistance.length;
    const left = 58;
    const top = 20;
    const cellW = Math.max(8, Math.floor((width - left - 16) / cols));
    const cellH = 16;
    const height = top + rowsCount * cellH + 46;
    const svg = chartRoot(width, height, `${tierName(tier)} 캐시아웃 조건 하나짜리 규칙의 학습용 환수율`);
    let best = Number.NEGATIVE_INFINITY;
    for (const row of land.rtp) for (const value of row) if (value > best) best = value;
    const marks = s('g', null);
    land.minDistance.forEach((d, i) => {
      const y = top + i * cellH;
      if (i % 2 === 0) svg.append(s('text', { x: left - 8, y: y + cellH - 4, 'text-anchor': 'end' }, `${d}칸`));
      land.maxStep.forEach((k, j) => {
        const value = land.rtp[i][j];
        if (!(value === value)) return;
        const x = left + j * cellW;
        const rect = s('rect', { class: 'mark', x: x + 1, y: y + 1, width: cellW - 2, height: cellH - 2, rx: 2, fill: `var(--seq-${binOf(best - value)})` });
        marks.append(rect);
        const condition = k < 0 ? '캐시아웃 조건 없음' : `출구까지 ${d}칸 이상, ${k}걸음 이하(환급 ${pct(tier.refund[k] ?? 0, 1)} 이상)`;
        hover(rect, rect, null, `${tierName(tier)} · ${condition}`, [
          { name: '학습용 환수율', value: pct(value, 2) },
          { name: '최고와의 차이', value: pp(value - best, 2) },
        ]);
      });
    });
    svg.append(marks);
    land.minDistance.forEach((d, i) => {
      land.maxStep.forEach((k, j) => {
        if (land.rtp[i][j] === best) svg.append(s('circle', { cx: left + j * cellW + cellW / 2, cy: top + i * cellH + cellH / 2, r: 3.5, fill: 'var(--surface-1)', stroke: 'var(--text-primary)', 'stroke-width': 1.5, 'pointer-events': 'none' }));
      });
    });
    land.maxStep.forEach((k, j) => {
      if (k >= 0 && k % 2 !== 0) return;
      svg.append(s('text', { x: left + j * cellW + cellW / 2, y: top + rowsCount * cellH + 14, 'text-anchor': 'middle' }, k < 0 ? '없음' : String(k)));
    });
    svg.append(s('text', { class: 'axis-title', x: left + (cols * cellW) / 2, y: height - 8, 'text-anchor': 'middle' }, '캐시아웃할 최대 걸음 수 K (그 걸음까지 = 그때의 환급액 이상이면 캐시아웃)'));
    svg.append(s('text', { class: 'axis-title', x: 0, y: 11 }, '출구까지 최소 거리 D'));
    return svg;
  }

  function ruleSection() {
    const tier = currentTier();
    const rule = tier.rule;
    const cell = cellOf(tier, 'best-rule');
    const one = cellOf(tier, 'rule-one-stop');
    const none = cellOf(tier, 'rule-no-stop');
    const gap = tier.ruleGap.toValueLsm;
    const risk = riskOf(tier);
    const evalOf = (c) => `${pct(c.rtp.mean, 2)} ${pm(c.rtp.halfWidth)}`;
    const moveName = (params) => `${params.avoidWalled ? '막힌 곳 피함 + ' : ''}${MOVE_NAME[params.move]}`;
    const stopName = (params) =>
      params.stops.length === 0
        ? '캐시아웃 안 함'
        : params.stops
            .map((stop) => `${STOP_FORK_NAME[stop.forks]}${stop.minDistance > 0 ? `, 출구까지 ${stop.minDistance}칸 이상` : ''}, ${stop.maxStep}걸음 이하 (환급 ${pct(tier.refund[stop.maxStep] ?? 0, 1)} 이상)`)
            .join(' 또는 ');
    const topRows = rule.top.map((view, i) => [String(i + 1), pct(view.train.rtp, 2), pm(view.train.halfWidth), moveName(view.params), stopName(view.params)]);
    const byMoveRows = rule.byMove.map((view) => [moveName(view.params), pct(view.train.rtp, 2), pm(view.train.halfWidth), stopName(view.params)]);
    const land = rule.landscape;
    const binText = ['5%p 넘게 낮음', '2~5%p', '1~2%p', '0.5~1%p', '0.25~0.5%p', '0.1~0.25%p', '최고에서 0.1%p 안'];
    return section(
      `배울 수 있는 최선의 규칙 · ${currentTable().label} ${tierName(tier)}`,
      `사람이 머릿속으로 적용할 수 있는 규칙 ${int(rule.candidates)}개 남짓을 학습용 미로 ${int(rule.trainGames)}판(길 고르는 방법마다)으로 채점했습니다. 길 고르는 방법 6가지(막힌 곳을 피하는지 × 출구 쪽 / 넓은 쪽 / 가장 짧은 길)에, "어떤 갈림길에서, 출구까지 몇 칸 이상 남았고, 몇 걸음 이하(= 환급액 몇 % 이상)이면 캐시아웃"하는 조건을 두 개까지 붙입니다. 고른 규칙은 학습에 쓰지 않은 평가용 미로에서 다시 쟀습니다.`,
      h(
        'div',
        { class: 'card' },
        h('h3', null, '선택된 규칙'),
        h('p', { class: 'rule-text' }, rule.best.text),
        h(
          'p',
          { class: 'facts' },
          '학습용 ',
          b(pct(rule.best.train.rtp, 2)),
          ' → 평가용 ',
          b(evalOf(cell)),
          gap === null ? '' : [' · value-lsm(인증) ', b(pct(tier.certified.valueLsm.rtp, 2)), '와의 차이 ', b(`${pp(gap.difference, 2)} ${pm(gap.halfWidth)}`)],
          tier.ruleGap.closedShare === null ? '' : [' · naive-greedy에서 value-lsm까지 간격의 ', b(pct(tier.ruleGap.closedShare, 0)), '를 메움 · '],
          h('span', { class: `risk ${risk.level}` }, risk.text),
        ),
        h('p', { class: 'facts' }, '비교: 조건 하나까지만 쓰면 평가용 ', b(evalOf(one)), ' · 캐시아웃 없이 길 고르기만 하면 ', b(evalOf(none)), ' · 즉시 캐시아웃 ', b('95.00%')),
      ),
      h(
        'div',
        { class: 'grid', style: 'margin-top:14px' },
        figure(
          '조건 하나짜리 규칙의 지형',
          `${moveName(land.part)}으로 가면서 ${FORK_NAME[land.forks]}에서 "출구까지 D칸 이상 남았고 K걸음 이하면 캐시아웃"할 때의 학습용 환수율입니다. 진할수록 그 크기에서 가장 나은 조건 하나짜리 규칙에 가깝고, 동그라미가 최고입니다. 진한 구역이 넓으면 정확한 숫자를 몰라도 그 근처면 된다는 뜻이라 사람이 배우기 쉽습니다.`,
          true,
          landscapeChart(tier),
          h('div', { class: 'scale' }, '최고와의 차이: ', binText[0], h('span', { class: 'steps' }, Array.from({ length: SEQ }, (_, i) => h('span', { style: `background:var(--seq-${i})` }))), binText[SEQ - 1]),
        ),
      ),
      h(
        'div',
        { class: 'card', style: 'margin-top:14px' },
        h('h3', null, '학습용 미로에서 가장 나았던 조건 하나짜리 규칙들'),
        h('p', { class: 'facts' }, '학습용 환수율이 똑같은 규칙(어떤 갈림길에서도 결정이 같은 규칙)은 가장 단순한 하나만 남겼습니다. 순위 사이의 차이가 오차보다 작으면 사실상 같은 수준입니다.'),
        table(['순위', '학습용 환수율', '95% 오차', '길 고르기', '캐시아웃 조건'], topRows, [4]),
        h('h3', { style: 'margin-top:14px' }, '길 고르는 방법별 최선 (조건 두 개까지)'),
        table(['길 고르기', '학습용 환수율', '95% 오차', '캐시아웃 조건'], byMoveRows, [3]),
      ),
    );
  }

  // ---------------------------------------------------------------- learning curve

  function curveChart(tier) {
    const width = 380;
    const height = 250;
    const svg = chartRoot(width, height, `${tierName(tier)} 배우는 플레이어의 판 수별 환수율`);
    const box = { x0: 46, x1: width - 16, y0: 18, y1: height - 40 };
    const curve = tier.learningCurve;
    const naive = tier.certified.naiveGreedy;
    const rule = tier.ruleGap.rtp;
    const values = curve.flatMap((point) => [point.ci95[0], point.ci95[1]]).concat([rule, naive ? naive.rtp : rule]);
    const axis = niceAxis(Math.max(0, Math.min(...values) - 0.02), Math.min(1.05, Math.max(...values) + 0.02), 4);
    const xs = curve.map((point) => (point.from + 1 + point.to) / 2);
    const lx = (v) => Math.log10(v);
    const sx = (v) => box.x0 + 12 + ((lx(v) - lx(xs[0])) / (lx(xs[xs.length - 1]) - lx(xs[0]) || 1)) * (box.x1 - box.x0 - 24);
    const sy = (v) => box.y1 - ((v - axis.lo) / (axis.hi - axis.lo)) * (box.y1 - box.y0);
    for (const tick of axis.ticks) {
      svg.append(s('line', { class: 'gridline', x1: box.x0, x2: box.x1, y1: sy(tick), y2: sy(tick) }));
      svg.append(s('text', { x: box.x0 - 6, y: sy(tick) + 3.5, 'text-anchor': 'end' }, pct(tick, 0)));
    }
    curve.forEach((point, i) => svg.append(s('text', { x: sx(xs[i]), y: box.y1 + 15, 'text-anchor': 'middle' }, `~${point.to}`)));
    svg.append(s('text', { class: 'axis-title', x: (box.x0 + box.x1) / 2, y: height - 4, 'text-anchor': 'middle' }, '시작부터 몇 번째 판까지 (구간)'));
    const refs = [naive ? { v: naive.rtp, text: `naive ${pct(naive.rtp, 1)}` } : null, { v: rule, text: `최선의 규칙 ${pct(rule, 1)}` }].filter(Boolean);
    refs.forEach((ref) => {
      if (ref.v < axis.lo || ref.v > axis.hi) return;
      svg.append(s('line', { class: 'reference', x1: box.x0, x2: box.x1, y1: sy(ref.v), y2: sy(ref.v) }));
      svg.append(s('text', { x: box.x0 + 4, y: sy(ref.v) - 5 }, ref.text));
    });
    const upper = curve.map((point, i) => `${sx(xs[i])},${sy(Math.min(axis.hi, point.ci95[1]))}`);
    const lower = curve.map((point, i) => `${sx(xs[i])},${sy(Math.max(axis.lo, point.ci95[0]))}`).reverse();
    svg.append(s('polygon', { points: [...upper, ...lower].join(' '), fill: colorOf('learning'), opacity: 0.16 }));
    svg.append(
      s('path', { d: curve.map((point, i) => `${i === 0 ? 'M' : 'L'}${sx(xs[i])},${sy(point.rtp)}`).join(''), fill: 'none', stroke: colorOf('learning'), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    );
    curve.forEach((point, i) => {
      svg.append(s('circle', { class: 'ring', cx: sx(xs[i]), cy: sy(point.rtp), r: 4, fill: colorOf('learning') }));
      const hit = s('rect', { class: 'hit', x: sx(xs[i]) - 18, y: box.y0, width: 36, height: box.y1 - box.y0 });
      hover(hit, null, null, `${tierName(tier)} · ${point.from + 1}–${point.to}번째 판`, [
        { name: '환수율', value: pct(point.rtp, 2) },
        { name: '95% 구간', value: `${pct(point.ci95[0], 1)}–${pct(point.ci95[1], 1)}` },
        { name: '판 수', value: int(point.games) },
      ]);
      svg.append(hit);
    });
    const last = curve[curve.length - 1];
    svg.append(s('text', { class: 'label', x: sx(xs[xs.length - 1]), y: sy(last.rtp) + 18, 'text-anchor': 'end' }, pct(last.rtp, 1)));
    return h('div', { class: 'panel' }, h('h4', null, `${tierName(tier)} · 출구 ${times(tier.multiplier)}`), svg);
  }

  function learningSection() {
    const entry = currentTable();
    const body = [];
    for (const tier of entry.tiers) {
      body.push({ group: tierName(tier) });
      for (const point of tier.learningCurve) body.push([`${point.from + 1}–${point.to}번째 판`, pct(point.rtp, 2), `${pct(point.ci95[0], 2)}–${pct(point.ci95[1], 2)}`, int(point.games)]);
    }
    return section(
      `배우는 플레이어: 판을 거듭하면 얼마나 나아지나 · ${entry.label}`,
      `처음 시작한 사람 ${int(DATA.options.careers)}명이 크기마다 각자 ${int(DATA.options.careerGames)}판을 할 때, 몇 번째 판인지에 따른 평균 환수율입니다(띠는 95% 구간). 가로선은 출구 방향으로만 가는 naive-greedy(인증)와 배울 수 있는 최선의 규칙(평가)입니다. 학습 방식과 속도는 가정입니다.`,
      h('div', { class: 'card' }, h('div', { class: 'panels three' }, entry.tiers.map(curveChart)), tableView(table(['구간', '환수율', '95% 구간', '판 수'], body))),
    );
  }

  // ---------------------------------------------------------------- bankroll sessions

  const SURVIVAL_POINTS = [10, 20, 50, 100, 200, 500, 1000, 2000];

  function survivalChart(tier) {
    const width = fullWidth();
    const height = 290;
    const svg = chartRoot(width, height, `${tierName(tier)} 판 수별 아직 파산하지 않은 비율`);
    const box = { x0: 50, x1: width - 150, y0: 22, y1: height - 40 };
    const points = SURVIVAL_POINTS.filter((point) => point <= DATA.options.gameCap);
    const lx = (v) => Math.log10(v);
    const sx = (v) => box.x0 + ((lx(v) - lx(points[0])) / (lx(points[points.length - 1]) - lx(points[0]))) * (box.x1 - box.x0);
    const sy = (v) => box.y1 - v * (box.y1 - box.y0);
    for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(s('line', { class: tick === 0 ? 'baseline' : 'gridline', x1: box.x0, x2: box.x1, y1: sy(tick), y2: sy(tick) }));
      svg.append(s('text', { x: box.x0 - 6, y: sy(tick) + 3.5, 'text-anchor': 'end' }, pct(tick, 0)));
    }
    for (const point of points) svg.append(s('text', { x: sx(point), y: box.y1 + 15, 'text-anchor': 'middle' }, int(point)));
    svg.append(s('text', { class: 'axis-title', x: (box.x0 + box.x1) / 2, y: height - 4, 'text-anchor': 'middle' }, '플레이한 판 수 (로그 눈금)'));
    svg.append(s('text', { class: 'axis-title', x: 0, y: 11 }, '아직 한 베팅을 걸 돈이 남은 사람의 비율'));
    const series = SESSION_ROWS.map((row) => ({ row, cell: cellOf(tier, row) })).filter((entry) => entry.cell && entry.cell.sessions);
    const marks = s('g', null);
    const ends = [];
    for (const { row, cell } of series) {
      const values = cell.sessions.survival.slice(0, points.length);
      const group = s('g', { class: 'mark' });
      group.append(s('path', { d: values.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(points[i])},${sy(v)}`).join(''), fill: 'none', stroke: colorOf(row), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      group.append(s('circle', { class: 'ring', cx: sx(points[points.length - 1]), cy: sy(values[values.length - 1]), r: 4, fill: colorOf(row) }));
      marks.append(group);
      ends.push({ row, y: sy(values[values.length - 1]), value: values[values.length - 1] });
    }
    svg.append(marks);
    // End labels with leader lines, spread so that they do not overlap.
    // Lines that end together are left to the legend, the tooltip and the table rather than stacked labels.
    ends.sort((a, b2) => a.y - b2.y);
    let last = -Infinity;
    for (const end of ends) {
      const y = Math.max(end.y, last + 14);
      if (y > box.y1 + 2) continue;
      last = y;
      svg.append(s('line', { class: 'baseline', x1: box.x1 + 6, x2: box.x1 + 14, y1: end.y, y2: y }));
      svg.append(s('text', { class: 'label', x: box.x1 + 18, y: y + 4 }, `${shortName(end.row)} ${pct(end.value, 0)}`));
    }
    points.forEach((point, i) => {
      const hit = s('rect', { class: 'hit', x: sx(point) - 20, y: box.y0, width: 40, height: box.y1 - box.y0 });
      hover(hit, null, null, `${tierName(tier)} · ${int(point)}판 뒤`, series.map(({ row, cell }) => ({ color: colorOf(row), name: nameOf(row), value: pct(cell.sessions.survival[i], 1) })));
      svg.append(hit);
    });
    return svg;
  }

  function sessionSection() {
    const tier = currentTier();
    const entry = currentTable();
    const headers = ['모형', '파산까지 판 수 (중앙값)', '파산 비율', '한 번이라도 앞섰던 비율', '최고 잔고 (중앙값 / 상위 10%)', '세션 길이 (중앙값, 10~90%)', '세션당 하우스 몫'];
    const body = [];
    for (const t of entry.tiers) {
      body.push({ group: `${tierName(t)} · 한 크기만, 한 베팅씩, 돈이 떨어지거나 ${int(DATA.options.gameCap)}판까지` });
      for (const row of SESSION_ROWS) {
        const cell = cellOf(t, row);
        if (!cell || !cell.sessions) continue;
        const ss = cell.sessions;
        body.push([
          rowCell(row),
          ss.gamesUntilBroke.median === null ? `절반 넘게 ${int(ss.gameCap)}판까지 버팀` : `${int(ss.gamesUntilBroke.median)}판`,
          pct(ss.gamesUntilBroke.brokeShare, 0),
          pct(ss.everAheadShare, 0),
          `${bets(ss.peak.median)} / ${bets(ss.peak.p90)}`,
          `${int(ss.games.median)}판 (${int(ss.games.p10)}~${int(ss.games.p90)})`,
          `${bets(ss.houseTake.mean)} (${fixed(ss.houseTake.ci95[0], 1)}~${fixed(ss.houseTake.ci95[1], 1)})`,
        ]);
      }
    }
    return section(
      `뱅크롤 세션 · ${entry.label}`,
      `시작 잔고 ${int(DATA.options.bankroll)}베팅으로 한 크기만, 한 판에 한 베팅씩, 잔고가 한 베팅 아래로 내려가거나 ${int(DATA.options.gameCap)}판이 될 때까지 실제로 미로를 풀며 플레이한 결과입니다. 사람마다의 성향(예: 손절 기준)은 세션 시작 때 한 번 정해지고, 배우는 플레이어는 세션 동안 계속 배웁니다.`,
      figure(
        `${tierName(tier)} · 판 수별 아직 파산하지 않은 비율`,
        '위쪽에 오래 머물수록 하우스가 같은 돈을 거두는 데 판이 더 걸립니다. 선 끝의 숫자는 마지막 지점의 값입니다. 위의 "자세히 볼 크기"로 크기를 바꿉니다.',
        true,
        survivalChart(tier),
        legend(SESSION_ROWS.map((row) => ({ key: 'line', color: colorOf(row), text: nameOf(row) }))),
      ),
      h('div', { class: 'card', style: 'margin-top:14px' }, table(headers, body)),
    );
  }

  // ---------------------------------------------------------------- session behaviour

  function behaviourChart(entry, variant) {
    const width = 380;
    const rowHeight = 26;
    const height = 20 + SESSION_ROWS.length * rowHeight + 40;
    const svg = chartRoot(width, height, `${variantName(variant)}: 세션당 하우스 몫`);
    const box = { x0: 112, x1: width - 52, y0: 14, y1: height - 40 };
    const items = entry.behaviour.filter((row) => row.variant === variant);
    const top = Math.max(DATA.options.bankroll, ...entry.behaviour.map((row) => row.summary.houseTake.ci95[1]));
    const axis = niceAxis(0, top, 4);
    const sx = (v) => box.x0 + (Math.max(0, Math.min(axis.hi, v)) / axis.hi) * (box.x1 - box.x0);
    for (const tick of axis.ticks) {
      svg.append(s('line', { class: tick === 0 ? 'baseline' : 'gridline', x1: sx(tick), x2: sx(tick), y1: box.y0, y2: box.y1 }));
      svg.append(s('text', { x: sx(tick), y: box.y1 + 15, 'text-anchor': 'middle' }, int(tick)));
    }
    svg.append(s('text', { class: 'axis-title', x: (box.x0 + box.x1) / 2, y: height - 4, 'text-anchor': 'middle' }, '세션당 하우스 몫 (베팅)'));
    const marks = s('g', null);
    const hits = s('g', null);
    items.forEach((item, r) => {
      const y = box.y0 + r * rowHeight + 4;
      const barH = 14;
      const summary = item.summary;
      const value = summary.houseTake.mean;
      svg.append(s('text', { class: 'row-label', x: box.x0 - 8, y: y + 11, 'text-anchor': 'end' }, shortName(item.row)));
      const group = s('g', { class: 'mark' });
      const w = Math.max(0, sx(value) - box.x0);
      const rr = Math.min(4, barH / 2, w);
      if (w > 0) {
        group.append(
          s('path', { d: `M${box.x0},${y}H${box.x0 + w - rr}Q${box.x0 + w},${y} ${box.x0 + w},${y + rr}V${y + barH - rr}Q${box.x0 + w},${y + barH} ${box.x0 + w - rr},${y + barH}H${box.x0}Z`, fill: colorOf(item.row) }),
        );
      }
      const [lo, hi] = summary.houseTake.ci95;
      group.append(s('path', { d: `M${sx(lo)},${y + barH / 2}H${sx(hi)}M${sx(lo)},${y + 3}v8M${sx(hi)},${y + 3}v8`, stroke: 'var(--text-primary)', 'stroke-width': 1.25, fill: 'none' }));
      marks.append(group);
      svg.append(s('text', { class: 'label', x: Math.max(sx(value), sx(hi)) + 6, y: y + 11 }, fixed(value, 1)));
      const hit = s('rect', { class: 'hit', x: 0, y: y - 6, width, height: rowHeight });
      hover(hit, group, marks, `${variantName(variant)} · ${nameOf(item.row)}`, [
        { name: '세션당 하우스 몫', value: `${bets(value)} (${fixed(lo, 1)}~${fixed(hi, 1)})` },
        { name: '건 돈 대비', value: pct(summary.takePerStake.value, 1) },
        { name: '세션당 판 수', value: `평균 ${int(summary.games.mean)}` },
        { name: '딴 채로 끝냄', value: pct(summary.aheadAtEndShare, 0) },
      ]);
      hits.append(hit);
    });
    svg.append(marks, hits);
    return h('div', { class: 'panel' }, h('h4', null, variantName(variant)), svg);
  }

  function behaviourSection() {
    const entry = currentTable();
    const headers = ['모형', '세션 행동', '세션당 판 수 (평균)', '세션당 건 돈', '세션당 하우스 몫', '건 돈 대비 하우스 몫', '딴 채로 끝낸 비율', '끝난 이유 (파산 / 목표 / 연패 / 상한)', '크기별 판 비율'];
    const body = [];
    for (const row of SESSION_ROWS) {
      body.push({ group: nameOf(row) });
      for (const item of entry.behaviour.filter((candidate) => candidate.row === row)) {
        const ss = item.summary;
        body.push([
          rowCell(row),
          variantName(item.variant),
          int(ss.games.mean),
          bets(ss.staked.mean),
          `${bets(ss.houseTake.mean)} (${fixed(ss.houseTake.ci95[0], 1)}~${fixed(ss.houseTake.ci95[1], 1)})`,
          `${pct(ss.takePerStake.value, 1)} (${pct(ss.takePerStake.ci95[0], 1)}~${pct(ss.takePerStake.ci95[1], 1)})`,
          pct(ss.aheadAtEndShare, 0),
          `${pct(ss.ended.broke, 0)} / ${pct(ss.ended.goal, 0)} / ${pct(ss.ended.run, 0)} / ${pct(ss.ended.cap, 0)}`,
          ss.tierShare.map((share, t) => `${tierName(entry.tiers[t])} ${pct(share, 0)}`).join(', '),
        ]);
      }
    }
    return section(
      `세션 행동이 하우스 몫에 미치는 영향 · ${entry.label}`,
      '한 판의 규칙 위에 세션 단위의 행동을 얹었습니다: 판마다 크기 고르기(큰 배율에 끌리는 정도는 사람마다 다름), 따면 일어서기와 연패 뒤 그만두기, 잃을 때 베팅 키우기(손실 추격). 모두 가정입니다. 세션당 하우스 몫은 "한 판의 엣지 × 세션에 건 돈"이라, 그만두기는 세션당 몫을 줄이고 손실 추격은 빨리 걸게 만듭니다.',
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'facts' }, assumptionBadge(), ' ', DATA.variants.map((variant) => [b(variant.name), `: ${variant.description} `])),
        h('div', { class: 'panels three' }, DATA.variants.map((variant) => behaviourChart(entry, variant.id))),
        legend(SESSION_ROWS.map((row) => ({ key: 'box', color: colorOf(row), text: nameOf(row) }))),
        tableView(table(headers, body)),
      ),
    );
  }

  // ---------------------------------------------------------------- population scenario

  function populationSection() {
    const entry = currentTable();
    const population = entry.population;
    const width = fullWidth();
    const height = 260;
    const svg = chartRoot(width, height, '최선의 규칙을 쓰는 플레이 비율에 따른 하우스 몫');
    const box = { x0: 56, x1: width - 20, y0: 22, y1: height - 40 };
    const points = population.learnedShare;
    const top = Math.max(...points.map((point) => point.houseTake), 0.05);
    const axis = niceAxis(0, top * 1.1, 5);
    const sx = (v) => box.x0 + v * (box.x1 - box.x0);
    const sy = (v) => box.y1 - (v / axis.hi) * (box.y1 - box.y0);
    for (const tick of axis.ticks) {
      svg.append(s('line', { class: tick === 0 ? 'baseline' : 'gridline', x1: box.x0, x2: box.x1, y1: sy(tick), y2: sy(tick) }));
      svg.append(s('text', { x: box.x0 - 6, y: sy(tick) + 3.5, 'text-anchor': 'end' }, pct(tick, 0)));
    }
    for (const point of points) if (Math.round(point.share * 10) % 2 === 0) svg.append(s('text', { x: sx(point.share), y: box.y1 + 15, 'text-anchor': 'middle' }, pct(point.share, 0)));
    svg.append(s('text', { class: 'axis-title', x: (box.x0 + box.x1) / 2, y: height - 4, 'text-anchor': 'middle' }, '플레이 가운데 최선의 규칙을 쓰는 사람의 비율'));
    svg.append(s('text', { class: 'axis-title', x: 0, y: 11 }, '하우스 몫 (건 돈 대비)'));
    const refs = [
      population.houseTake.valueLsm === null ? null : { v: population.houseTake.valueLsm, text: `모두 value-lsm ${pct(population.houseTake.valueLsm, 1)}`, below: true },
      { v: population.houseTake.immediateCashout, text: `모두 즉시 캐시아웃 ${pct(population.houseTake.immediateCashout, 1)}`, below: false },
    ].filter(Boolean);
    for (const ref of refs) {
      svg.append(s('line', { class: 'reference', x1: box.x0, x2: box.x1, y1: sy(ref.v), y2: sy(ref.v) }));
      svg.append(s('text', { x: box.x0 + 8, y: sy(ref.v) + (ref.below ? 14 : -5) }, ref.text));
    }
    svg.append(s('path', { d: points.map((point, i) => `${i === 0 ? 'M' : 'L'}${sx(point.share)},${sy(point.houseTake)}`).join(''), fill: 'none', stroke: colorOf('best-rule'), 'stroke-width': 2 }));
    for (const point of [points[0], points[points.length - 1]]) {
      svg.append(s('circle', { class: 'ring', cx: sx(point.share), cy: sy(point.houseTake), r: 4, fill: colorOf('best-rule') }));
      svg.append(s('text', { class: 'label', x: sx(point.share) + (point.share === 0 ? 8 : -8), y: sy(point.houseTake) - 9, 'text-anchor': point.share === 0 ? 'start' : 'end' }, pct(point.houseTake, 1)));
    }
    points.forEach((point) => {
      const hit = s('rect', { class: 'hit', x: sx(point.share) - 20, y: box.y0, width: 40, height: box.y1 - box.y0 });
      hover(hit, null, null, `최선의 규칙을 쓰는 비율 ${pct(point.share, 0)}`, [{ name: '하우스 몫', value: pct(point.houseTake, 2) }]);
      svg.append(hit);
    });
    return section(
      `규칙이 퍼지면 · ${entry.label}`,
      '가정한 사람 구성(초보·보통·생각하는·배우는 플레이어)에서 출발해, 플레이의 일부가 "배울 수 있는 최선의 규칙"을 쓰는 사람으로 바뀔 때 하우스 몫이 어떻게 줄어드는지입니다. 크기별 이용 비율은 튜닝 보고서의 가정(assumptions.ts)을 씁니다.',
      figure('최선의 규칙을 쓰는 비율과 하우스 몫', null, true, h('p', { class: 'facts' }, assumptionBadge(), ' 구성과 크기 비율이 모두 가정입니다. 두 끝점 사이는 비율에 따라 곧게 이어집니다.'), svg),
    );
  }

  // ---------------------------------------------------------------- calibration, checks, run

  function calibrationSection() {
    const fits = DATA.calibration.map((entry) => [
      `${entry.n}×${entry.n}`,
      `길이 ${fixed(entry.fit.weights.route, 2)} · 공간 ${fixed(entry.fit.weights.space, 2)} · 방향 ${fixed(entry.fit.weights.toward, 2)} · 대각선 ${fixed(entry.fit.weights.diagonal, 2)}`,
      pct(entry.fit.agreement, 1),
      pct(entry.fit.naiveAgreement, 1),
      `${fixed(entry.fit.crossEntropy, 3)} / ${fixed(entry.fit.uniformCrossEntropy, 3)}`,
      int(entry.fit.positions),
      entry.reach.reach
        .slice(2, 2 * entry.n + 1)
        .filter((_, i) => i % 2 === 0)
        .map((v) => pct(v, 0))
        .join(' '),
    ]);
    const breakRows = [];
    for (const entry of DATA.tables) {
      for (const tier of entry.tiers) {
        for (const point of tier.breakEven) breakRows.push([`${entry.label} ${tierName(tier)}`, `${point.k}걸음 뒤 (환급 ${pct(point.refund, 1)})`, pct(point.neutral, 1), pct(point.prospect, 1)]);
      }
    }
    const checks = [];
    for (const entry of DATA.tables) {
      for (const tier of entry.tiers) {
        const check = tier.naiveCheck;
        checks.push([
          `${entry.label} ${tierName(tier)}`,
          check ? pct(check.rtp, 2) : '–',
          check ? `${pct(check.certifiedRtp, 2)} (${int(check.certifiedGames)}판)` : '인증 기록 없음',
          check ? `${pp(check.difference, 2)} ±${fixed(100 * check.halfWidth, 2)}%p` : '–',
          check ? fixed(check.z, 2) : '–',
          check ? h('span', { class: check.agrees ? 'status-good' : 'status-bad' }, check.agrees ? '✓ 일치' : '⚠ 범위 밖') : '–',
        ]);
      }
    }
    return section(
      '모형의 보정과 검증',
      null,
      h(
        'div',
        { class: 'card' },
        h('h3', null, '생각하는 플레이어의 감: 정확한 사후확률에 맞춘 단서 가중치'),
        h(
          'p',
          { class: 'facts' },
          '출구 쪽으로 가는 플레이에서 나온 학습용 국면마다, 각 갈래 뒤에 출구가 있을 정확한 확률(사후확률)에 네 단서의 소프트맥스를 최대우도로 맞췄습니다. "일치"는 갈래가 둘 이상인 갈림길에서 가장 그럴듯하다고 본 갈래가 사후확률이 가장 큰 갈래와 같은 비율이고, 같은 비율을 "출구 쪽" 규칙과 비교했습니다. 오른쪽 끝은 감의 보정표(남은 길이 2, 4, 6…칸일 때 "맞는 갈래라면 끝까지 갈 확률")입니다.',
        ),
        table(['크기', '가중치', '일치 (단서 모형)', '일치 (출구 쪽)', '교차 엔트로피 (모형 / 균등)', '국면 수', '감의 보정표'], fits),
        h('h3', { style: 'margin-top:14px' }, '계속 갈지 가르는 "이길 것 같은 느낌"의 문턱'),
        h(
          'p',
          { class: 'facts' },
          '생각하는 플레이어는 "이길 것 같은 확률"이 이 문턱을 넘어야 계속 갑니다(안 풀리면 절반쯤은 두 걸음 뒤에 빠져나올 수 있다고 봄). 왜곡이 없으면 기댓값의 손익분기점이고, 전망이론의 왜곡이 들어가면 오른쪽 열이 됩니다. 오른쪽이 더 높으면 손실 회피 때문에 더 일찍 그만두고, 더 낮으면 큰 배율의 작은 확률을 크게 느껴 더 버팁니다.',
        ),
        table(['표 · 크기', '시점', '문턱 (왜곡 없음)', '문턱 (전망이론)'], breakRows),
        h('h3', { style: 'margin-top:14px' }, '검증: naive-greedy와 같은 매개변수의 보통 플레이어'),
        h(
          'p',
          { class: 'facts' },
          '보통 플레이어의 실수·주머니 인식·그만두기를 모두 끄면 인증 묶음의 naive-greedy와 똑같은 수를 둡니다(테스트가 수 하나하나를 비교합니다). 이 실행의 미로에서 낸 환수율이 인증 결과와 통계적으로 같으면 엔진을 인증과 같은 방식으로 쓰고 있다는 뜻입니다. 우연만으로도 20개 중 1개쯤은 범위를 벗어날 수 있습니다.',
        ),
        table(['표 · 크기', '이 실행', '인증', '차이', 'z', '판정'], checks),
      ),
    );
  }

  function runSection() {
    return section(
      '실행 정보',
      `시뮬레이터 코드 해시 ${DATA.simCodeHash.slice(0, 12)}… · 워커 스레드 ${RUN.workers === 0 ? '없음 (한 스레드)' : `${RUN.workers}개`}`,
      h('div', { class: 'card' }, table(['단계', '작업 수', '걸린 시간 (초)'], RUN.timings.map((timing) => [timing.phase, int(timing.jobs), fixed(timing.seconds, 1)]))),
    );
  }

  // ---------------------------------------------------------------- page

  const controls = h('div', { class: 'controls' });
  const content = h('div', null);

  function segment(label, entries, current, choose) {
    return h(
      'div',
      { class: 'control' },
      h('span', null, label),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': label },
        entries.map((entry) => {
          const button = h('button', { type: 'button', 'aria-pressed': String(entry.value === current), 'data-key': `${label}:${entry.value}` }, entry.text);
          button.addEventListener('click', () => choose(entry.value));
          return button;
        }),
      ),
    );
  }

  function render() {
    const entry = currentTable();
    state.tier = Math.min(state.tier, entry.tiers.length - 1);
    const choose = (key) => (value) => {
      state[key] = value;
      render();
    };
    // The buttons are rebuilt on every change, so the focused one is found again by its key.
    const focused = controls.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    controls.replaceChildren();
    fill(controls, null, [
      DATA.tables.length > 1 ? segment('튜닝 표', DATA.tables.map((candidate, i) => ({ value: i, text: candidate.label })), state.table, choose('table')) : null,
      segment('자세히 볼 크기', entry.tiers.map((tier, i) => ({ value: i, text: `${tierName(tier)} · ${times(tier.multiplier)}` })), state.tier, choose('tier')),
    ]);
    if (focused) for (const button of controls.querySelectorAll('button')) if (button.dataset.key === focused) button.focus();
    content.replaceChildren();
    fill(content, null, [verdictSection(), rtpSection(), ruleSection(), learningSection(), sessionSection(), behaviourSection(), populationSection()]);
  }

  function setTheme(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    for (const button of document.querySelectorAll('.theme button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }

  /** `#dark&table=1&tier=2` opens the page on that selection; every part is optional. */
  function readHash() {
    let theme = 'auto';
    for (const part of window.location.hash.slice(1).split('&')) {
      const [key, value] = part.split('=');
      if (key === 'dark' || key === 'light') theme = key;
      else if (key === 'table' && Number(value) >= 0 && Number(value) < DATA.tables.length) state.table = Number(value);
      else if (key === 'tier' && Number(value) >= 0) state.tier = Number(value);
    }
    return theme;
  }

  try {
    const theme = readHash();
    fill(app, null, [h('div', { class: 'wrap' }, headerSection(), noteSection(), controls, content, calibrationSection(), runSection()), tip]);
    setTheme(theme);
    render();
  } catch (error) {
    app.append(h('div', { class: 'wrap' }, h('div', { class: 'error' }, `보고서를 그리는 중 오류가 났습니다: ${error && error.stack ? error.stack : error}`)));
  }
})();
