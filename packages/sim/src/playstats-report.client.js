// Client script of the `sim:stats` report. playstats-report.ts inlines it into report.html.
// It reads the two JSON blocks of the page and draws every chart as inline SVG. It loads nothing.
(() => {
  'use strict';

  const STATS = JSON.parse(document.getElementById('stats-data').textContent);
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
  const pctPoints = (x, digits = 1) => `${fixed(100 * x, digits)}%p`;
  const times = (x) => `${fixed(x, 2)}배`;
  const bets = (x) => `${fixed(x, Math.abs(x) < 100 ? 1 : 0)}베팅`;
  const gamesShort = (x) => (x >= 10000 && x % 10000 === 0 ? `${int(x / 10000)}만` : int(x));
  const interval = (ci, digits = 1) => `${fixed(100 * ci[0], digits)}–${fixed(100 * ci[1], digits)}%`;
  /** The interval of a return; a normal interval of a small sample can reach below zero, a return cannot. */
  const rtpInterval = (lo, hi, digits) => interval([Math.max(0, lo), hi], digits);
  /** Percent ticks with as many decimals as the axis needs. */
  const pctTick = (top) => (v) => pct(v, top < 0.02 ? 2 : top < 0.2 ? 1 : 0);

  const players = new Map(STATS.players.map((player) => [player.id, player]));
  const colorOf = (id) => `var(--s-${id})`;
  const nameOf = (id) => players.get(id).name;
  const tierName = (tier) => `${tier.n}×${tier.n}`;
  const TABLE_TAGS = ['A', 'B'];

  function niceStep(span, count) {
    const raw = span / Math.max(1, count);
    const power = 10 ** Math.floor(Math.log10(raw));
    const unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
  }
  /** A domain widened to whole steps, and the ticks inside it. */
  function niceAxis(min, max, count) {
    if (!(max > min)) max = min + 1;
    const step = niceStep(max - min, count);
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let i = 0; lo + i * step <= hi + step * 1e-9; i++) ticks.push(Number((lo + i * step).toPrecision(12)));
    return { lo, hi, ticks };
  }
  /** Shows about `wanted` labels of `count` positions: every 1st, 2nd, 5th, 10th, … */
  function tickEvery(count, wanted) {
    const raw = count / wanted;
    return raw <= 1 ? 1 : niceStep(raw, 1);
  }

  // ---------------------------------------------------------------- tooltip

  const tip = h('div', { class: 'tip', role: 'status' });
  function showTip(event, title, rows) {
    tip.replaceChildren();
    fill(tip, null, [
      h('div', { class: 'title' }, title),
      rows.map((row) =>
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'name' }, row.color ? h('span', { class: 'key-line', style: `border-color:${row.color}` }) : null, row.name),
          h('span', { class: 'val' }, row.value),
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
  /** Pointer position in the coordinates of the chart's viewBox. */
  function pointerX(svg, event) {
    const rect = svg.getBoundingClientRect();
    return ((event.clientX - rect.left) / rect.width) * svg.viewBox.baseVal.width;
  }

  // ---------------------------------------------------------------- chart parts

  /** A chart scales with its card, but is not blown up far beyond the size its text was set for. */
  function chartRoot(width, height, label) {
    return s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, style: `max-width:${Math.round(width * 1.25)}px` });
  }

  function frame({ width, height, top = 28, right = 16, bottom = 40, left = 50, yTitle, xTitle, label }) {
    const svg = chartRoot(width, height, label);
    const box = { x0: left, x1: width - right, y0: top, y1: height - bottom };
    if (yTitle) svg.append(s('text', { class: 'axis-title', x: 0, y: 12 }, yTitle));
    if (xTitle) svg.append(s('text', { class: 'axis-title', x: (box.x0 + box.x1) / 2, y: height - 5, 'text-anchor': 'middle' }, xTitle));
    return { svg, box };
  }
  function drawYAxis(svg, box, sy, ticks, format) {
    for (const tick of ticks) {
      const y = sy(tick);
      svg.append(s('line', { class: 'gridline', x1: box.x0, x2: box.x1, y1: y, y2: y }));
      svg.append(s('text', { x: box.x0 - 7, y: y + 3.5, 'text-anchor': 'end' }, format(tick)));
    }
  }
  function drawBaseline(svg, box, y = box.y1) {
    svg.append(s('line', { class: 'baseline', x1: box.x0, x2: box.x1, y1: y, y2: y }));
  }
  /** A bar that stands on the baseline: square below, rounded at the data end. */
  function columnPath(x, y, width, height) {
    const r = Math.min(4, width / 2, height);
    return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
  }
  function rowPath(x, y, width, height) {
    const r = Math.min(4, height / 2, width);
    return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
  }

  function legend(items) {
    return h(
      'div',
      { class: 'legend' },
      items.map((item) => h('span', null, h('span', { class: `key-${item.key}`, style: item.key === 'line' ? `border-color:${item.color}` : `background:${item.color}` }), item.text)),
    );
  }

  /**
   * Columns over a band axis, from zero.
   * items: [{ tick, value, mark?, title, rows }]; `mark` draws a reference tick across the band.
   */
  function columns({ items, color, yMax, yFormat, yTitle, xTitle, label, width = 600, height = 260, every = 1, maxBand = 64, labels = false }) {
    const { svg, box } = frame({ width, height, yTitle, xTitle, label });
    const top = yMax ?? Math.max(1e-9, ...items.map((item) => Math.max(item.value, item.mark ?? 0)));
    const axis = niceAxis(0, top, 4);
    const sy = (v) => box.y1 - (v / axis.hi) * (box.y1 - box.y0);
    const format = yFormat ?? pctTick(axis.hi);
    drawYAxis(svg, box, sy, axis.ticks, format);
    drawBaseline(svg, box);
    const band = Math.min(maxBand, (box.x1 - box.x0) / items.length);
    const start = box.x0 + (box.x1 - box.x0 - band * items.length) / 2;
    const bar = Math.max(1, Math.min(24, band - 2));
    const marks = s('g', null);
    const hits = s('g', null);
    items.forEach((item, i) => {
      const centre = start + band * (i + 0.5);
      const y = sy(item.value);
      const mark = item.value > 0 ? s('path', { class: 'mark', d: columnPath(centre - bar / 2, y, bar, box.y1 - y), fill: color }) : null;
      if (mark) marks.append(mark);
      if (item.mark !== undefined) {
        const half = Math.max(bar / 2 + 3, 5);
        marks.append(s('line', { class: 'reference', x1: centre - half, x2: centre + half, y1: sy(item.mark), y2: sy(item.mark) }));
      }
      if (labels) svg.append(s('text', { class: 'label', x: centre, y: y - 6, 'text-anchor': 'middle' }, format(item.value)));
      // The last position is always labelled; a regular label too close to it gives way.
      const last = items.length - 1;
      if (i === last || (i % every === 0 && last - i >= every)) svg.append(s('text', { x: centre, y: box.y1 + 15, 'text-anchor': 'middle' }, item.tick));
      const hit = s('rect', { class: 'hit', x: start + band * i, y: box.y0, width: band, height: box.y1 - box.y0 });
      hit.addEventListener('pointermove', (event) => {
        marks.classList.add('dim');
        if (mark) mark.classList.add('on');
        showTip(event, item.title, item.rows);
      });
      hit.addEventListener('pointerleave', () => {
        marks.classList.remove('dim');
        if (mark) mark.classList.remove('on');
        hideTip();
      });
      hits.append(hit);
    });
    svg.append(marks, hits);
    return svg;
  }

  /**
   * Lines over a continuous axis, with a crosshair that snaps to `snap` and shows `readout(i)`.
   * series: [{ color, points: [[x, y]], width?, opacity?, area? }]; band: { color, points: [[x, lo, hi]] };
   * refs: [{ y, text } | { x, text }]; `decorate(svg, sx, sy, box)` adds markers on top.
   */
  function lines({ series, band, refs = [], xLog = false, xDomain, yDomain, xTicks, xFormat = int, yFormat, xTitle, yTitle, label, snap, readout, decorate, width = 600, height = 280, right = 16 }) {
    const { svg, box } = frame({ width, height, yTitle, xTitle, label, right });
    const tx = xLog ? Math.log10 : (v) => v;
    const x0 = tx(xDomain[0]);
    const x1 = tx(xDomain[1]);
    const sx = (v) => box.x0 + ((tx(v) - x0) / (x1 - x0 || 1)) * (box.x1 - box.x0);
    const axis = niceAxis(yDomain[0], yDomain[1], 5);
    const sy = (v) => box.y1 - ((v - axis.lo) / (axis.hi - axis.lo)) * (box.y1 - box.y0);
    drawYAxis(svg, box, sy, axis.ticks, yFormat);
    drawBaseline(svg, box, axis.lo <= 0 && axis.hi >= 0 ? sy(0) : box.y1);
    for (const tick of xTicks ?? niceAxis(xDomain[0], xDomain[1], 5).ticks.filter((t) => t >= xDomain[0] && t <= xDomain[1])) {
      svg.append(s('text', { x: sx(tick), y: box.y1 + 15, 'text-anchor': 'middle' }, xFormat(tick)));
    }
    if (band) {
      const upper = band.points.map(([x, , hi]) => `${sx(x)},${sy(Math.min(axis.hi, hi))}`);
      const lower = band.points.map(([x, lo]) => `${sx(x)},${sy(Math.max(axis.lo, lo))}`).reverse();
      svg.append(s('polygon', { points: [...upper, ...lower].join(' '), fill: band.color, opacity: 0.16 }));
    }
    for (const ref of refs) {
      if (ref.y !== undefined) {
        if (ref.y < axis.lo || ref.y > axis.hi) continue;
        svg.append(s('line', { class: 'reference', x1: box.x0, x2: box.x1, y1: sy(ref.y), y2: sy(ref.y) }));
        svg.append(s('text', { x: box.x1, y: sy(ref.y) - 5, 'text-anchor': 'end' }, ref.text));
      } else {
        svg.append(s('line', { class: 'reference', x1: sx(ref.x), x2: sx(ref.x), y1: box.y0, y2: box.y1 }));
        const flip = sx(ref.x) > (box.x0 + box.x1) / 2;
        svg.append(s('text', { class: 'label', x: sx(ref.x) + (flip ? -6 : 6), y: box.y0 + 10, 'text-anchor': flip ? 'end' : 'start' }, ref.text));
      }
    }
    for (const line of series) {
      const d = line.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${sx(x)},${sy(y)}`).join('');
      if (line.area) {
        const first = line.points[0];
        const last = line.points[line.points.length - 1];
        svg.append(s('path', { d: `${d}L${sx(last[0])},${sy(axis.lo)}L${sx(first[0])},${sy(axis.lo)}Z`, fill: line.color, opacity: 0.1 }));
      }
      svg.append(
        s('path', { d, fill: 'none', stroke: line.color, 'stroke-width': line.width ?? 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: line.opacity ?? 1 }),
      );
    }
    if (decorate) decorate(svg, sx, sy, box);
    if (snap && readout) {
      const cross = s('line', { class: 'crosshair', y1: box.y0, y2: box.y1 });
      const hit = s('rect', { class: 'hit', x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 });
      const positions = snap.map(sx);
      hit.addEventListener('pointermove', (event) => {
        const x = pointerX(svg, event);
        let best = 0;
        for (let i = 1; i < positions.length; i++) if (Math.abs(positions[i] - x) < Math.abs(positions[best] - x)) best = i;
        cross.setAttribute('x1', positions[best]);
        cross.setAttribute('x2', positions[best]);
        cross.style.visibility = 'visible';
        const { title, rows } = readout(best);
        showTip(event, title, rows);
      });
      hit.addEventListener('pointerleave', () => {
        cross.style.visibility = 'hidden';
        hideTip();
      });
      svg.append(cross, hit);
    }
    return svg;
  }

  /** Width of a chart that spans the whole card: wide on a wide window, so that its text keeps its size. */
  const fullWidth = () => (window.innerWidth > 900 ? 1160 : 600);

  function dot(svg, x, y, color) {
    svg.append(s('circle', { class: 'ring', cx: x, cy: y, r: 4, fill: color }));
  }

  function table(headers, rows) {
    return h(
      'div',
      { class: 'scroll' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, headers.map((header) => h('th', null, header)))),
        h(
          'tbody',
          null,
          rows.map((row) => (row.group ? h('tr', { class: 'group' }, h('td', { colspan: headers.length }, row.group)) : h('tr', null, row.map((cell) => h('td', null, cell))))),
        ),
      ),
    );
  }
  /** The numbers behind a chart, for readers who cannot or do not want to read them off the marks. */
  const tableView = (...tables) => h('details', null, h('summary', null, '표로 보기'), tables);
  const assumptionBadge = () => h('span', { class: 'badge' }, '가정');
  const playerCell = (id) => h('span', { class: 'name-cell' }, h('span', { class: 'swatch', style: `background:${colorOf(id)}` }), nameOf(id), players.get(id).assumption ? assumptionBadge() : null);

  function figure(title, caption, wide, ...body) {
    return h('figure', { class: wide ? 'card wide' : 'card' }, h('figcaption', null, h('h3', null, title), h('p', null, caption)), body);
  }
  function facts(...parts) {
    return h('p', { class: 'facts' }, parts);
  }
  const b = (text) => h('b', null, text);

  // ---------------------------------------------------------------- figures of one cell

  function endStepFigure(cell, color) {
    const n = cell.games;
    const kinds = [
      ['exit', '출구 도착', cell.rates.exit],
      ['deadEnd', '막다른 길', cell.rates.deadEnd],
      ['cashOut', '캐시아웃', cell.rates.cashOut],
    ];
    const steps = cell.endStep.exit.length;
    const yMax = Math.max(1e-9, ...kinds.flatMap(([key]) => cell.endStep[key])) / n;
    const panels = kinds.map(([key, name, rate]) => {
      const items = cell.endStep[key].map((count, k) => ({
        tick: String(k),
        value: count / n,
        title: `${k}걸음 뒤 ${name}`,
        rows: [
          { name: '전체 판 중', value: pct(count / n, 2) },
          { name: '판 수', value: `${int(count)}판` },
        ],
      }));
      return h(
        'div',
        { class: 'panel' },
        h('h4', null, `${name} · 전체의 ${pct(rate)}`),
        columns({ items, color, yMax, yTitle: '전체 판 중 비율 (%)', xTitle: '게임이 끝난 걸음 수 (걸음)', width: 400, height: 230, every: tickEvery(steps, 10), maxBand: 34, label: `${name}으로 끝난 걸음 수 분포` }),
      );
    });
    const rows = cell.endStep.exit.map((_, k) => [`${k}걸음`, ...kinds.map(([key]) => pct(cell.endStep[key][k] / n, 2))]);
    return figure(
      '게임이 몇 걸음째에 끝났나',
      '게임이 끝난 걸음 수를 결과별로 나눈 분포입니다. 막대 높이는 전체 판 가운데 그 걸음에서 그 결과로 끝난 판의 비율이고, 세 그래프의 막대를 모두 더하면 100%입니다. 세로축 눈금은 세 그래프가 같습니다.',
      true,
      h('div', { class: 'panels three' }, panels),
      tableView(table(['걸음 수', '출구 도착', '막다른 길', '캐시아웃'], rows)),
    );
  }

  function payoutFigure(cell, color) {
    const kindName = (level) => (level.kind === 'dead-end' ? '막다른 길' : level.kind === 'exit' ? '출구 도착' : `캐시아웃 (${level.step}걸음 뒤)`);
    const items = cell.payouts.map((level) => ({
      tick: fixed(level.multiple, 2),
      value: level.share,
      title: `${kindName(level)} · ${times(level.multiple)}`,
      rows: [
        { name: '전체 판 중', value: pct(level.share, 2) },
        { name: '판 수', value: `${int(level.games)}판` },
      ],
    }));
    return figure(
      '한 판에 얼마를 돌려받았나',
      '한 판이 베팅액의 몇 배를 돌려줬는지의 분포입니다. 0배는 막다른 길, 1배보다 작은 값은 캐시아웃 환급(걸음이 늘수록 줄어듦), 가장 오른쪽은 출구 도착 배당입니다.',
      false,
      columns({ items, color, yTitle: '전체 판 중 비율 (%)', xTitle: '돌려받은 금액 (베팅액의 배수)', every: tickEvery(items.length, 12), labels: items.length <= 6, label: '지급 배수 분포' }),
      tableView(table(
        ['결과', '배수', '판 수', '비율'],
        cell.payouts.map((level) => [kindName(level), times(level.multiple), int(level.games), pct(level.share, 2)]),
      )),
    );
  }

  function profitFigure(cell, color) {
    const profit = cell.houseProfit;
    const xs = [0, ...profit.games];
    const ys = [0, ...profit.profit];
    const expected = (game) => cell.houseHold.value * game;
    const drop = profit.maxDrawdown;
    const svg = lines({
      series: [
        { color: 'var(--reference)', width: 1.5, points: [[0, 0], [cell.games, expected(cell.games)]] },
        { color, points: xs.map((x, i) => [x, ys[i]]) },
      ],
      xDomain: [0, cell.games],
      yDomain: [Math.min(0, profit.lowest.profit), Math.max(1, expected(cell.games), ...ys, drop.peakProfit)],
      xFormat: gamesShort,
      yFormat: int,
      xTitle: '진행한 판 수 (판)',
      yTitle: '하우스 누적 수익 (베팅 단위)',
      label: '하우스 누적 수익',
      width: fullWidth(),
      height: 300,
      snap: xs,
      readout: (i) => ({
        title: `${int(xs[i])}판 뒤`,
        rows: [
          { name: '실제 누적 수익', value: bets(ys[i]), color },
          { name: '평균대로라면', value: bets(expected(xs[i])), color: 'var(--reference)' },
        ],
      }),
      decorate: (chart, sx, sy) => {
        if (!(drop.bets > 0)) return;
        dot(chart, sx(drop.peakGame), sy(drop.peakProfit), color);
        dot(chart, sx(drop.troughGame), sy(drop.troughProfit), color);
        const flip = sx(drop.troughGame) > sx(cell.games) * 0.6;
        chart.append(s('text', { class: 'label', x: sx(drop.troughGame) + (flip ? -8 : 8), y: sy(drop.troughProfit) + 16, 'text-anchor': flip ? 'end' : 'start' }, `최대 낙폭 −${bets(drop.bets)}`));
      },
    });
    const stride = Math.max(1, Math.round(xs.length / 20));
    const sampled = xs.map((x, i) => [x, ys[i]]).filter((_, i) => i % stride === 0 || i === xs.length - 1);
    return figure(
      '하우스 누적 수익',
      '판이 진행되는 동안 하우스가 번 돈의 합계입니다(1 = 베팅 한 번의 금액). 선이 0 아래에 있으면 그 시점까지 하우스가 손해이고, 회색 선은 매 판 평균만큼 벌었을 때의 기대선입니다. 두 점은 가장 크게 밀린 구간(최대 낙폭)의 고점과 저점입니다.',
      true,
      legend([
        { key: 'line', color, text: '실제 누적 수익' },
        { key: 'line', color: 'var(--reference)', text: `기대선 (판당 ${pct(cell.houseHold.value)})` },
      ]),
      svg,
      facts(
        '최대 낙폭 ', b(bets(drop.bets)), drop.bets > 0 ? ` (${int(drop.peakGame)}번째 판 고점 → ${int(drop.troughGame)}번째 판 저점)` : '',
        ' · 누적 수익이 0 아래였던 판 ', b(pct(profit.behind.share, 2)),
        profit.behind.games > 0 ? `, 마지막은 ${int(profit.behind.lastGame)}번째 판 (최저 ${bets(profit.lowest.profit)})` : '',
        ' · 직전 고점을 넘지 못한 가장 긴 구간 ', b(`${int(profit.longestBelowPeak)}판`),
      ),
      tableView(table(
        ['판 수', '실제 누적 수익', '기대선'],
        sampled.map(([x, y]) => [int(x), bets(y), bets(expected(x))]),
      )),
    );
  }

  function convergenceFigure(cell, color) {
    const rows = cell.convergence;
    const first = rows[0].games;
    const last = Math.max(rows[rows.length - 1].games, first * 1.01);
    const decades = [];
    for (let d = first; d <= last; d *= 10) decades.push(d);
    const svg = lines({
      series: [{ color, points: rows.map((row) => [row.games, row.rtp]) }],
      band: { color, points: rows.map((row) => [row.games, row.lo, row.hi]) },
      refs: [{ y: 1, text: '손익분기 100%' }],
      xLog: true,
      xDomain: [first, last],
      xTicks: decades,
      yDomain: [Math.max(0, Math.min(...rows.map((row) => row.lo))), Math.max(...rows.map((row) => row.hi))],
      xFormat: gamesShort,
      yFormat: (v) => pct(v, 0),
      xTitle: '처음부터 센 판 수 (판, 로그 눈금)',
      yTitle: '그때까지의 환수율 (%)',
      label: '환수율 수렴',
      right: 52,
      snap: rows.map((row) => row.games),
      readout: (i) => ({
        title: `처음 ${int(rows[i].games)}판`,
        rows: [
          { name: '환수율', value: pct(rows[i].rtp, 2), color },
          { name: '95% 구간', value: rtpInterval(rows[i].lo, rows[i].hi, 1) },
        ],
      }),
      decorate: (chart, sx, sy) => {
        const end = rows[rows.length - 1];
        dot(chart, sx(end.games), sy(end.rtp), color);
        chart.append(s('text', { class: 'label', x: sx(end.games) + 8, y: sy(end.rtp) + 4 }, pct(end.rtp, 1)));
      },
    });
    return figure(
      '몇 판을 돌려야 믿을 수 있나',
      '처음 n판까지만 봤을 때의 환수율(선)과 그 95% 신뢰구간(띠)입니다. 띠가 좁을수록 믿을 만하고, 판 수가 10배 늘어야 띠가 약 3분의 1로 줄어듭니다. 아래 표는 이 조합을 n판만 돌렸을 때 환수율이 얼마나 흔들리는지입니다.',
      false,
      legend([
        { key: 'line', color, text: '그때까지의 환수율' },
        { key: 'band', color, text: '95% 신뢰구간' },
        { key: 'line', color: 'var(--reference)', text: '손익분기 100%' },
      ]),
      svg,
      table(
        ['돌린 판 수', ...cell.noise.map((row) => `${gamesShort(row.games)}판`), `이번 실행 (${gamesShort(cell.games)}판)`],
        [['환수율 95% 오차', ...cell.noise.map((row) => `±${pctPoints(row.halfWidth, 1)}`), `±${pctPoints(cell.rtp.halfWidth, 2)}`]],
      ),
      facts('오차를 ±1%p까지 줄이려면 약 ', b(`${int(cell.gamesForOnePoint)}판`), '이 필요합니다 (한 판 수익률의 표준편차 ', b(times(cell.rtp.sd)), ' 기준).'),
      tableView(table(
        ['처음 n판', '환수율', '95% 구간'],
        rows.map((row) => [int(row.games), pct(row.rtp, 2), rtpInterval(row.lo, row.hi, 1)]),
      )),
    );
  }

  function streakFigure(cell, color) {
    const streaks = cell.streaks;
    const inARow = streaks.inARow.map((row) => ({
      tick: String(row.k),
      value: row.observed,
      mark: row.independent,
      title: `${row.k}판 연속으로 출구에 못 감`,
      rows: [
        { name: '관측', value: pct(row.observed, 2) },
        { name: '매 판 독립이라면', value: pct(row.independent, 2) },
      ],
    }));
    const windows = Math.max(1, streaks.windows);
    const longest = streaks.longestInWindow.map((count, r) => ({
      tick: String(r),
      value: count / windows,
      title: `구간 안 최장 연패 ${r}판`,
      rows: [
        { name: '구간 비율', value: pct(count / windows, 1) },
        { name: '구간 수', value: `${int(count)}개` },
      ],
    }));
    return figure(
      '연패는 얼마나 길어지나',
      `왼쪽은 아무 때나 시작해 다음 k판을 내리 못 이길(출구에 못 갈) 확률로, 막대가 관측값이고 가로 표시는 매 판이 독립일 때의 이론값입니다. 오른쪽은 판을 ${streaks.window}판씩 끊었을 때 구간마다 가장 길었던 연패 길이의 분포입니다.`,
      true,
      legend([
        { key: 'box', color, text: '관측' },
        { key: 'line', color: 'var(--reference)', text: '매 판 독립일 때의 이론값 (1 − 승률)^k' },
      ]),
      h(
        'div',
        { class: 'panels two' },
        h('div', { class: 'panel' }, h('h4', null, 'k판 연속으로 못 이길 확률'), columns({ items: inARow, color, yTitle: '확률 (%)', xTitle: '연속 판 수 k (판)', maxBand: 40, label: 'k판 연속 무승 확률' })),
        h(
          'div',
          { class: 'panel' },
          h('h4', null, `${streaks.window}판 구간 안에서 가장 길었던 연패 · 구간 ${int(streaks.windows)}개`),
          columns({ items: longest, color, yTitle: '구간 비율 (%)', xTitle: '구간 안 최장 연패 (판)', every: tickEvery(longest.length, 10), maxBand: 30, label: `${streaks.window}판 구간의 최장 연패 분포` }),
        ),
      ),
      facts(`전체 ${int(cell.games)}판에서 가장 길었던 연패는 `, b(`${int(streaks.longest)}판`), '입니다.'),
      tableView(
        table(
          ['연속 판 수 k', '관측 확률', '독립 가정'],
          streaks.inARow.map((row) => [`${row.k}판`, pct(row.observed, 2), pct(row.independent, 2)]),
        ),
        table(
          [`${streaks.window}판 구간 안 최장 연패`, '구간 수', '구간 비율'],
          streaks.longestInWindow.map((count, r) => [`${r}판`, int(count), pct(count / windows, 1)]).filter((_, r) => streaks.longestInWindow[r] > 0),
        ),
      ),
    );
  }

  function sessionFigure(cell, color) {
    const title = '가진 돈은 얼마나 버티나';
    const sessions = cell.sessions;
    if (!sessions) {
      return figure(title, '뱅크롤 세션은 한 사람이 같은 방식으로 계속 플레이한다고 볼 때의 계산이라, 여러 유형을 섞은 집단에는 만들지 않습니다. 개별 플레이어 유형을 선택해 보세요.', true);
    }
    const { stride, gameCap, bankroll } = sessions;
    const paths = sessions.paths.map((path) => {
      const points = path.values.map((value, i) => [i * stride, value]);
      if (path.games % stride !== 0) points.push([path.games, path.final]);
      return { points, ruined: path.final < 1, games: path.games, final: path.final };
    });
    const top = Math.max(bankroll, ...paths.flatMap((path) => path.points.map((point) => point[1])));
    const snap = sessions.survival.games;
    const pathsChart = lines({
      series: paths.map((path) => ({ color, width: 1.25, opacity: 0.6, points: path.points })),
      refs: [{ y: bankroll, text: `시작 ${int(bankroll)}베팅` }],
      xDomain: [0, gameCap],
      yDomain: [0, top],
      yFormat: int,
      xTitle: '플레이한 판 수 (판)',
      yTitle: '남은 돈 (베팅 단위)',
      label: '개별 플레이어의 뱅크롤 경로',
      snap,
      readout: (i) => {
        const alive = paths
          .filter((path) => path.games >= snap[i])
          .map((path) => (snap[i] === path.games ? path.final : path.points[Math.min(path.points.length - 1, Math.floor(snap[i] / stride))][1]))
          .sort((x, y) => x - y);
        return {
          title: `${int(snap[i])}판 뒤 · 표본 ${paths.length}명`,
          rows:
            alive.length === 0
              ? [{ name: '아직 플레이 중', value: '0명' }]
              : [
                  { name: '아직 플레이 중', value: `${alive.length}명` },
                  { name: '남은 돈 범위', value: `${fixed(alive[0], 0)}–${fixed(alive[alive.length - 1], 0)}베팅` },
                ],
        };
      },
      decorate: (chart, sx, sy) => {
        for (const path of paths) if (path.ruined) chart.append(s('circle', { class: 'ring', cx: sx(path.games), cy: sy(path.final), r: 3, fill: color }));
      },
    });
    const played = sessions.gamesPlayed;
    const medianText = sessions.medianCapped ? `${int(gameCap)}판 이상` : `${int(played.median)}판`;
    const survival = snap.map((x, i) => [x, sessions.survival.share[i]]);
    const survivalChart = lines({
      series: [{ color, area: true, points: survival }],
      refs: sessions.medianCapped ? [] : [{ x: played.median, text: `중앙값 ${medianText}` }],
      xDomain: [0, gameCap],
      yDomain: [0, 1],
      yFormat: (v) => pct(v, 0),
      xTitle: '플레이한 판 수 (판)',
      yTitle: '아직 돈이 남은 플레이어 (%)',
      label: '생존 곡선',
      snap,
      readout: (i) => ({ title: `${int(snap[i])}판 뒤`, rows: [{ name: '아직 돈이 남은 플레이어', value: pct(sessions.survival.share[i], 1), color }] }),
    });
    const every = Math.max(1, Math.round(snap.length / 20));
    return figure(
      title,
      `${int(bankroll)}베팅어치 돈으로 시작해 매 판 1베팅씩 거는 플레이어 ${int(sessions.sessions)}명을 가상으로 돌린 결과입니다(한 사람당 최대 ${int(gameCap)}판). 왼쪽은 그중 ${paths.length}명의 남은 돈이 변하는 모습이고 점은 더 걸 돈이 없어진 시점입니다. 오른쪽은 k판 뒤에도 돈이 남아 있는 플레이어의 비율로, 50%를 지나는 곳이 중앙값입니다.`,
      true,
      h(
        'div',
        { class: 'panels two' },
        h('div', { class: 'panel' }, h('h4', null, `플레이어 ${paths.length}명의 남은 돈`), pathsChart),
        h('div', { class: 'panel' }, h('h4', null, '아직 돈이 남은 플레이어의 비율 (생존 곡선)'), survivalChart),
      ),
      facts(
        '돈이 떨어질 때까지 플레이한 판 수의 중앙값 ', b(medianText),
        ` (빠른 10%는 ${int(played.p10)}판 이내, 느린 10%는 ${int(played.p90)}판 이상)`,
        ' · 한 번이라도 시작 금액보다 많았던 플레이어 ', b(pct(sessions.everAheadShare)),
        ` · ${int(gameCap)}판 안에 돈이 떨어진 플레이어 `, b(pct(sessions.ruinedShare)),
        ' · 끝났을 때 시작 금액보다 많은 플레이어 ', b(pct(sessions.aheadAtEndShare)),
      ),
      tableView(
        table(
          ['플레이한 판 수', '아직 돈이 남은 플레이어'],
          survival.filter((_, i) => i % every === 0 || i === survival.length - 1).map(([x, share]) => [int(x), pct(share, 1)]),
        ),
        table(
          ['표본 플레이어', '플레이한 판 수', '마지막에 남은 돈'],
          paths.map((path, i) => [`${i + 1}번`, int(path.games), bets(path.final)]),
        ),
      ),
    );
  }

  function tiles(cell) {
    const tile = (label, value, sub) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
    return h(
      'div',
      { class: 'tiles' },
      tile('환수율 (RTP)', pct(cell.rtp.mean, 2), `95% 구간 ${rtpInterval(cell.rtp.ci95[0], cell.rtp.ci95[1], 2)}`),
      tile('하우스 몫', pct(cell.houseHold.value, 2), '베팅액 중 하우스에 남는 평균'),
      tile('출구 도착 (승리)', pct(cell.winRate.value, 2), `95% 구간 ${interval(cell.winRate.ci95, 2)}`),
      tile('막다른 길 (전액 손실)', pct(cell.rates.deadEnd, 2), `${int(cell.outcomes.deadEnd)}판`),
      tile('캐시아웃 (일부 환급)', pct(cell.rates.cashOut, 2), `${int(cell.outcomes.cashOut)}판`),
      tile('한 판 수익률의 표준편차', times(cell.rtp.sd), '클수록 결과가 크게 흔들림'),
      tile('평균 걸음 수', fixed(cell.meanSteps, 1), '게임 한 판에 걸은 칸 수'),
    );
  }

  // ---------------------------------------------------------------- page sections

  const state = { table: 0, tier: 0, player: null };

  function headerSection() {
    const options = STATS.options;
    const tableLine = (entry, i) =>
      h(
        'div',
        null,
        STATS.tables.length > 1 ? `${TABLE_TAGS[i]}: ` : null,
        h('code', null, entry.path),
        ` (해시 ${entry.tableHash.slice(0, 10)}…, ${entry.certified ? '인증 통과 표' : '이 코드로 인증된 기록 없음'}) — `,
        entry.tiers.map((tier) => `${tierName(tier)} 출구 ${fixed(tier.multiplier, 4)}배`).join(', '),
      );
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
        h('div', null, h('h1', null, '미로 게임 시뮬레이션 통계'), h('p', { class: 'lede' }, '정해진 전략대로 두는 가상 플레이어(봇)가 미로 베팅 게임을 여러 판 했을 때 어떤 일이 생기는지를, 판 하나하나의 기록에서 계산한 결과입니다.')),
        h('div', { class: 'theme', role: 'group', 'aria-label': '색 테마' }, themeButtons),
      ),
      h(
        'dl',
        { class: 'meta' },
        h('dt', null, '튜닝 표'),
        h('dd', null, STATS.tables.map(tableLine)),
        h('dt', null, '판 수'),
        h('dd', null, `플레이어 유형 × 미로 크기 조합마다 ${int(options.games)}판 (같은 크기에서는 모든 유형이 같은 미로를 플레이)`),
        h('dt', null, '시드'),
        h('dd', null, `${options.seed} — 인증용 미로 흐름 ${options.stream}의 ${int(options.firstGame)}번째 판부터. 인증이 쓴 판과 겹치지 않는 새 표본입니다.`),
        h('dt', null, '뱅크롤 세션'),
        h('dd', null, `${int(options.sessions)}명, 시작 ${int(options.bankroll)}베팅, 한 사람당 최대 ${int(options.sessionGameCap)}판`),
        h('dt', null, '실행'),
        h('dd', null, `${RUN.generatedAt} · ${fixed(RUN.seconds, 1)}초 · `, h('code', null, RUN.command)),
      ),
    );
  }

  const allChecks = STATS.tables.flatMap((entry) => entry.tiers.flatMap((tier) => tier.crossCheck));

  function crossCheckLine() {
    if (allChecks.length === 0) return '이 표와 코드에 대한 인증 기록이 없어 인증 결과와의 교차검증은 하지 못했습니다.';
    const agreeing = allChecks.filter((check) => check.agrees).length;
    const rest = allChecks.length - agreeing;
    return `인증 결과와의 교차검증: ${allChecks.length}개 조합 가운데 ${agreeing}개가 95% 범위 안에서 일치${rest === 0 ? '합니다.' : `하고 ${rest}개가 범위 밖입니다(맨 아래 "인증 결과와의 교차검증" 참고).`}`;
  }

  function noteSection() {
    const options = STATS.options;
    const memberName = (member) => nameOf(member === 'best' ? 'value-lsm' : member);
    const shares = STATS.assumptions.tierShare;
    const mixed = STATS.tables.some((entry) => entry.tiers.some((tier) => tier.cells.some((cell) => cell.player === 'mix')));
    const assumed = mixed
      ? [
          assumptionBadge(),
          ` 표시가 붙은 "가정한 플레이어 집단"과 "전체 하우스 몫"은 플레이어 구성(${Object.entries(STATS.assumptions.population).map(([member, weight]) => `${memberName(member)} ${pct(weight, 0)}`).join(', ')})과 ` +
            `크기별 이용 비율(작은 크기부터 ${shares.map((share) => pct(share, 0)).join(', ')})을 가정한 값입니다. 실제 플레이어 데이터가 아니며, 가정이 바뀌면 이 숫자도 바뀝니다. 나머지는 각 전략을 그대로 돌린 결과라 이 가정과 무관합니다.`,
        ]
      : '이 실행에는 가정에 기대는 숫자가 없습니다. 플레이어 구성을 가정해 섞은 "가정한 플레이어 집단"과 "전체 하우스 몫"은 모든 유형을 함께 돌렸을 때만 만들어집니다.';
    const missing = [];
    STATS.tables.forEach((entry, i) => {
      const where = (reason) => {
        const sizes = entry.tiers.filter((tier) => tier.unavailable.some((gap) => gap.reason === reason)).map(tierName);
        return sizes.length === 0 ? null : `${STATS.tables.length > 1 ? `${TABLE_TAGS[i]} 표 ` : ''}${sizes.join(', ')}`;
      };
      const noTable = where('no-value-table');
      const noMix = where('mix-needs-every-member');
      if (noTable) missing.push(`${noTable}: 최강 전략(value-lsm)은 학습된 가치표가 캐시에 없어 뺐습니다. 가치표는 인증을 돌릴 때 만들어지고, 새로 학습하면 오래 걸려 이 명령에서는 하지 않습니다.`);
      if (noMix) missing.push(`${noMix}: 집단을 이루는 유형 중 빠진 것이 있어 "가정한 플레이어 집단"을 만들지 못했습니다.`);
    });
    return h(
      'section',
      { class: 'card note' },
      h('h3', null, '읽기 전에'),
      h(
        'ul',
        null,
        h('li', null, h('strong', null, '표본 크기. '), `모든 숫자는 조합마다 ${int(options.games)}판을 돌린 표본에서 나왔고, 표본이 작을수록 흔들립니다. "95% 구간"이나 ±는 같은 실험을 되풀이하면 100번 중 95번쯤 참값이 들어가는 범위입니다. 판 수에 따른 오차는 "몇 판을 돌려야 믿을 수 있나"에 있습니다.`),
        h('li', null, h('strong', null, '가정에 기대는 숫자. '), assumed),
        h('li', null, h('strong', null, '플레이어 유형. '), '실제 사람이 아니라 항상 같은 규칙으로 움직이는 전략입니다. 실제 사람은 이 유형들 사이 어딘가에서 움직일 것입니다.'),
        h('li', null, h('strong', null, '뱅크롤 세션. '), '측정된 지급 분포에서 판을 하나씩 독립적으로 뽑아 이어 붙인 가상 플레이어입니다.'),
        h('li', null, crossCheckLine()),
        missing.map((text) => h('li', null, text)),
      ),
    );
  }

  const detail = h('section', null);
  const controls = h('div', { class: 'controls' });

  function segment(label, entries, current, choose) {
    return h(
      'div',
      { class: 'control' },
      h('span', null, label),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': label },
        entries.map((entry) => {
          const button = h(
            'button',
            { type: 'button', 'aria-pressed': String(entry.value === current), 'data-key': `${label}:${entry.value}` },
            entry.swatch ? h('span', { class: 'swatch', style: `background:${entry.swatch}` }) : null,
            entry.text,
          );
          button.addEventListener('click', () => choose(entry.value));
          return button;
        }),
      ),
    );
  }

  function render() {
    const entry = STATS.tables[state.table];
    state.tier = Math.min(state.tier, entry.tiers.length - 1);
    const tier = entry.tiers[state.tier];
    if (!tier.cells.some((cell) => cell.player === state.player)) state.player = (tier.cells.find((cell) => cell.player === 'naive-greedy') || tier.cells[0]).player;
    const cell = tier.cells.find((candidate) => candidate.player === state.player);
    const color = colorOf(cell.player);
    const choose = (key) => (value) => {
      state[key] = value;
      render();
    };

    // The buttons are rebuilt on every change, so the focused one is found again by its key.
    const focused = controls.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    controls.replaceChildren();
    fill(controls, null, [
      STATS.tables.length > 1 ? segment('튜닝 표', STATS.tables.map((candidate, i) => ({ value: i, text: `${TABLE_TAGS[i]} · ${candidate.path.split('/').pop()}` })), state.table, choose('table')) : null,
      segment('미로 크기', entry.tiers.map((candidate, i) => ({ value: i, text: `${tierName(candidate)} · 출구 ${times(candidate.multiplier)}` })), state.tier, choose('tier')),
      segment('플레이어 유형', tier.cells.map((candidate) => ({ value: candidate.player, text: nameOf(candidate.player), swatch: colorOf(candidate.player) })), state.player, choose('player')),
    ]);
    if (focused) for (const button of controls.querySelectorAll('button')) if (button.dataset.key === focused) button.focus();

    const info = players.get(cell.player);
    detail.replaceChildren();
    fill(detail, null, [
      h(
        'div',
        { class: 'selection' },
        h('h2', null, `${tierName(tier)} · ${info.name} · ${int(cell.games)}판`),
        h(
          'p',
          { class: 'who' },
          info.assumption ? [assumptionBadge(), ' '] : null,
          `${info.description} (전략 이름 ${info.id}) · 이 크기의 최단 경로 ${tier.shortestPath}걸음, 출구 배당 ${fixed(tier.multiplier, 4)}배, 걷기 전 캐시아웃 환급 ${times(tier.refund[0])}.`,
        ),
      ),
      tiles(cell),
      h('div', { class: 'grid' }, endStepFigure(cell, color), payoutFigure(cell, color), convergenceFigure(cell, color), profitFigure(cell, color), streakFigure(cell, color), sessionFigure(cell, color)),
    ]);
  }

  /** Bars of the return per player type for one tier position; with two tables each row has two bars. */
  function comparisonChart(tierIndex) {
    const tiers = STATS.tables.map((entry) => entry.tiers[tierIndex]).filter(Boolean);
    const ids = STATS.players.map((player) => player.id).filter((id) => tiers.some((tier) => tier.cells.some((cell) => cell.player === id)));
    const perRow = tiers.length;
    const barHeight = 10;
    const rowHeight = perRow * (barHeight + 3) + 11;
    const width = 400;
    const height = 30 + ids.length * rowHeight + 34;
    const svg = chartRoot(width, height, `${tierName(tiers[0])} 플레이어 유형별 환수율`);
    const box = { x0: 138, x1: width - 52, y0: 30, y1: height - 34 };
    const top = Math.max(1, ...tiers.flatMap((tier) => tier.cells.map((cell) => cell.rtp.ci95[1])));
    const axis = niceAxis(0, top, 4);
    const sx = (v) => box.x0 + (v / axis.hi) * (box.x1 - box.x0);
    for (const tick of axis.ticks) {
      svg.append(s('line', { class: tick === 0 ? 'baseline' : 'gridline', x1: sx(tick), x2: sx(tick), y1: box.y0, y2: box.y1 }));
      svg.append(s('text', { x: sx(tick), y: box.y1 + 15, 'text-anchor': 'middle' }, pct(tick, 0)));
    }
    svg.append(s('text', { class: 'axis-title', x: (box.x0 + box.x1) / 2, y: height - 4, 'text-anchor': 'middle' }, '환수율 RTP (%)'));
    svg.append(s('line', { class: 'reference', x1: sx(1), x2: sx(1), y1: box.y0 - 4, y2: box.y1 }));
    svg.append(s('text', { x: sx(1), y: box.y0 - 8, 'text-anchor': 'middle' }, '손익분기'));
    const marks = s('g', null);
    const hits = s('g', null);
    ids.forEach((id, row) => {
      const y = box.y0 + row * rowHeight + 6;
      svg.append(s('text', { class: 'row-label', x: box.x0 - (perRow > 1 ? 22 : 8), y: y + (rowHeight - 11) / 2 + 3, 'text-anchor': 'end' }, nameOf(id)));
      const group = s('g', { class: 'mark' });
      const rows = [];
      tiers.forEach((tier, t) => {
        const cell = tier.cells.find((candidate) => candidate.player === id);
        if (!cell) return;
        const tag = perRow > 1 ? `${TABLE_TAGS[t]} · ` : '';
        const barY = y + t * (barHeight + 3);
        const mid = barY + barHeight / 2;
        const lo = Math.max(0, cell.rtp.ci95[0]);
        const hi = cell.rtp.ci95[1];
        if (perRow > 1) svg.append(s('text', { x: box.x0 - 6, y: barY + 9, 'text-anchor': 'end' }, TABLE_TAGS[t]));
        group.append(s('path', { d: rowPath(box.x0, barY, Math.max(0, sx(cell.rtp.mean) - box.x0), barHeight), fill: colorOf(id), opacity: t === 0 ? 1 : 0.55 }));
        group.append(s('path', { d: `M${sx(lo)},${mid}H${sx(hi)}M${sx(lo)},${mid - 3}v6M${sx(hi)},${mid - 3}v6`, stroke: 'var(--text-primary)', 'stroke-width': 1.25, fill: 'none' }));
        svg.append(s('text', { class: 'label', x: sx(Math.max(cell.rtp.mean, hi)) + 8, y: barY + 9 }, pct(cell.rtp.mean, 1)));
        rows.push({ name: `${tag}환수율`, value: `${pct(cell.rtp.mean, 2)} ±${pctPoints(cell.rtp.halfWidth, 2)}` }, { name: `${tag}하우스 몫`, value: pct(cell.houseHold.value, 2) });
      });
      marks.append(group);
      const hit = s('rect', { class: 'hit', x: 0, y: y - 5, width, height: rowHeight });
      hit.addEventListener('pointermove', (event) => {
        marks.classList.add('dim');
        group.classList.add('on');
        showTip(event, `${tierName(tiers[0])} · ${nameOf(id)}`, rows);
      });
      hit.addEventListener('pointerleave', () => {
        marks.classList.remove('dim');
        group.classList.remove('on');
        hideTip();
      });
      hits.append(hit);
    });
    svg.append(marks, hits);
    const title = tiers.map((tier, t) => `${perRow > 1 ? `${TABLE_TAGS[t]} ` : ''}${tierName(tier)} · 출구 ${times(tier.multiplier)}`).join('  /  ');
    return h('div', { class: 'panel' }, h('h4', null, title), svg);
  }

  function comparisonSection() {
    const tierCount = Math.max(...STATS.tables.map((entry) => entry.tiers.length));
    const two = STATS.tables.length > 1;
    const headers = ['유형', '출구 도착', '막다른 길', '캐시아웃', '환수율 (RTP)', '95% 오차', '하우스 몫', '표준편차', '최장 연패', '세션 중앙값'];
    const rows = [];
    STATS.tables.forEach((entry, i) => {
      for (const tier of entry.tiers) {
        rows.push({ group: `${two ? `${TABLE_TAGS[i]} 표 · ` : ''}${tierName(tier)} · 출구 ${fixed(tier.multiplier, 4)}배` });
        for (const cell of tier.cells) {
          rows.push([
            playerCell(cell.player),
            pct(cell.rates.exit, 2),
            pct(cell.rates.deadEnd, 2),
            pct(cell.rates.cashOut, 2),
            pct(cell.rtp.mean, 2),
            `±${pctPoints(cell.rtp.halfWidth, 2)}`,
            pct(cell.houseHold.value, 2),
            times(cell.rtp.sd),
            `${int(cell.streaks.longest)}판`,
            cell.sessions ? (cell.sessions.medianCapped ? `${int(cell.sessions.gameCap)}판 이상` : `${int(cell.sessions.gamesPlayed.median)}판`) : '–',
          ]);
        }
      }
    });
    const overall = STATS.tables
      .map((entry, i) => (entry.population ? `${two ? `${TABLE_TAGS[i]} 표 ` : ''}${pct(entry.population.houseHold, 2)} ±${pctPoints(1.96 * entry.population.se, 2)}` : null))
      .filter(Boolean);
    const differences = [];
    if (two) {
      const [first, second] = STATS.tables;
      first.tiers.forEach((tier, t) => {
        const other = second.tiers[t];
        if (!other) return;
        differences.push({ group: `${tierName(tier)} (A) ↔ ${tierName(other)} (B)` });
        for (const cell of tier.cells) {
          const match = other.cells.find((candidate) => candidate.player === cell.player);
          if (!match) continue;
          const difference = match.rtp.mean - cell.rtp.mean;
          differences.push([
            playerCell(cell.player),
            pct(cell.rtp.mean, 2),
            pct(match.rtp.mean, 2),
            `${difference >= 0 ? '+' : '−'}${pctPoints(Math.abs(difference), 2)}`,
            pct(cell.houseHold.value, 2),
            pct(match.houseHold.value, 2),
          ]);
        }
      });
    }
    return h(
      'section',
      null,
      h('h2', null, '전체 비교'),
      h(
        'p',
        { class: 'section-note' },
        `위에서 고른 조합과 상관없이, 모든 플레이어 유형과 미로 크기의 환수율을 한눈에 봅니다. 막대가 손익분기(100%)에 가까울수록 플레이어에게 유리하고, 100%까지 남은 거리가 하우스 몫입니다. 막대 끝의 가는 선은 95% 신뢰구간입니다.${two ? ' 유형마다 위 막대가 A 표, 흐린 아래 막대가 B 표입니다.' : ''}`,
      ),
      h(
        'figure',
        { class: 'card' },
        two ? legend(STATS.tables.map((entry, i) => ({ key: 'box', color: i === 0 ? 'var(--text-secondary)' : 'var(--axis)', text: `${TABLE_TAGS[i]} = ${entry.path}` }))) : null,
        h('div', { class: 'panels three' }, Array.from({ length: tierCount }, (_, t) => comparisonChart(t))),
        overall.length > 0 ? facts(assumptionBadge(), ' 전체 하우스 몫 (가정한 집단 구성과 크기별 이용 비율로 가중): ', b(overall.join(' / ')), ' — 튜닝 보고서의 H와 같은 정의입니다.') : null,
        table(headers, rows),
        two
          ? h(
              'div',
              null,
              h('h4', { style: 'margin-top:16px' }, '두 표의 환수율 차이 (B − A, 크기가 같은 칸은 같은 미로에서 플레이)'),
              table(['유형', 'A 환수율', 'B 환수율', '차이 (B − A)', 'A 하우스 몫', 'B 하우스 몫'], differences),
            )
          : null,
      ),
    );
  }

  function crossCheckSection() {
    if (allChecks.length === 0) return null;
    const two = STATS.tables.length > 1;
    const rows = [];
    STATS.tables.forEach((entry, i) => {
      for (const tier of entry.tiers) {
        if (tier.crossCheck.length === 0) continue;
        rows.push({ group: `${two ? `${TABLE_TAGS[i]} 표 · ` : ''}${tierName(tier)}` });
        for (const check of tier.crossCheck) {
          rows.push([
            playerCell(check.player),
            pct(check.rtp, 2),
            `${pct(check.certifiedRtp, 2)} (${int(check.certifiedGames)}판)`,
            `${check.difference >= 0 ? '+' : '−'}${pctPoints(Math.abs(check.difference), 2)}`,
            `±${pctPoints(check.halfWidth, 2)}`,
            `${check.z >= 0 ? '+' : '−'}${fixed(Math.abs(check.z), 2)}`,
            h('span', { class: check.agrees ? 'status-good' : 'status-bad' }, check.agrees ? '✓ 일치' : '⚠ 범위 밖'),
          ]);
        }
      }
    });
    return h(
      'section',
      null,
      h('h2', null, '인증 결과와의 교차검증'),
      h(
        'p',
        { class: 'section-note' },
        '같은 전략을 인증(수백만 판, 이 실행과 겹치지 않는 미로)에서 돌린 환수율과 이 실행의 환수율이 통계적으로 같은지 확인합니다. 차이가 허용 범위(두 추정의 오차를 합친 95% 범위. 한 판의 흔들림 크기는 판 수가 훨씬 많은 인증 쪽 값을 씁니다) 안이면 "일치"입니다. 우연만으로도 20개 조합 중 1개쯤은 범위를 벗어날 수 있으니, 벗어난 조합이 있으면 시드를 바꿔 다시 돌려 보세요. 여러 시드에서 같은 조합이 계속 벗어나면 엔진을 잘못 쓰고 있다는 신호입니다.',
      ),
      h('div', { class: 'card' }, table(['유형', '이 실행', '인증', '차이', '허용 범위', 'z', '판정'], rows)),
    );
  }

  function runSection() {
    const two = STATS.tables.length > 1;
    const rows = RUN.timings.map((timing) => [
      `${two ? `${timing.role === 'main' ? 'A' : 'B'} · ` : ''}${timing.n}×${timing.n}`,
      nameOf(timing.player),
      int(timing.games),
      fixed(timing.seconds, 2),
      int(timing.games / Math.max(timing.seconds, 1e-9)),
    ]);
    return h(
      'section',
      null,
      h('h2', null, '실행 정보'),
      h(
        'p',
        { class: 'section-note' },
        `시뮬레이터 코드 해시 ${STATS.simCodeHash.slice(0, 12)}… · 워커 스레드 ${RUN.workers === 0 ? '없음 (한 스레드)' : `${RUN.workers}개`} · 속도는 그 조합의 판을 플레이하는 데 걸린 실제 시간으로 나눈 값입니다.`,
      ),
      h('div', { class: 'card' }, h('details', null, h('summary', null, '조합별 걸린 시간과 속도'), table(['크기', '유형', '판 수', '걸린 시간 (초)', '속도 (판/초)'], rows))),
    );
  }

  function setTheme(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    for (const button of document.querySelectorAll('.theme button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }

  /** `#dark&table=1&tier=2&player=nervous` opens the page on that selection; every part is optional. */
  function readHash() {
    let theme = 'auto';
    for (const part of window.location.hash.slice(1).split('&')) {
      const [key, value] = part.split('=');
      if (key === 'dark' || key === 'light') theme = key;
      else if (key === 'table' && Number(value) >= 0 && Number(value) < STATS.tables.length) state.table = Number(value);
      else if (key === 'tier' && Number(value) >= 0) state.tier = Number(value);
      else if (key === 'player' && players.has(value)) state.player = value;
    }
    return theme;
  }

  try {
    const theme = readHash();
    fill(app, null, [h('div', { class: 'wrap' }, headerSection(), noteSection(), controls, detail, comparisonSection(), crossCheckSection(), runSection()), tip]);
    setTheme(theme);
    render();
  } catch (error) {
    app.append(h('div', { class: 'wrap' }, h('div', { class: 'error' }, `보고서를 그리는 중 오류가 났습니다: ${error && error.stack ? error.stack : error}`)));
  }
})();
